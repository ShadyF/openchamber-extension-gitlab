import { describe, expect, it } from 'bun:test';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { HostRequestError } from '@openchamber/sdk';
import { getCurrentUser, getProjectById, GitLabApiError, gitLabErrorMessage, GITLAB_VARIANT_ID, searchVisibleProjects, type GitLabErrorCode, type GitLabHost } from '../src/gitlab.js';

// Queue test responses so every GitLab request stays inside the host bridge seam.
function createHost(responses: Array<GuestRequestResult | Error>) {
  const requests: GuestRequest[] = [];
  const host: GitLabHost = {
    async request(request) {
      requests.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error('No mock response remains.');
      return response;
    },
  };

  return { host, requests };
}

function jsonResponse(status: number, value: unknown): GuestRequestResult {
  return { status, body: JSON.stringify(value) };
}

// Check the safe API boundary from account verification through project refresh and error handling.
describe('GitLab API adapter', () => {
  // Verify that account identity is numeric and instance scope stays fixed to this extension.
  it('verifies the account and uses the fixed panel identity as its variant', async () => {
    const { host, requests } = createHost([
      jsonResponse(200, { id: 73, username: 'maya', web_url: 'http://untrusted.example/users/maya' }),
    ]);
    const withoutProfileUrl = createHost([jsonResponse(200, { id: 73, username: 'maya' })]);

    await expect(getCurrentUser(host)).resolves.toEqual({ id: 73, username: 'maya', variant: GITLAB_VARIANT_ID });
    await expect(getCurrentUser(withoutProfileUrl.host)).resolves.toEqual({ id: 73, username: 'maya', variant: GITLAB_VARIANT_ID });
    expect(requests).toEqual([{ method: 'GET', path: '/api/v4/user' }]);
  });

  // Reject account data that cannot provide a stable numeric identity.
  it('rejects non-numeric IDs and empty usernames without relying on profile URLs', async () => {
    const stringId = createHost([jsonResponse(200, { id: '73', username: 'maya' })]);
    const emptyUsername = createHost([jsonResponse(200, { id: 73, username: '   ' })]);

    await expect(getCurrentUser(stringId.host)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(getCurrentUser(emptyUsername.host)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  // Check that user-visible searches retain GitLab's full namespace.
  it('searches accessible projects and keeps their full namespace and numeric IDs', async () => {
    const { host, requests } = createHost([
      jsonResponse(200, [{ id: 812, path_with_namespace: 'platform/infra/deploy' }]),
    ]);

    await expect(searchVisibleProjects(host, ' deploy ')).resolves.toEqual([{ id: 812, path: 'platform/infra/deploy' }]);
    expect(requests[0]).toEqual({
      method: 'GET',
      path: '/api/v4/projects',
      query: { search: 'deploy', per_page: '100', page: '1', order_by: 'name', sort: 'asc' },
    });
  });

  // Refuse malformed search results rather than rendering unsafe project choices.
  it('rejects malformed or duplicate search IDs instead of making them selectable', async () => {
    const malformed = createHost([jsonResponse(200, [{ id: '812', path_with_namespace: 'platform/deploy' }])]);
    const duplicate = createHost([jsonResponse(200, [
      { id: 812, path_with_namespace: 'platform/deploy' },
      { id: 812, path_with_namespace: 'other/deploy' },
    ])]);

    await expect(searchVisibleProjects(malformed.host, 'deploy')).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(searchVisibleProjects(duplicate.host, 'deploy')).rejects.toMatchObject({ code: 'invalid-response' });
  });

  // Ensure the selected numeric ID is fetched again before the controller saves it.
  it('re-fetches a selected project by stable numeric ID', async () => {
    const { host, requests } = createHost([
      jsonResponse(200, { id: 812, path_with_namespace: 'platform/infra/deploy' }),
    ]);

    await expect(getProjectById(host, 812)).resolves.toEqual({ id: 812, path: 'platform/infra/deploy' });
    expect(requests[0]).toEqual({ method: 'GET', path: '/api/v4/projects/812' });
  });

  // Reject a response whose project ID no longer matches the requested selection.
  it('rejects a project endpoint response that changes the stable ID', async () => {
    const { host } = createHost([jsonResponse(200, { id: 813, path_with_namespace: 'platform/infra/deploy' })]);

    await expect(getProjectById(host, 812)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  // Confirm failures are mapped to clear messages without returning sensitive details.
  it('turns redirects, transport, TLS, and token failures into safe recovery messages', async () => {
    const cases: Array<{ error: Error | GuestRequestResult; code: GitLabErrorCode; text: string }> = [
      { error: jsonResponse(302, {}), code: 'redirect', text: 'redirects are not followed' },
      { error: new HostRequestError('BAD_PATH', 'raw host details'), code: 'invalid-origin', text: 'configured GitLab API origin' },
      { error: new Error('certificate rejected with secret contents'), code: 'transport', text: 'trusted TLS certificate' },
      { error: jsonResponse(401, {}), code: 'disconnected', text: 'rejected the token' },
      { error: jsonResponse(403, {}), code: 'forbidden', text: 'denied this request' },
      { error: jsonResponse(404, {}), code: 'not-found', text: 'current-user API' },
    ];

    for (const item of cases) {
      const { host } = createHost([item.error]);
      let caught: unknown;
      try {
        await getCurrentUser(host);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitLabApiError);
      expect((caught as GitLabApiError).code).toBe(item.code);
      expect(gitLabErrorMessage(caught)).toContain(item.text);
      expect(gitLabErrorMessage(caught)).not.toContain('origin in Settings → Integrations');
      expect(gitLabErrorMessage(caught)).not.toContain('secret contents');
    }
  });

  // Avoid broad project requests while the search field is empty.
  it('does not request projects for an empty search', async () => {
    const { host, requests } = createHost([]);

    await expect(searchVisibleProjects(host, '   ')).resolves.toEqual([]);
    expect(requests).toEqual([]);
  });
});
