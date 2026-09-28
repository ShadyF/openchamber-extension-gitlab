import { afterEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import { createPanel, type PanelActions, type PanelState } from '../src/panel.js';

// Keep the panel state focused on its recovery view while satisfying the public render contract.
function panelState(attemptId: string | null, phase: PanelState['recovery']['phase']): PanelState {
  return {
    account: null,
    directory: null,
    repository: null,
    repositoryState: 'none',
    association: null,
    projects: [],
    selectedId: null,
    busy: false,
    searching: false,
    status: '',
    error: null,
    canSearch: false,
    searchBlocker: null,
    canSave: false,
    canRemove: false,
    isUnknown: false,
    workType: 'issues',
    workspaceRoute: { kind: 'issues-list' },
    sessionFocus: { kind: 'none' },
    issues: [],
    issueRoute: { kind: 'list' },
    issue: null,
    issuesLoading: false,
    issuesLoadingMore: false,
    issuesHasMore: false,
    issueLoading: false,
    issuesError: null,
    issueError: null,
    mergeRequestBrowser: {
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
    },
    mergeRequestOverview: null,
    mergeRequestActivity: {
      scope: null,
      pipelines: { status: 'idle', rows: [], committedPage: 0, loadingMore: false, hasMore: false, truncated: false, error: null },
      discussions: { status: 'idle', rows: [], committedPage: 0, loadingMore: false, hasMore: false, truncated: false, error: null },
      selectedPipelineId: null,
      jobs: { status: 'idle', rows: [], committedPage: 0, loadingMore: false, hasMore: false, truncated: false, error: null },
    },
    canStartWorktree: false,
    startingWorktree: false,
    worktreeStatus: '',
    worktreeError: null,
    recovery: {
      attemptId,
      phase,
      message: '',
      originLabel: 'OpenChamber · issue #19',
      directory: null,
      busy: false,
      canCheck: false,
      canOpenSession: false,
      canRelease: phase === 'unresolved',
    },
  };
}

// Supply no-op handlers so the DOM test can observe only recovery release dispatch.
function panelActions(release: () => void): PanelActions {
  return {
    search() {}, save() {}, remove() {}, retry() {}, loadIssues() {}, loadMoreIssues() {},
    selectIssue() {}, backToIssues() {}, retryIssues() {}, retryIssue() {}, startIssueWorktree() {},
    selectWorkType() {}, searchMergeRequests() {}, refreshMergeRequests() {}, refreshSessionFocus() {}, loadMoreMergeRequests() {},
    selectMergeRequest() {}, backToMergeRequests() {}, retryMergeRequest() {},
    loadMergeRequestPipelines() {}, loadMoreMergeRequestPipelines() {}, refreshMergeRequestPipelines() {},
    loadMergeRequestDiscussions() {}, loadMoreMergeRequestDiscussions() {}, refreshMergeRequestDiscussions() {},
    selectMergeRequestPipeline() {}, loadMoreMergeRequestJobs() {}, refreshMergeRequestJobs() {},
    retryRecoveryRead() {}, checkWorktreeOutcome() {}, openCreatedSession() {}, releaseWorktreeRecovery: release,
  };
}

describe('panel recovery confirmation', () => {
  let browser: Window | null = null;
  let panel: ReturnType<typeof createPanel> | null = null;

  // Remove the mounted panel and its Happy DOM window after each scenario.
  afterEach(() => {
    panel?.destroy();
    panel = null;
    browser?.happyDOM.abort();
    browser = null;
  });

  // Require a new acknowledgement after a record clears or its attempt identity changes.
  it('resets confirmation for a new attempt on the same origin', () => {
    browser = new Window();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document });
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: browser.HTMLElement });
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: browser.Element });
    const panelRoot = browser.document.createElement('main');
    browser.document.body.append(panelRoot);
    const root = panelRoot as unknown as HTMLElement;
    let releaseCount = 0;
    panel = createPanel(root, panelActions(() => { releaseCount += 1; }));

    // Confirm the first attempt, then render both a cleared record and a new unresolved attempt.
    panel.render(panelState('attempt-a', 'unresolved'));
    const confirm = root.querySelector<HTMLInputElement>('#release-recovery-confirm')!;
    const release = root.querySelector<HTMLButtonElement>('#release-recovery-button')!;
    confirm.click();
    expect(confirm.checked).toBe(true);

    panel.render(panelState(null, 'clear'));
    expect(confirm.checked).toBe(false);
    panel.render(panelState('attempt-b', 'unresolved'));
    expect(confirm.checked).toBe(false);
    expect(release.disabled).toBe(true);
    release.click();
    expect(releaseCount).toBe(0);

    // An attempt ID change alone also invalidates confirmation while the phase stays unresolved.
    confirm.click();
    expect(confirm.checked).toBe(true);
    panel.render(panelState('attempt-c', 'unresolved'));
    expect(confirm.checked).toBe(false);
    expect(release.disabled).toBe(true);
  });
});
