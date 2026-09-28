import { describe, expect, it } from 'bun:test';
import { GitLabApiError, type GitLabMergeRequest } from '../src/gitlab.js';
import { createMergeRequestBrowser, type MergeRequestBrowseScope } from '../src/merge-request-browser.js';

// Make a stable merge request row that can be varied for paging and detail tests.
function row(iid: number, id = iid + 1000): GitLabMergeRequest {
  return {
    id,
    iid,
    projectId: 812,
    targetProjectId: 812,
    sourceProjectId: 812,
    title: `Merge request ${iid}`,
    description: '',
    state: 'opened',
    webUrl: `https://gitlab.example/project/-/merge_requests/${iid}`,
    updatedAt: '2026-09-20T12:30:00.000Z',
    sourceBranch: null,
    targetBranch: null,
  };
}

// Keep every test scoped to a concrete project and account identity.
function scope(revision = 1, projectId = 812): MergeRequestBrowseScope {
  return {
    revision,
    directory: '/work/project',
    localProjectId: 'local-project',
    accountId: 73,
    variant: 'gitlab-self-managed',
    projectId,
  };
}

// Control request completion order to exercise stale-result protections.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Build one full page so the next action is allowed to request another page.
function fullPage(start = 1): GitLabMergeRequest[] {
  return Array.from({ length: 20 }, (_, index) => row(start + index));
}

describe('merge request browser state', () => {
  // Ensure a newer submitted query wins when an earlier request finishes later.
  it('ignores an older search response after a newer search completes', async () => {
    const first = deferred<GitLabMergeRequest[]>();
    const second = deferred<GitLabMergeRequest[]>();
    const calls = [first, second];
    const browser = createMergeRequestBrowser({
      listProjectMergeRequests: () => calls.shift()!.promise,
      getProjectMergeRequest: async (_projectId, iid) => row(iid),
      onChange() {},
    });
    browser.setScope(scope());

    const oldSearch = browser.search('old');
    const newSearch = browser.search('new');
    second.resolve([row(2)]);
    await newSearch;
    first.resolve([row(1)]);
    await oldSearch;

    expect(browser.snapshot()).toMatchObject({ submittedQuery: 'new', committedPage: 1, rows: [row(2)], listLoading: false });
  });

  // Ensure a refresh invalidates an in-flight append without losing fresh rows.
  it('ignores an append that completes after refresh starts', async () => {
    const append = deferred<GitLabMergeRequest[]>();
    const refresh = deferred<GitLabMergeRequest[]>();
    let pageOneCalls = 0;
    const browser = createMergeRequestBrowser({
      listProjectMergeRequests: async (_projectId, page) => {
        if (page === 2) return append.promise;
        pageOneCalls += 1;
        if (pageOneCalls === 1) return fullPage();
        return refresh.promise;
      },
      getProjectMergeRequest: async (_projectId, iid) => row(iid),
      onChange() {},
    });
    browser.setScope(scope());
    await browser.ensureList();
    const adding = browser.loadMore();
    const refreshing = browser.refresh();
    refresh.resolve([row(50)]);
    await refreshing;
    append.resolve([row(30)]);
    await adding;

    expect(browser.snapshot()).toMatchObject({ rows: [row(50)], committedPage: 1, hasMore: false });
  });

  // Keep failed append page numbers uncommitted so retry repeats that exact page.
  it('retries a failed append with the same page and query', async () => {
    const pageOne = fullPage();
    let pageTwoAttempts = 0;
    const retryBrowser = createMergeRequestBrowser({
      listProjectMergeRequests: async (_projectId, page) => {
        if (page === 1) return pageOne;
        pageTwoAttempts += 1;
        if (pageTwoAttempts === 1) throw new Error('private provider body');
        return [row(40)];
      },
      getProjectMergeRequest: async (_projectId, iid) => row(iid),
      onChange() {},
    });
    retryBrowser.setScope(scope());
    await retryBrowser.search('deploy');
    await retryBrowser.loadMore();
    expect(retryBrowser.snapshot()).toMatchObject({ committedPage: 1, listError: expect.stringContaining('Could not reach GitLab') });
    await retryBrowser.loadMore();

    expect(pageTwoAttempts).toBe(2);
    expect(retryBrowser.snapshot()).toMatchObject({ committedPage: 2, rows: [...pageOne, row(40)], listError: null });
  });

  // Treat empty pages as terminal and remove cross-page duplicate identities.
  it('ends on an empty page and deduplicates overlap by stable ID or IID', async () => {
    const calls: Array<() => Promise<GitLabMergeRequest[]>> = [
      async () => fullPage(),
      async () => [row(30, 1001), row(2, 9002), ...Array.from({ length: 18 }, (_, index) => row(32 + index, 9032 + index))],
      async () => [],
    ];
    const listing = createMergeRequestBrowser({
      listProjectMergeRequests: () => calls.shift()!(),
      getProjectMergeRequest: async (_projectId, iid) => row(iid),
      onChange() {},
    });
    listing.setScope(scope());
    await listing.ensureList();
    await listing.loadMore();
    expect(listing.snapshot().rows).toHaveLength(38);
    await listing.loadMore();
    expect(listing.snapshot()).toMatchObject({
      committedPage: 3,
      hasMore: false,
      rows: [...fullPage(), ...Array.from({ length: 18 }, (_, index) => row(32 + index, 9032 + index))],
    });
  });

  // Reset list and detail state when the scope changes, even if IDs later return.
  it('does not resurrect responses after switching away and back to the same IDs', async () => {
    const pending = deferred<GitLabMergeRequest[]>();
    const browser = createMergeRequestBrowser({
      listProjectMergeRequests: () => pending.promise,
      getProjectMergeRequest: async (_projectId, iid) => row(iid),
      onChange() {},
    });
    browser.setScope(scope(10));
    const request = browser.search('old');
    browser.setScope(scope(11));
    browser.setScope(scope(12));
    pending.resolve([row(1)]);
    await request;

    expect(browser.snapshot()).toMatchObject({ submittedQuery: '', rows: [], committedPage: 0, listLoading: false });
  });

  // Ignore stale detail responses and clear pending details on Back.
  it('keeps the newest detail selection and ignores a result after Back', async () => {
    const first = deferred<GitLabMergeRequest>();
    const second = deferred<GitLabMergeRequest>();
    const detailPromises = [first, second];
    const browser = createMergeRequestBrowser({
      listProjectMergeRequests: async () => [],
      getProjectMergeRequest: () => detailPromises.shift()!.promise,
      onChange() {},
    });
    browser.setScope(scope());
    const detailA = browser.loadDetail(1);
    const detailB = browser.loadDetail(2);
    second.resolve(row(2));
    await detailB;
    first.resolve(row(1));
    await detailA;
    expect(browser.snapshot()).toMatchObject({ selectedIid: 2, detail: row(2), detailLoading: false });

    const pending = deferred<GitLabMergeRequest>();
    const backBrowser = createMergeRequestBrowser({
      listProjectMergeRequests: async () => [],
      getProjectMergeRequest: () => pending.promise,
      onChange() {},
    });
    backBrowser.setScope(scope());
    const detail = backBrowser.loadDetail(3);
    backBrowser.back();
    pending.resolve(row(3));
    await detail;
    expect(backBrowser.snapshot()).toMatchObject({ selectedIid: null, detail: null, detailLoading: false });
  });

  // Invalidate requests on destroy so they cannot mutate state or notify owners.
  it('ignores late requests after destroy', async () => {
    const pending = deferred<GitLabMergeRequest[]>();
    const pendingDetail = deferred<GitLabMergeRequest>();
    let authFailures = 0;
    let changes = 0;
    const browser = createMergeRequestBrowser({
      listProjectMergeRequests: () => pending.promise,
      getProjectMergeRequest: () => pendingDetail.promise,
      onChange() { changes += 1; },
      onAuthenticationFailure() { authFailures += 1; },
    });
    browser.setScope(scope());
    const request = browser.ensureList();
    const detailRequest = browser.loadDetail(7);
    const beforeDestroy = changes;
    browser.destroy();
    pending.reject(new GitLabApiError('disconnected', 'merge-requests'));
    pendingDetail.reject(new GitLabApiError('disconnected', 'merge-requests'));
    await request;
    await detailRequest;

    expect(changes).toBe(beforeDestroy);
    expect(authFailures).toBe(0);
  });

  // Send authentication failures only for requests that still own the current scope.
  it('signals current authentication errors but suppresses stale authentication errors', async () => {
    let currentAuthFailures = 0;
    const currentBrowser = createMergeRequestBrowser({
      listProjectMergeRequests: async () => { throw new GitLabApiError('disconnected', 'merge-requests'); },
      getProjectMergeRequest: async (_projectId, iid) => row(iid),
      onChange() {},
      onAuthenticationFailure() { currentAuthFailures += 1; },
    });
    currentBrowser.setScope(scope());
    await currentBrowser.ensureList();
    expect(currentAuthFailures).toBe(1);

    const stale = deferred<GitLabMergeRequest[]>();
    let staleAuthFailures = 0;
    const staleBrowser = createMergeRequestBrowser({
      listProjectMergeRequests: () => stale.promise,
      getProjectMergeRequest: async (_projectId, iid) => row(iid),
      onChange() {},
      onAuthenticationFailure() { staleAuthFailures += 1; },
    });
    staleBrowser.setScope(scope());
    const loading = staleBrowser.ensureList();
    staleBrowser.setScope(scope(2));
    stale.reject(new GitLabApiError('disconnected', 'merge-requests'));
    await loading;
    expect(staleAuthFailures).toBe(0);
  });
});
