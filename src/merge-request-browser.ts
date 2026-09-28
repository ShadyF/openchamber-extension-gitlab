import {
  GitLabApiError,
  gitLabErrorMessage,
  type GitLabMergeRequest,
} from './gitlab.js';

export type MergeRequestBrowseScope = Readonly<{
  revision: number;
  directory: string;
  localProjectId: string | null;
  accountId: number;
  variant: string;
  projectId: number;
}>;

export type MergeRequestBrowserSnapshot = Readonly<{
  scope: MergeRequestBrowseScope | null;
  rows: readonly GitLabMergeRequest[];
  submittedQuery: string;
  committedPage: number;
  hasMore: boolean;
  listLoading: boolean;
  listError: string | null;
  selectedIid: number | null;
  detail: GitLabMergeRequest | null;
  detailLoading: boolean;
  detailError: string | null;
}>;

export type MergeRequestBrowserOptions = Readonly<{
  listProjectMergeRequests: (projectId: number, page: number, search: string) => Promise<GitLabMergeRequest[]>;
  getProjectMergeRequest: (projectId: number, iid: number) => Promise<GitLabMergeRequest>;
  onChange: (snapshot: MergeRequestBrowserSnapshot) => void;
  onAuthenticationFailure?: () => void;
}>;

export type MergeRequestBrowser = Readonly<{
  snapshot: () => MergeRequestBrowserSnapshot;
  setScope: (scope: MergeRequestBrowseScope | null) => void;
  ensureList: () => Promise<void>;
  search: (query: string) => Promise<void>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  loadDetail: (iid: number) => Promise<void>;
  clearDetail: () => void;
  back: () => void;
  retryDetail: () => Promise<void>;
  destroy: () => void;
}>;

type MutableState = {
  scope: MergeRequestBrowseScope | null;
  rows: GitLabMergeRequest[];
  submittedQuery: string;
  committedPage: number;
  hasMore: boolean;
  listLoading: boolean;
  listError: string | null;
  selectedIid: number | null;
  detail: GitLabMergeRequest | null;
  detailLoading: boolean;
  detailError: string | null;
};

const pageSize = 20;

// Create an isolated browser state machine for project merge requests.
export function createMergeRequestBrowser(options: MergeRequestBrowserOptions): MergeRequestBrowser {
  const state: MutableState = {
    scope: null,
    rows: [],
    submittedQuery: '',
    committedPage: 0,
    hasMore: false,
    listLoading: false,
    listError: null,
    selectedIid: null,
    detail: null,
    detailLoading: false,
    detailError: null,
  };
  let listGeneration = 0;
  let detailGeneration = 0;
  let destroyed = false;

  // Return a detached snapshot so callers cannot mutate internal list state.
  function snapshot(): MergeRequestBrowserSnapshot {
    return {
      ...state,
      scope: state.scope ? { ...state.scope } : null,
      rows: state.rows.map((row) => ({ ...row })),
      detail: state.detail ? { ...state.detail } : null,
    };
  }

  // Notify the owner after every visible state transition.
  function notify(): void {
    if (!destroyed) options.onChange(snapshot());
  }

  // Compare the revision and every identity field to prevent stale scope reuse.
  function sameScope(left: MergeRequestBrowseScope | null, right: MergeRequestBrowseScope | null): boolean {
    return left === right || Boolean(
      left
      && right
      && left.revision === right.revision
      && left.directory === right.directory
      && left.localProjectId === right.localProjectId
      && left.accountId === right.accountId
      && left.variant === right.variant
      && left.projectId === right.projectId,
    );
  }

  // Keep an async result current only while its scope and generation still match.
  function isCurrent(scope: MergeRequestBrowseScope, generation: number, currentGeneration: number): boolean {
    return !destroyed && currentGeneration === generation && sameScope(state.scope, scope);
  }

  // Report only known authentication failures from requests that still belong to this scope.
  function reportAuthenticationFailure(error: unknown): void {
    if (error instanceof GitLabApiError && error.code === 'disconnected') {
      options.onAuthenticationFailure?.();
    }
  }

  // Deduplicate cross-page overlap using both stable and project-local identities.
  function appendUnique(existing: readonly GitLabMergeRequest[], incoming: readonly GitLabMergeRequest[]): GitLabMergeRequest[] {
    const ids = new Set(existing.map((row) => row.id));
    const iids = new Set(existing.map((row) => row.iid));
    const rows = [...existing];
    for (const row of incoming) {
      if (ids.has(row.id) || iids.has(row.iid)) continue;
      ids.add(row.id);
      iids.add(row.iid);
      rows.push(row);
    }

    return rows;
  }

  // Load one page for every list action and commit it only if the request is still current.
  async function loadList(mode: 'reset' | 'append', query: string): Promise<void> {
    const scope = state.scope;
    if (!scope || destroyed) return;
    if (mode === 'append' && (state.listLoading || !state.hasMore || state.committedPage >= 1000)) return;

    const generation = ++listGeneration;
    const page = mode === 'append' ? state.committedPage + 1 : 1;
    if (mode === 'reset') {
      state.rows = [];
      state.committedPage = 0;
      state.hasMore = false;
      state.submittedQuery = query;
    }
    state.listLoading = true;
    state.listError = null;
    notify();

    try {
      const result = await options.listProjectMergeRequests(scope.projectId, page, query);
      if (!isCurrent(scope, generation, listGeneration)) return;
      state.rows = mode === 'append' ? appendUnique(state.rows, result) : [...result];
      state.committedPage = page;
      state.hasMore = result.length === pageSize && page < 1000;
    } catch (error) {
      if (!isCurrent(scope, generation, listGeneration)) return;
      state.listError = gitLabErrorMessage(error);
      reportAuthenticationFailure(error);
    } finally {
      if (isCurrent(scope, generation, listGeneration)) {
        state.listLoading = false;
        notify();
      }
    }
  }

  // Bind the browser to a new identity and invalidate all outstanding work.
  function setScope(scope: MergeRequestBrowseScope | null): void {
    if (destroyed || sameScope(state.scope, scope)) return;
    listGeneration += 1;
    detailGeneration += 1;
    state.scope = scope ? { ...scope } : null;
    state.rows = [];
    state.submittedQuery = '';
    state.committedPage = 0;
    state.hasMore = false;
    state.listLoading = false;
    state.listError = null;
    state.selectedIid = null;
    state.detail = null;
    state.detailLoading = false;
    state.detailError = null;
    notify();
  }

  // Load the first page only when this scope has no committed page yet.
  async function ensureList(): Promise<void> {
    if (state.committedPage === 0 && !state.listLoading) await loadList('reset', state.submittedQuery);
  }

  // Start a new first-page search and discard rows from the prior query.
  async function search(query: string): Promise<void> {
    await loadList('reset', query);
  }

  // Reload page one using the last submitted query.
  async function refresh(): Promise<void> {
    await loadList('reset', state.submittedQuery);
  }

  // Append the next committed page without advancing on failure.
  async function loadMore(): Promise<void> {
    if (!state.hasMore || state.listLoading || state.committedPage >= 1000) return;
    await loadList('append', state.submittedQuery);
  }

  // Fetch one selected detail while suppressing results from older selections.
  async function loadDetail(iid: number): Promise<void> {
    const scope = state.scope;
    if (!scope || destroyed) return;
    const generation = ++detailGeneration;
    state.selectedIid = iid;
    state.detail = null;
    state.detailLoading = true;
    state.detailError = null;
    notify();

    try {
      const result = await options.getProjectMergeRequest(scope.projectId, iid);
      if (!isCurrent(scope, generation, detailGeneration)) return;
      state.detail = result;
    } catch (error) {
      if (!isCurrent(scope, generation, detailGeneration)) return;
      state.detailError = gitLabErrorMessage(error);
      reportAuthenticationFailure(error);
    } finally {
      if (isCurrent(scope, generation, detailGeneration)) {
        state.detailLoading = false;
        notify();
      }
    }
  }

  // Clear selected detail and invalidate any request for the previous selection.
  function clearDetail(): void {
    if (destroyed) return;
    detailGeneration += 1;
    state.selectedIid = null;
    state.detail = null;
    state.detailLoading = false;
    state.detailError = null;
    notify();
  }

  // Retry only the currently selected project-local IID.
  async function retryDetail(): Promise<void> {
    const iid = state.selectedIid;
    if (iid !== null) await loadDetail(iid);
  }

  // Stop future notifications and invalidate every outstanding request.
  function destroy(): void {
    destroyed = true;
    listGeneration += 1;
    detailGeneration += 1;
  }

  return {
    snapshot,
    setScope,
    ensureList,
    search,
    refresh,
    loadMore,
    loadDetail,
    clearDetail,
    back: clearDetail,
    retryDetail,
    destroy,
  };
}
