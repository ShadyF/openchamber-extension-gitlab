import { describe, expect, it } from 'bun:test';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { HostRequestError } from '@openchamber/sdk';
import { getCurrentUser, getProjectById, getProjectIssue, getProjectMergeRequest, GitLabApiError, gitLabErrorMessage, GITLAB_VARIANT_ID, listMergeRequestDiscussions, listMergeRequestPipelines, listPipelineJobs, listProjectIssues, listProjectMergeRequests, listRelatedMergeRequestsPage, searchVisibleProjects, type GitLabErrorCode, type GitLabHost } from '../src/gitlab.js';

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

function issue(overrides: Record<string, unknown> = {}) {
  return {
    id: 901,
    iid: 17,
    project_id: 812,
    title: 'Fix deployment flow',
    description: 'Details for the issue',
    state: 'opened',
    web_url: 'https://gitlab.example/platform/deploy/-/issues/17',
    updated_at: '2026-09-20T12:30:00.000Z',
    ...overrides,
  };
}

// Build a complete project merge request response with overridable provider fields.
function mergeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 1901,
    iid: 27,
    project_id: 812,
    target_project_id: 812,
    source_project_id: 913,
    title: 'Merge deployment update',
    description: 'Merge request details',
    state: 'opened',
    web_url: 'https://gitlab.example/platform/deploy/-/merge_requests/27',
    updated_at: '2026-09-21T12:30:00.000Z',
    source_branch: 'feature/deploy',
    target_branch: 'main',
    ...overrides,
  };
}

// Build representative GitLab pipeline data, including its owning project ID.
function pipeline(overrides: Record<string, unknown> = {}) {
  return {
    id: 4501,
    project_id: 913,
    status: 'success',
    ref: 'feature/deploy',
    sha: '0123456789abcdef',
    source: 'merge_request_event',
    created_at: '2026-09-21T12:30:00.000Z',
    updated_at: '2026-09-21T12:35:00.000Z',
    started_at: '2026-09-21T12:31:00.000Z',
    finished_at: '2026-09-21T12:35:00.000Z',
    web_url: 'https://gitlab.example/platform/fork/-/pipelines/4501',
    ...overrides,
  };
}

// Build a job with its required display identity and optional links.
function pipelineJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 5701,
    name: 'unit tests',
    status: 'success',
    stage: 'test',
    created_at: '2026-09-21T12:31:00.000Z',
    started_at: '2026-09-21T12:32:00.000Z',
    finished_at: '2026-09-21T12:34:00.000Z',
    web_url: 'https://gitlab.example/platform/fork/-/jobs/5701',
    ...overrides,
  };
}

// Build a discussion thread with one plain-text note and nullable metadata.
function discussion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'discussion-4501',
    notes: [{
      id: 6701,
      body: 'Looks good to me.',
      author: { id: 73, username: 'maya', name: 'Maya' },
      created_at: '2026-09-21T12:31:00.000Z',
      updated_at: '2026-09-21T12:31:00.000Z',
      system: false,
      resolvable: true,
      resolved: false,
      resolved_by: null,
      resolved_at: null,
    }],
    ...overrides,
  };
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

  // Request a sorted, bounded page and normalize valid issue data for callers.
  it('lists project issues with pagination and an optional trimmed search', async () => {
    const { host, requests } = createHost([jsonResponse(200, [issue({ description: null })])]);

    await expect(listProjectIssues(host, 812, 3, ' deploy ')).resolves.toEqual([{
      id: 901,
      iid: 17,
      projectId: 812,
      title: 'Fix deployment flow',
      description: '',
      state: 'opened',
      webUrl: 'https://gitlab.example/platform/deploy/-/issues/17',
      updatedAt: '2026-09-20T12:30:00.000Z',
    }]);
    expect(requests[0]).toEqual({
      method: 'GET',
      path: '/api/v4/projects/812/issues',
      query: { state: 'opened', per_page: '20', page: '3', order_by: 'updated_at', sort: 'desc', search: 'deploy' },
    });
  });

  // Keep default paging bounded and skip the search parameter when it is blank.
  it('lists an empty first page without adding a blank search', async () => {
    const { host, requests } = createHost([jsonResponse(200, [])]);

    await expect(listProjectIssues(host, 812, undefined, '  ')).resolves.toEqual([]);
    expect(requests[0]).toEqual({
      method: 'GET',
      path: '/api/v4/projects/812/issues',
      query: { state: 'opened', per_page: '20', page: '1', order_by: 'updated_at', sort: 'desc' },
    });
  });

  // Refresh issue details only when the response still identifies the requested project issue.
  it('gets one issue by project-local IID', async () => {
    const { host, requests } = createHost([jsonResponse(200, issue())]);

    await expect(getProjectIssue(host, 812, 17)).resolves.toEqual({
      id: 901,
      iid: 17,
      projectId: 812,
      title: 'Fix deployment flow',
      description: 'Details for the issue',
      state: 'opened',
      webUrl: 'https://gitlab.example/platform/deploy/-/issues/17',
      updatedAt: '2026-09-20T12:30:00.000Z',
    });
    expect(requests[0]).toEqual({ method: 'GET', path: '/api/v4/projects/812/issues/17' });
  });

  // Reject malformed fields, mismatched identities, and duplicate provider IDs.
  it('rejects malformed issue rows and duplicate IDs or IIDs', async () => {
    const malformedRows = [
      issue({ id: '901' }),
      issue({ iid: 0 }),
      issue({ project_id: 813 }),
      issue({ title: '  ' }),
      issue({ state: 'locked' }),
      issue({ updated_at: '' }),
      issue({ web_url: 'http://gitlab.example/issues/17' }),
      issue({ web_url: 'https://user:password@gitlab.example/issues/17' }),
      issue({ description: 5 }),
    ];
    for (const row of malformedRows) {
      await expect(listProjectIssues(createHost([jsonResponse(200, [row])]).host, 812)).rejects.toMatchObject({ code: 'invalid-response' });
    }

    await expect(listProjectIssues(createHost([jsonResponse(200, [issue(), issue({ iid: 18 })])]).host, 812))
      .rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listProjectIssues(createHost([jsonResponse(200, [issue(), issue({ id: 902 })])]).host, 812))
      .rejects.toMatchObject({ code: 'invalid-response' });
    await expect(getProjectIssue(createHost([jsonResponse(200, issue({ iid: 18 }))]).host, 812, 17))
      .rejects.toMatchObject({ code: 'invalid-response' });
  });

  // Reject invalid caller paging and IDs before making an API request.
  it('rejects issue requests with invalid IDs or an out-of-range page', async () => {
    const { host, requests } = createHost([]);

    await expect(listProjectIssues(host, 812, 0)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listProjectIssues(host, 812, 1001)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(getProjectIssue(host, 812, 0)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(requests).toEqual([]);
  });

  // Keep issue endpoint failures safe and distinguish rate limits from other server errors.
  it('maps issue authorization, missing, rate-limit, and host failures safely', async () => {
    const cases: Array<{ error: Error | GuestRequestResult; code: GitLabErrorCode; text: string }> = [
      { error: jsonResponse(401, { message: 'private response' }), code: 'disconnected', text: 'rejected the token' },
      { error: jsonResponse(403, { message: 'private response' }), code: 'forbidden', text: 'denied this request' },
      { error: jsonResponse(404, { message: 'private response' }), code: 'not-found', text: 'project issues' },
      { error: jsonResponse(429, { message: 'private response' }), code: 'rate-limited', text: 'rate-limiting' },
      { error: new Error('host secret'), code: 'transport', text: 'trusted TLS certificate' },
    ];

    for (const item of cases) {
      const { host } = createHost([item.error]);
      let caught: unknown;
      try {
        await listProjectIssues(host, 812);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitLabApiError);
      expect((caught as GitLabApiError).code).toBe(item.code);
      expect((caught as GitLabApiError).resource).toBe('issues');
      expect(gitLabErrorMessage(caught)).toContain(item.text);
      expect(gitLabErrorMessage(caught)).not.toContain('private response');
      expect(gitLabErrorMessage(caught)).not.toContain('host secret');
    }
  });

  // List merge requests with bounded paging and a trimmed optional search term.
  it('lists project merge requests using the requested query and accepts fork sources', async () => {
    const { host, requests } = createHost([jsonResponse(200, [mergeRequest()])]);

    await expect(listProjectMergeRequests(host, 812, 4, ' deploy ')).resolves.toEqual([{
      id: 1901,
      iid: 27,
      projectId: 812,
      targetProjectId: 812,
      sourceProjectId: 913,
      title: 'Merge deployment update',
      description: 'Merge request details',
      state: 'opened',
      webUrl: 'https://gitlab.example/platform/deploy/-/merge_requests/27',
      updatedAt: '2026-09-21T12:30:00.000Z',
      sourceBranch: 'feature/deploy',
      targetBranch: 'main',
    }]);
    expect(requests[0]).toEqual({
      method: 'GET',
      path: '/api/v4/projects/812/merge_requests',
      query: { state: 'opened', order_by: 'updated_at', sort: 'desc', per_page: '20', page: '4', search: 'deploy' },
    });
  });

  // Omit blank search and tolerate older responses without optional display fields.
  it('lists merge requests without a blank search and normalizes absent nullable fields', async () => {
    const { host, requests } = createHost([jsonResponse(200, [mergeRequest({
      target_project_id: undefined,
      source_project_id: undefined,
      source_branch: undefined,
      target_branch: undefined,
      description: null,
    })])]);

    await expect(listProjectMergeRequests(host, 812, undefined, '  ')).resolves.toMatchObject([{
      projectId: 812,
      targetProjectId: 812,
      sourceProjectId: null,
      description: '',
      sourceBranch: null,
      targetBranch: null,
    }]);
    expect(requests[0]).toEqual({
      method: 'GET',
      path: '/api/v4/projects/812/merge_requests',
      query: { state: 'opened', order_by: 'updated_at', sort: 'desc', per_page: '20', page: '1' },
    });
  });

  // Refresh merge request details by project-local IID and reject a mismatched response.
  it('gets one project merge request by IID', async () => {
    const { host, requests } = createHost([jsonResponse(200, mergeRequest())]);

    await expect(getProjectMergeRequest(host, 812, 27)).resolves.toMatchObject({ id: 1901, iid: 27, sourceProjectId: 913 });
    expect(requests[0]).toEqual({ method: 'GET', path: '/api/v4/projects/812/merge_requests/27' });
    await expect(getProjectMergeRequest(createHost([jsonResponse(200, mergeRequest({ iid: 28 }))]).host, 812, 27))
      .rejects.toMatchObject({ code: 'invalid-response', resource: 'merge-requests' });
  });

  // Reject malformed identities, mismatched targets, unsafe links, and duplicate page IDs.
  it('rejects malformed, mismatched, duplicate, or unsafe merge request rows', async () => {
    const malformedRows = [
      mergeRequest({ id: '1901' }),
      mergeRequest({ iid: 0 }),
      mergeRequest({ project_id: 813 }),
      mergeRequest({ target_project_id: 813 }),
      mergeRequest({ source_project_id: '913' }),
      mergeRequest({ title: '  ' }),
      mergeRequest({ state: 'unknown' }),
      mergeRequest({ updated_at: '' }),
      mergeRequest({ web_url: 'http://gitlab.example/mr/27' }),
      mergeRequest({ web_url: 'https://user:password@gitlab.example/mr/27' }),
      mergeRequest({ description: 5 }),
    ];
    for (const row of malformedRows) {
      await expect(listProjectMergeRequests(createHost([jsonResponse(200, [row])]).host, 812))
        .rejects.toMatchObject({ code: 'invalid-response', resource: 'merge-requests' });
    }

    await expect(listProjectMergeRequests(createHost([jsonResponse(200, [mergeRequest(), mergeRequest({ iid: 28 })])]).host, 812))
      .rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listProjectMergeRequests(createHost([jsonResponse(200, [mergeRequest(), mergeRequest({ id: 1902 })])]).host, 812))
      .rejects.toMatchObject({ code: 'invalid-response' });
  });

  // Reject out-of-range pages before making the API request and keep API errors private.
  it('bounds merge request paging and maps not-found errors without provider details', async () => {
    const invalid = createHost([]);
    await expect(listProjectMergeRequests(invalid.host, 812, 0)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listProjectMergeRequests(invalid.host, 812, 1001)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(invalid.requests).toEqual([]);

    const { host } = createHost([jsonResponse(404, { message: 'private host response' })]);
    let caught: unknown;
    try {
      await listProjectMergeRequests(host, 812);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'not-found', resource: 'merge-requests' });
    expect(gitLabErrorMessage(caught)).toContain('project merge requests');
    expect(gitLabErrorMessage(caught)).not.toContain('private host response');
  });

  // Fetch a bounded related page and retain target projects outside the issue project.
  it('lists issue-related merge requests from cross-project targets and fork sources', async () => {
    const { host, requests } = createHost([jsonResponse(200, [
      mergeRequest({ project_id: 812, target_project_id: 812 }),
      mergeRequest({
        id: 2901,
        iid: 37,
        project_id: 945,
        target_project_id: 945,
        source_project_id: 946,
        state: 'merged',
        web_url: 'https://gitlab.example/another/project/-/merge_requests/37',
      }),
      mergeRequest({ id: 2902, iid: 38, state: 'closed' }),
      mergeRequest({ id: 2903, iid: 39, state: 'locked' }),
    ])]);

    await expect(listRelatedMergeRequestsPage(host, 812, 17, 2)).resolves.toMatchObject([
      { id: 1901, iid: 27, projectId: 812, targetProjectId: 812, sourceProjectId: 913, state: 'opened' },
      { id: 2901, iid: 37, projectId: 945, targetProjectId: 945, sourceProjectId: 946, state: 'merged' },
      { id: 2902, iid: 38, state: 'closed' },
      { id: 2903, iid: 39, state: 'locked' },
    ]);
    expect(requests[0]).toEqual({
      method: 'GET',
      path: '/api/v4/projects/812/issues/17/related_merge_requests',
      query: { page: '2', per_page: '50' },
    });
  });

  // Treat empty pages as valid while rejecting malformed rows and oversized provider results as a whole.
  it('accepts an empty related page and rejects malformed or oversized pages', async () => {
    await expect(listRelatedMergeRequestsPage(createHost([jsonResponse(200, [])]).host, 812, 17, 1)).resolves.toEqual([]);

    const malformedRows = [
      mergeRequest({ id: Number.MAX_SAFE_INTEGER + 1 }),
      mergeRequest({ iid: 0 }),
      mergeRequest({ project_id: 945, target_project_id: 812 }),
      mergeRequest({ target_project_id: undefined }),
      mergeRequest({ state: 'unknown' }),
      mergeRequest({ web_url: 'https://user:password@gitlab.example/mr/27' }),
      mergeRequest({ web_url: 'http://gitlab.example/mr/27' }),
    ];
    for (const row of malformedRows) {
      await expect(listRelatedMergeRequestsPage(createHost([jsonResponse(200, [row])]).host, 812, 17, 1))
        .rejects.toMatchObject({ code: 'invalid-response', resource: 'merge-requests' });
    }

    await expect(listRelatedMergeRequestsPage(createHost([jsonResponse(200, Array.from({ length: 51 }, () => mergeRequest()))]).host, 812, 17, 1))
      .rejects.toMatchObject({ code: 'invalid-response', resource: 'merge-requests' });
  });

  // Reject invalid resource identities and pages before contacting GitLab.
  it('rejects invalid related request IDs or page bounds without making a request', async () => {
    const { host, requests } = createHost([]);

    await expect(listRelatedMergeRequestsPage(host, 0, 17, 1)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listRelatedMergeRequestsPage(host, 812, Number.MAX_SAFE_INTEGER + 1, 1)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listRelatedMergeRequestsPage(host, 812, 17, 0)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listRelatedMergeRequestsPage(host, 812, 17, 11)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(requests).toEqual([]);
  });

  // Preserve safe status mapping for denied, missing, limited, and transport failures.
  it('maps related merge request failures safely instead of returning an empty page', async () => {
    const cases: Array<{ error: Error | GuestRequestResult; code: GitLabErrorCode }> = [
      { error: jsonResponse(401, { message: 'private response' }), code: 'disconnected' },
      { error: jsonResponse(403, { message: 'private response' }), code: 'forbidden' },
      { error: jsonResponse(404, { message: 'private response' }), code: 'not-found' },
      { error: jsonResponse(429, { message: 'private response' }), code: 'rate-limited' },
      { error: new Error('private transport details'), code: 'transport' },
    ];

    for (const item of cases) {
      await expect(listRelatedMergeRequestsPage(createHost([item.error]).host, 812, 17, 1))
        .rejects.toMatchObject({ code: item.code, resource: 'merge-requests' });
    }
  });

  // Keep pipeline and job requests scoped to the numeric project identities supplied by GitLab.
  it('loads target-project pipelines and uses the pipeline owner for jobs', async () => {
    const { host, requests } = createHost([
      jsonResponse(200, [pipeline()]),
      jsonResponse(200, [pipelineJob()]),
    ]);
    const pipelines = await listMergeRequestPipelines(host, 812, 27, 2);
    expect(pipelines).toEqual([{
      id: 4501,
      projectId: 913,
      status: 'success',
      ref: 'feature/deploy',
      sha: '0123456789abcdef',
      source: 'merge_request_event',
      createdAt: '2026-09-21T12:30:00.000Z',
      updatedAt: '2026-09-21T12:35:00.000Z',
      startedAt: '2026-09-21T12:31:00.000Z',
      finishedAt: '2026-09-21T12:35:00.000Z',
      webUrl: 'https://gitlab.example/platform/fork/-/pipelines/4501',
    }]);
    await expect(listPipelineJobs(host, pipelines[0].projectId!, pipelines[0].id)).resolves.toEqual([{
      id: 5701,
      name: 'unit tests',
      status: 'success',
      stage: 'test',
      createdAt: '2026-09-21T12:31:00.000Z',
      startedAt: '2026-09-21T12:32:00.000Z',
      finishedAt: '2026-09-21T12:34:00.000Z',
      webUrl: 'https://gitlab.example/platform/fork/-/jobs/5701',
    }]);
    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/api/v4/projects/812/merge_requests/27/pipelines',
        query: { page: '2', per_page: '20' },
      },
      {
        method: 'GET',
        path: '/api/v4/projects/913/pipelines/4501/jobs',
        query: { page: '1', per_page: '20' },
      },
    ]);
  });

  // Accept optional pipeline display data but never guess an owner for its jobs.
  it('keeps a pipeline with a missing owner but rejects malformed owner IDs', async () => {
    const { host, requests } = createHost([jsonResponse(200, [pipeline({
      project_id: null,
      target_project_id: 812,
      source_project_id: 913,
      status: undefined,
      ref: null,
      sha: undefined,
      source: null,
      created_at: undefined,
      updated_at: null,
      started_at: undefined,
      finished_at: null,
      web_url: undefined,
    })])]);
    const [result] = await listMergeRequestPipelines(host, 812, 27);
    expect(result).toEqual({
      id: 4501,
      projectId: null,
      status: null,
      ref: null,
      sha: null,
      source: null,
      createdAt: null,
      updatedAt: null,
      startedAt: null,
      finishedAt: null,
      webUrl: null,
    });
    await expect(listPipelineJobs(host, result.projectId as unknown as number, result.id))
      .rejects.toMatchObject({ code: 'invalid-response', resource: 'jobs' });
    expect(requests).toHaveLength(1);

    await expect(listMergeRequestPipelines(
      createHost([jsonResponse(200, [pipeline({ project_id: '913' })])]).host,
      812,
      27,
    )).rejects.toMatchObject({ code: 'invalid-response', resource: 'pipelines' });
  });

  // Reject malformed and repeated pipeline/job identities and cap every returned page.
  it('rejects malformed, duplicate, or oversized pipeline and job pages', async () => {
    const pipelineRows = [
      pipeline({ id: 0 }),
      pipeline({ project_id: Number.MAX_SAFE_INTEGER + 1 }),
      pipeline({ web_url: 'https://user:password@gitlab.example/pipeline/4501' }),
    ];
    for (const row of pipelineRows) {
      await expect(listMergeRequestPipelines(createHost([jsonResponse(200, [row])]).host, 812, 27))
        .rejects.toMatchObject({ code: 'invalid-response', resource: 'pipelines' });
    }
    await expect(listMergeRequestPipelines(createHost([jsonResponse(200, [pipeline(), pipeline({ project_id: 914 })])]).host, 812, 27))
      .rejects.toMatchObject({ code: 'invalid-response', resource: 'pipelines' });
    await expect(listMergeRequestPipelines(createHost([jsonResponse(200, Array.from({ length: 21 }, (_, index) => pipeline({ id: 4501 + index }))) ]).host, 812, 27))
      .rejects.toMatchObject({ code: 'invalid-response', resource: 'pipelines' });

    const jobRows = [pipelineJob({ id: 0 }), pipelineJob({ name: '  ' }), pipelineJob({ status: null }), pipelineJob({ web_url: 'http://gitlab.example/job/5701' })];
    for (const row of jobRows) {
      await expect(listPipelineJobs(createHost([jsonResponse(200, [row])]).host, 913, 4501))
        .rejects.toMatchObject({ code: 'invalid-response', resource: 'jobs' });
    }
    await expect(listPipelineJobs(createHost([jsonResponse(200, [pipelineJob(), pipelineJob({ name: 'lint' })])]).host, 913, 4501))
      .rejects.toMatchObject({ code: 'invalid-response', resource: 'jobs' });
    await expect(listPipelineJobs(createHost([jsonResponse(200, Array.from({ length: 21 }, (_, index) => pipelineJob({ id: 5701 + index }))) ]).host, 913, 4501))
      .rejects.toMatchObject({ code: 'invalid-response', resource: 'jobs' });
  });

  // Preserve discussion bodies as plain text and parse nullable author and resolution metadata safely.
  it('lists discussion notes as text with nullable authors and system metadata', async () => {
    const rawBody = '<img src=x onerror="alert(1)"> keep as text';
    const { host, requests } = createHost([jsonResponse(200, [
      discussion({ notes: [{
        id: 6701,
        body: rawBody,
        author: null,
        system: true,
        resolvable: null,
        resolved: true,
        resolved_by: { id: 74, username: 'alex', name: 'Alex' },
        resolved_at: '2026-09-21T12:35:00.000Z',
      }, {
        id: 6702,
        body: '',
      }] }),
    ])]);

    await expect(listMergeRequestDiscussions(host, 812, 27, 3)).resolves.toEqual([{
      id: 'discussion-4501',
      notes: [{
        id: 6701,
        body: rawBody,
        author: null,
        createdAt: null,
        updatedAt: null,
        system: true,
        resolvable: null,
        resolved: true,
        resolvedBy: { id: 74, username: 'alex', name: 'Alex' },
        resolvedAt: '2026-09-21T12:35:00.000Z',
      }, {
        id: 6702,
        body: '',
        author: null,
        createdAt: null,
        updatedAt: null,
        system: null,
        resolvable: null,
        resolved: null,
        resolvedBy: null,
        resolvedAt: null,
      }],
    }]);
    expect(requests).toEqual([{
      method: 'GET',
      path: '/api/v4/projects/812/merge_requests/27/discussions',
      query: { page: '3', per_page: '20' },
    }]);
  });

  // Reject malformed or repeated discussion and note identities without exposing partial threads.
  it('rejects malformed, duplicate, or oversized discussion pages', async () => {
    const malformed = [
      discussion({ id: '  ' }),
      discussion({ notes: null }),
      discussion({ notes: [{ id: 6701, body: 5 }] }),
      discussion({ notes: [{ id: 6701, body: '', system: 'yes' }] }),
      discussion({ notes: [{ id: 6701, body: '', author: { id: '73' } }] }),
    ];
    for (const row of malformed) {
      await expect(listMergeRequestDiscussions(createHost([jsonResponse(200, [row])]).host, 812, 27))
        .rejects.toMatchObject({ code: 'invalid-response', resource: 'discussions' });
    }
    await expect(listMergeRequestDiscussions(createHost([jsonResponse(200, [discussion(), discussion({ id: 'discussion-other' })])]).host, 812, 27))
      .rejects.toMatchObject({ code: 'invalid-response', resource: 'discussions' });
    await expect(listMergeRequestDiscussions(createHost([jsonResponse(200, [
      discussion(),
      discussion({ id: 'discussion-other', notes: [{ id: 6701, body: 'duplicate note id' }] }),
    ])]).host, 812, 27)).rejects.toMatchObject({ code: 'invalid-response', resource: 'discussions' });
    await expect(listMergeRequestDiscussions(createHost([jsonResponse(200, Array.from({ length: 21 }, (_, index) => discussion({ id: `discussion-${index}` }))) ]).host, 812, 27))
      .rejects.toMatchObject({ code: 'invalid-response', resource: 'discussions' });
  });

  // Reject invalid resource IDs and pages before sending any host request.
  it('rejects invalid pipeline, job, discussion IDs, and page bounds before network access', async () => {
    const { host, requests } = createHost([]);
    await expect(listMergeRequestPipelines(host, 0, 27)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listMergeRequestPipelines(host, 812, 0)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listMergeRequestPipelines(host, 812, Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listPipelineJobs(host, 913, 0)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listPipelineJobs(host, 0, 4501)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listPipelineJobs(host, 913, 4501, 1001)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listMergeRequestDiscussions(host, 0, 27)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listMergeRequestDiscussions(host, 812, 0)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listMergeRequestDiscussions(host, 812, 27, 1001)).rejects.toMatchObject({ code: 'invalid-response' });
    await expect(listMergeRequestDiscussions(host, 812, 27, 0)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(requests).toEqual([]);
  });

  // Keep resource-specific authorization messages neutral about deletion and preserve provider errors.
  it('maps pipeline, job, and discussion authorization failures without returning empty pages', async () => {
    const resources = [
      { resource: 'pipelines', load: (host: GitLabHost) => listMergeRequestPipelines(host, 812, 27) },
      { resource: 'jobs', load: (host: GitLabHost) => listPipelineJobs(host, 913, 4501) },
      { resource: 'discussions', load: (host: GitLabHost) => listMergeRequestDiscussions(host, 812, 27) },
    ];
    for (const entry of resources) {
      for (const item of [
        { status: 401, code: 'disconnected' },
        { status: 403, code: 'forbidden' },
        { status: 404, code: 'not-found' },
      ] as const) {
        let caught: unknown;
        try {
          await entry.load(createHost([jsonResponse(item.status, { message: 'private response' })]).host);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(GitLabApiError);
        expect(caught).toMatchObject({ code: item.code, resource: entry.resource });
        expect(gitLabErrorMessage(caught)).not.toContain('private response');
        if (item.status === 404) {
          expect(gitLabErrorMessage(caught)).toMatch(/unavailable or inaccessible/i);
          expect(gitLabErrorMessage(caught)).not.toContain('removed');
        }
      }
    }
  });
});
