import { describe, expect, it } from 'bun:test';
import type { GitLabMergeRequest } from '../src/gitlab.js';
import { discoverRelatedMergeRequest } from '../src/related-merge-request.js';

// Build a complete adapter row with overridable identity and state fields.
function mergeRequest(overrides: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest {
  return {
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
    ...overrides,
  };
}

// Create discovery dependencies that record page and detail calls for assertions.
function createDiscovery(pages: GitLabMergeRequest[][], detail?: GitLabMergeRequest, isCurrent = () => true) {
  const requestedPages: number[] = [];
  const requestedDetails: Array<[number, number]> = [];
  const options = {
    issueProjectId: 812,
    issueIid: 17,
    targetProjectId: 812,
    async listPage(_projectId: number, _iid: number, page: number) {
      requestedPages.push(page);
      return pages[page - 1] ?? [];
    },
    async getDetail(projectId: number, iid: number) {
      requestedDetails.push([projectId, iid]);
      return detail ?? mergeRequest();
    },
    isCurrent,
  };

  return { options, requestedPages, requestedDetails };
}

// Exercise uniqueness decisions only after every related-MR page has been read.
describe('related merge request discovery', () => {
  // Do not treat a short nonempty page as the end of GitLab's results.
  it('continues after short pages and finds a candidate on a later page', async () => {
    const candidate = mergeRequest({ id: 1902, iid: 28 });
    const discovery = createDiscovery([[mergeRequest({ state: 'closed' })], [candidate], []], candidate);

    await expect(discoverRelatedMergeRequest(discovery.options)).resolves.toEqual({ kind: 'related', mergeRequest: candidate });
    expect(discovery.requestedPages).toEqual([1, 2, 3]);
    expect(discovery.requestedDetails).toEqual([[812, 28]]);
  });

  // Require an empty terminal probe even when the first page is empty.
  it('returns none only after an empty page completes discovery', async () => {
    const discovery = createDiscovery([[]]);

    await expect(discoverRelatedMergeRequest(discovery.options)).resolves.toEqual({ kind: 'none' });
    expect(discovery.requestedPages).toEqual([1]);
    expect(discovery.requestedDetails).toEqual([]);
  });

  // Cap traversal at ten pages and accept an empty tenth page as complete.
  it('returns incomplete after ten nonempty pages and permits an empty tenth page', async () => {
    const fullTraversal = createDiscovery(Array.from({ length: 10 }, () => [mergeRequest({ state: 'closed' })]));
    await expect(discoverRelatedMergeRequest(fullTraversal.options)).resolves.toEqual({ kind: 'incomplete' });
    expect(fullTraversal.requestedPages).toHaveLength(10);

    const terminalTenth = createDiscovery([
      ...Array.from({ length: 9 }, (_, index) => [mergeRequest({ id: 2000 + index, iid: 40 + index, state: 'closed' })]),
      [],
    ]);
    await expect(discoverRelatedMergeRequest(terminalTenth.options)).resolves.toEqual({ kind: 'none' });
    expect(terminalTenth.requestedPages).toHaveLength(10);
  });

  // Coalesce exact repeats but reject identity conflicts rather than selecting one record.
  it('coalesces consistent duplicates and marks conflicting duplicates ambiguous', async () => {
    const candidate = mergeRequest();
    const consistent = createDiscovery([[candidate], [candidate], []]);
    await expect(discoverRelatedMergeRequest(consistent.options)).resolves.toEqual({ kind: 'related', mergeRequest: candidate });

    const sameIdDifferentUrl = createDiscovery([[candidate], [mergeRequest({ webUrl: 'https://gitlab.example/other/27' })], []]);
    await expect(discoverRelatedMergeRequest(sameIdDifferentUrl.options)).resolves.toEqual({ kind: 'ambiguous' });

    const sameIidDifferentId = createDiscovery([[candidate], [mergeRequest({ id: 1902 })], []]);
    await expect(discoverRelatedMergeRequest(sameIidDifferentId.options)).resolves.toEqual({ kind: 'ambiguous' });
  });

  // Count only opened MRs across all target projects and distinguish cross-project competitors.
  it('handles zero, multiple, outside-project, and fork-source candidates', async () => {
    const closedOnly = createDiscovery([[mergeRequest({ state: 'closed' })], []]);
    await expect(discoverRelatedMergeRequest(closedOnly.options)).resolves.toEqual({ kind: 'none' });

    const multiple = createDiscovery([[
      mergeRequest(),
      mergeRequest({ id: 1902, iid: 28, projectId: 900, targetProjectId: 900 }),
    ], []]);
    await expect(discoverRelatedMergeRequest(multiple.options)).resolves.toEqual({ kind: 'ambiguous' });

    const otherTarget = mergeRequest({ id: 1902, iid: 28, projectId: 900, targetProjectId: 900 });
    const outside = createDiscovery([[otherTarget], []]);
    await expect(discoverRelatedMergeRequest(outside.options)).resolves.toEqual({ kind: 'outside-project' });
    expect(outside.requestedDetails).toEqual([]);

    const forkCandidate = mergeRequest({ sourceProjectId: 901 });
    const fork = createDiscovery([[forkCandidate], []], forkCandidate);
    await expect(discoverRelatedMergeRequest(fork.options)).resolves.toEqual({ kind: 'related', mergeRequest: forkCandidate });
  });

  // Refuse a detail refresh that closed or changed after list discovery.
  it('rejects a candidate that closes or changes identity on detail refresh', async () => {
    const candidate = mergeRequest();
    const closed = createDiscovery([[candidate], []], mergeRequest({ state: 'closed' }));
    await expect(discoverRelatedMergeRequest(closed.options)).resolves.toEqual({ kind: 'incomplete' });

    const changedTarget = createDiscovery([[candidate], []], mergeRequest({ projectId: 900, targetProjectId: 900 }));
    await expect(discoverRelatedMergeRequest(changedTarget.options)).resolves.toEqual({ kind: 'incomplete' });
  });

  // Stop immediately when the caller's context becomes stale, including during a failed request.
  it('cancels before another page and suppresses stale authorization failures', async () => {
    let current = true;
    const afterFirstPage = {
      ...createDiscovery([[mergeRequest({ state: 'closed' })]], undefined, () => current).options,
      async listPage(_projectId: number, _iid: number, page: number) {
        if (page === 1) current = false;
        return [mergeRequest({ state: 'closed' })];
      },
    };
    await expect(discoverRelatedMergeRequest(afterFirstPage)).resolves.toEqual({ kind: 'cancelled' });

    current = true;
    let staleErrorRequests = 0;
    const staleError = {
      ...afterFirstPage,
      isCurrent: () => current,
      async listPage() {
        staleErrorRequests += 1;
        current = false;
        throw new Error('GitLab returned 401');
      },
    };
    await expect(discoverRelatedMergeRequest(staleError)).resolves.toEqual({ kind: 'cancelled' });
    expect(staleErrorRequests).toBe(1);
  });

  // Keep malformed injected pages from being mistaken for valid complete results.
  it('returns incomplete for malformed or oversized injected pages', async () => {
    const malformed = createDiscovery([[{ ...mergeRequest(), targetProjectId: 900 } as GitLabMergeRequest]]);
    await expect(discoverRelatedMergeRequest(malformed.options)).resolves.toEqual({ kind: 'incomplete' });

    const oversized = createDiscovery([Array.from({ length: 51 }, (_, index) => mergeRequest({ id: 3000 + index, iid: 70 + index }))]);
    await expect(discoverRelatedMergeRequest(oversized.options)).resolves.toEqual({ kind: 'incomplete' });
  });

  // Propagate current-scope failures so callers can handle authentication and access changes.
  it('throws current request failures instead of translating them to none', async () => {
    const denied = {
      ...createDiscovery([]).options,
      async listPage() {
        throw new Error('GitLab denied access');
      },
    };

    await expect(discoverRelatedMergeRequest(denied)).rejects.toThrow('GitLab denied access');
  });
});
