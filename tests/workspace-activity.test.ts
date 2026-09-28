import { afterEach, describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import type { ActivityCollection, MergeRequestActivitySnapshot } from '../src/merge-request-activity.js';
import type { WorkspaceActions, WorkspaceState } from '../src/workspace.js';
import { GITLAB_VARIANT_ID, type GitLabDiscussion, type GitLabJob, type GitLabMergeRequest, type GitLabPipeline } from '../src/gitlab.js';
import { createWorkspace } from '../src/workspace.js';

const request: GitLabMergeRequest = {
  id: 123,
  iid: 5,
  projectId: 7,
  targetProjectId: 7,
  sourceProjectId: null,
  title: 'Read-only activity details',
  description: 'A real merge request description.',
  state: 'opened',
  webUrl: 'https://gitlab.example/group/project/-/merge_requests/5',
  updatedAt: '2026-09-25T10:00:00Z',
  sourceBranch: 'feature/activity',
  targetBranch: 'main',
};

const activityScope = {
  accountId: 1,
  variant: GITLAB_VARIANT_ID,
  directory: '/workspace/project',
  localProjectId: 'local-project-1',
  targetProjectId: request.targetProjectId,
  mergeRequestId: request.id,
  iid: request.iid,
  webUrl: request.webUrl,
  origin: 'browse' as const,
  revision: 1,
};

// Give each activity collection the complete state shape used by the workspace.
function collection<T>(overrides: Partial<ActivityCollection<T>> = {}): ActivityCollection<T> {
  return {
    status: 'idle',
    rows: [],
    committedPage: 0,
    loadingMore: false,
    hasMore: false,
    truncated: false,
    error: null,
    ...overrides,
  };
}

// Keep fixtures centered on one verified browse detail and one matching activity scope.
function panelState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  const { mergeRequestActivity: activityOverrides, ...stateOverrides } = overrides;
  const activity: MergeRequestActivitySnapshot = {
    scope: activityScope,
    pipelines: collection<GitLabPipeline>(),
    discussions: collection<GitLabDiscussion>(),
    selectedPipelineId: null,
    jobs: collection<GitLabJob>(),
    ...activityOverrides,
  };
  return {
    account: 'account-1',
    directory: '/workspace/project',
    repository: 'project',
    repositoryState: 'registered',
    association: { id: 7, path: 'group/project' },
    projects: [],
    selectedId: 7,
    busy: false,
    searching: false,
    status: '',
    error: null,
    canSearch: true,
    searchBlocker: null,
    canSave: false,
    canRemove: false,
    isUnknown: false,
    workType: 'merge-requests',
    workspaceRoute: { kind: 'merge-request-detail', iid: request.iid, origin: 'browse' },
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
      selectedIid: request.iid,
      detail: request,
      detailLoading: false,
      detailError: null,
    },
    mergeRequestOverview: request,
    mergeRequestActivity: activity,
    canStartWorktree: false,
    startingWorktree: false,
    worktreeStatus: '',
    worktreeError: null,
    recovery: {
      attemptId: null,
      phase: 'clear',
      message: '',
      originLabel: null,
      directory: null,
      busy: false,
      canCheck: false,
      canOpenSession: false,
      canRelease: false,
    },
    changingProject: false,
    ...stateOverrides,
  };
}

// Keep row fixtures real-shaped so empty and truncated UI tests use actual activity data.
const pipelineFixture: GitLabPipeline = {
  id: 41, projectId: 7, status: 'success', ref: 'main', sha: 'abc123', source: 'push',
  createdAt: '2026-09-25T09:00:00Z', updatedAt: '2026-09-25T10:00:00Z',
  startedAt: null, finishedAt: '2026-09-25T10:00:00Z',
  webUrl: 'https://gitlab.example/group/project/-/pipelines/41',
};
const jobFixture: GitLabJob = {
  id: 88, name: 'build:unit', status: 'success', stage: 'test',
  createdAt: '2026-09-25T09:00:00Z', startedAt: null, finishedAt: '2026-09-25T10:00:00Z',
  webUrl: 'https://gitlab.example/group/project/-/jobs/88',
};
const discussionFixture: GitLabDiscussion = {
  id: 'thread-cap',
  notes: [{
    id: 91, body: 'A real discussion note.', author: { id: 1, username: 'reviewer', name: 'Reviewer' },
    createdAt: '2026-09-25T10:00:00Z', updatedAt: null, system: false,
    resolvable: false, resolved: null, resolvedBy: null, resolvedAt: null,
  }],
};

// Supply no-op workspace actions and replace only the callbacks each case observes.
function workspaceActions(overrides: Partial<WorkspaceActions> = {}): WorkspaceActions {
  return {
    changeProject() {}, remove() {}, loadIssues() {}, loadMoreIssues() {}, selectIssue() {}, backToIssues() {},
    retryIssues() {}, retryIssue() {}, selectWorkType() {}, searchMergeRequests() {}, refreshMergeRequests() {},
    refreshSessionFocus() {}, loadMoreMergeRequests() {}, selectMergeRequest() {}, backToMergeRequests() {},
    retryMergeRequest() {}, startIssueWorktree() {}, loadMergeRequestPipelines() {},
    loadMoreMergeRequestPipelines() {}, refreshMergeRequestPipelines() {}, loadMergeRequestDiscussions() {},
    loadMoreMergeRequestDiscussions() {}, refreshMergeRequestDiscussions() {}, selectMergeRequestPipeline() {},
    loadMoreMergeRequestJobs() {}, refreshMergeRequestJobs() {},
    ...overrides,
  };
}

describe('merge request activity workspace', () => {
  let browser: Window | null = null;
  let workspace: ReturnType<typeof createWorkspace> | null = null;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined> | null = null;

  // Restore the test globals after removing the mounted workspace.
  afterEach(() => {
    workspace?.destroy();
    workspace = null;
    browser?.happyDOM.abort();
    browser = null;
    if (globalDescriptors) {
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      globalDescriptors = null;
    }
  });

  // Mount a real workspace root so interactions exercise the production event handlers.
  function mount(state = panelState(), actions = workspaceActions()) {
    browser = new Window();
    const globals = {
      document: browser.document,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      HTMLAnchorElement: browser.HTMLAnchorElement,
    };
    globalDescriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { configurable: true, value });
    }
    const document = browser.document as unknown as Document;
    const root = document.createElement('main');
    document.body.append(root);
    workspace = createWorkspace(root, actions);
    workspace.render(state);
    return root;
  }

  // Move tabs through their real keyboard path and ensure loading is lazy and focus stays put.
  it('supports tab keyboard navigation, focus retention, and lazy activity loading', () => {
    let pipelineLoads = 0;
    let discussionLoads = 0;
    const root = mount(panelState(), workspaceActions({
      loadMergeRequestPipelines: () => { pipelineLoads += 1; },
      loadMergeRequestDiscussions: () => { discussionLoads += 1; },
    }));
    const overviewTab = root.querySelector<HTMLButtonElement>('#mr-tab-overview')!;
    const pipelinesTab = root.querySelector<HTMLButtonElement>('#mr-tab-pipelines')!;
    const discussionsTab = root.querySelector<HTMLButtonElement>('#mr-tab-discussions')!;
    const document = browser!.document as unknown as Document;
    expect(pipelineLoads).toBe(0);
    expect(discussionLoads).toBe(0);

    overviewTab.focus();
    overviewTab.dispatchEvent(new browser!.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }) as unknown as Event);
    expect(pipelinesTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(pipelinesTab);
    expect(pipelineLoads).toBe(1);
    expect(root.querySelector<HTMLElement>('#mr-panel-pipelines')!.hidden).toBe(false);

    workspace!.render(panelState());
    expect(document.activeElement).toBe(pipelinesTab);
    pipelinesTab.dispatchEvent(new browser!.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }) as unknown as Event);
    expect(document.activeElement).toBe(discussionsTab);
    expect(discussionLoads).toBe(1);
    discussionsTab.dispatchEvent(new browser!.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }) as unknown as Event);
    expect(document.activeElement).toBe(overviewTab);
    expect(overviewTab.getAttribute('aria-selected')).toBe('true');

    pipelinesTab.dispatchEvent(new browser!.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }) as unknown as Event);
    workspace!.render(panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        scope: { ...activityScope, revision: 2 },
      },
    }));
    expect(overviewTab.getAttribute('aria-selected')).toBe('true');
    workspace!.render(panelState());
    expect(overviewTab.getAttribute('aria-selected')).toBe('true');
    expect(pipelineLoads).toBe(1);
    expect(discussionLoads).toBe(1);
  });

  // Suppress every merge-request detail surface while session verification is unresolved.
  it('hides retained browse detail and activity during session checking', () => {
    const state = panelState({
      workspaceRoute: { kind: 'merge-requests-list' },
      sessionFocus: {
        kind: 'checking',
        scope: {
          revision: 2,
          sessionId: 'session-1',
          directory: '/workspace/project',
          localProjectId: 'local-project-1',
          accountId: 1,
          variant: GITLAB_VARIANT_ID,
          projectId: 7,
        },
      },
      mergeRequestBrowser: {
        ...panelState().mergeRequestBrowser,
        rows: [request],
      },
    });
    const root = mount(state);
    expect(root.querySelector<HTMLElement>('#session-link-status')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('#issues-view')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#merge-request-detail')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#merge-request-tabs')!.hidden).toBe(true);
    expect(root.querySelector('#mr-pipelines-list')!.childElementCount).toBe(0);
    expect(root.querySelector('#mr-discussions-list')!.childElementCount).toBe(0);
  });

  // Keep a valid overview visible while refusing to attach activity from another scope.
  it('requires a matching non-null activity scope before showing detail tabs', () => {
    const state = panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        scope: null,
        pipelines: collection({ status: 'ready', rows: [{
          id: 7,
          projectId: 7,
          status: 'success',
          ref: 'main',
          sha: null,
          source: null,
          createdAt: null,
          updatedAt: null,
          startedAt: null,
          finishedAt: null,
          webUrl: null,
        }], committedPage: 1 }),
      },
    });
    const root = mount(state);
    expect(root.querySelector<HTMLElement>('#merge-request-content')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('#merge-request-tabs')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#merge-request-heading')!.textContent).toBe(request.title);
    expect(root.querySelector('#mr-pipelines-list')!.childElementCount).toBe(0);
  });

  // Render note bodies as text and avoid guessing at absent authors or resolution metadata.
  it('keeps provider discussion bodies inert and handles unknown metadata carefully', () => {
    const noteBody = '<img src=x onerror=alert(1)>\nPlain second line';
    const thread: GitLabDiscussion = {
      id: 'thread-1',
      notes: [{
        id: 10,
        body: noteBody,
        author: null,
        createdAt: null,
        updatedAt: null,
        system: null,
        resolvable: true,
        resolved: null,
        resolvedBy: null,
        resolvedAt: null,
      }, {
        id: 11,
        body: 'Automated thread update.',
        author: null,
        createdAt: null,
        updatedAt: null,
        system: true,
        resolvable: true,
        resolved: true,
        resolvedBy: { id: null, username: 'automation', name: null },
        resolvedAt: null,
      }],
    };
    const state = panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        discussions: collection({ status: 'ready', rows: [thread], committedPage: 1 }),
      },
    });
    const root = mount(state);
    root.querySelector<HTMLButtonElement>('#mr-tab-discussions')!.click();
    const body = root.querySelector<HTMLElement>('.discussion-note-body')!;
    expect(body.textContent).toBe(noteBody);
    expect(body.querySelector('img')).toBeNull();
    const noteMetadata = root.querySelectorAll('.discussion-note-meta');
    expect(noteMetadata[0].textContent).toContain('Unknown author');
    expect(noteMetadata[0].querySelector('.discussion-resolution')).toBeNull();
    expect(noteMetadata[1].textContent).toContain('GitLab system note');
    expect(noteMetadata[1].textContent).toContain('Resolved by automation');
  });

  // Distinguish an empty completed result from a retryable provider error.
  it('shows honest empty and error states for pipeline activity', () => {
    let retryLoads = 0;
    const emptyState = panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        pipelines: collection({ status: 'ready', committedPage: 1 }),
      },
    });
    const root = mount(emptyState, workspaceActions({
      loadMergeRequestPipelines: () => { retryLoads += 1; },
    }));
    root.querySelector<HTMLButtonElement>('#mr-tab-pipelines')!.click();
    expect(root.querySelector<HTMLElement>('#mr-pipelines-empty')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('#mr-pipelines-error')!.hidden).toBe(true);

    const errorState = panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        pipelines: collection({ status: 'error', error: 'Could not load this activity. Try again.' }),
      },
    });
    workspace!.render(errorState);
    const error = root.querySelector<HTMLElement>('#mr-pipelines-error')!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('Could not load this activity. Try again.');
    expect(root.querySelector<HTMLElement>('#mr-pipelines-empty')!.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('#mr-pipelines-retry')!.click();
    expect(retryLoads).toBe(1);

    workspace!.render(panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        pipelines: collection({ status: 'unavailable', error: 'This activity is unavailable or cannot be viewed.' }),
      },
    }));
    expect(root.querySelector<HTMLElement>('#mr-pipelines-status')!.textContent)
      .toContain('did not make pipelines data available');
    expect(root.querySelector<HTMLElement>('#mr-pipelines-empty')!.hidden).toBe(true);
  });

  // Select only a returned pipeline and explain when GitLab supplied no safe job owner.
  it('selects a visible pipeline and does not guess its project for jobs', () => {
    let selectedPipeline: number | null | undefined;
    const pipeline: GitLabPipeline = {
      id: 41,
      projectId: null,
      status: 'success',
      ref: 'main',
      sha: null,
      source: null,
      createdAt: null,
      updatedAt: null,
      startedAt: null,
      finishedAt: null,
      webUrl: null,
    };
    const state = panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        pipelines: collection({ status: 'ready', rows: [pipeline], committedPage: 1 }),
      },
    });
    const root = mount(state, workspaceActions({
      selectMergeRequestPipeline: (pipelineId) => { selectedPipeline = pipelineId; },
    }));
    root.querySelector<HTMLButtonElement>('#mr-tab-pipelines')!.click();
    root.querySelector<HTMLButtonElement>('[data-pipeline-id="41"]')!.click();
    expect(selectedPipeline).toBe(41);

    workspace!.render(panelState({
      mergeRequestActivity: {
        ...state.mergeRequestActivity,
        selectedPipelineId: 41,
        jobs: collection({ status: 'unavailable', error: 'Pipeline owner is unknown; jobs cannot be loaded safely.' }),
      },
    }));
    expect(root.querySelector<HTMLElement>('#mr-jobs-section')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('#mr-jobs-status')!.textContent)
      .toContain('did not identify this pipeline’s project');
    expect(root.querySelector('#mr-jobs-list')!.childElementCount).toBe(0);
  });

  // Preserve static empty and cap messages across the list-to-detail cleanup boundary.
  it('keeps empty and truncated copy visible after returning from the list', () => {
    const emptyActivity: MergeRequestActivitySnapshot = {
      ...panelState().mergeRequestActivity,
      pipelines: collection<GitLabPipeline>({ status: 'ready', committedPage: 1 }),
      discussions: collection<GitLabDiscussion>({ status: 'ready', committedPage: 1 }),
    };
    const root = mount(panelState({
      workspaceRoute: { kind: 'merge-requests-list' },
      mergeRequestOverview: null,
    }));

    workspace!.render(panelState({ mergeRequestActivity: emptyActivity }));
    root.querySelector<HTMLButtonElement>('#mr-tab-pipelines')!.click();
    const pipelinesPanel = root.querySelector<HTMLElement>('#mr-panel-pipelines')!;
    const pipelinesEmpty = root.querySelector<HTMLElement>('#mr-pipelines-empty')!;
    expect(pipelinesPanel.hidden).toBe(false);
    expect(pipelinesEmpty.hidden).toBe(false);
    expect(pipelinesEmpty.textContent?.trim().length).toBeGreaterThan(0);

    root.querySelector<HTMLButtonElement>('#mr-tab-discussions')!.click();
    const discussionsPanel = root.querySelector<HTMLElement>('#mr-panel-discussions')!;
    const discussionsEmpty = root.querySelector<HTMLElement>('#mr-discussions-empty')!;
    expect(root.querySelector<HTMLButtonElement>('#mr-tab-discussions')!.getAttribute('aria-selected')).toBe('true');
    expect(discussionsPanel.hidden).toBe(false);
    expect(discussionsEmpty.hidden).toBe(false);
    expect(discussionsEmpty.textContent?.trim().length).toBeGreaterThan(0);

    const selectedPipelineActivity: MergeRequestActivitySnapshot = {
      ...emptyActivity,
      pipelines: collection<GitLabPipeline>({ status: 'ready', rows: [pipelineFixture], committedPage: 1 }),
      selectedPipelineId: pipelineFixture.id,
      jobs: collection<GitLabJob>({ status: 'ready', committedPage: 1 }),
    };
    workspace!.render(panelState({ mergeRequestActivity: selectedPipelineActivity }));
    const jobsEmpty = root.querySelector<HTMLElement>('#mr-jobs-empty')!;
    expect(jobsEmpty.hidden).toBe(false);
    expect(jobsEmpty.textContent?.trim().length).toBeGreaterThan(0);

    const cappedActivity: MergeRequestActivitySnapshot = {
      ...selectedPipelineActivity,
      pipelines: collection<GitLabPipeline>({ status: 'ready', rows: [pipelineFixture], committedPage: 10, truncated: true }),
      jobs: collection<GitLabJob>({ status: 'ready', rows: [jobFixture], committedPage: 10, truncated: true }),
      discussions: collection<GitLabDiscussion>({ status: 'ready', rows: [discussionFixture], committedPage: 10, truncated: true }),
    };
    workspace!.render(panelState({ mergeRequestActivity: cappedActivity }));
    for (const id of ['mr-pipelines-truncated', 'mr-jobs-truncated', 'mr-discussions-truncated']) {
      const message = root.querySelector<HTMLElement>(`#${id}`)!;
      expect(message.hidden).toBe(false);
      expect(message.textContent?.trim().length).toBeGreaterThan(0);
      expect(message.textContent).toContain('page limit');
      expect(message.textContent).toContain('may be available');
    }
  });

  // Retry the failed page, refresh committed results, and safely retry jobs too.
  it('chooses refresh or load-more according to each failed collection page', () => {
    const calls = { pipelineLoadMore: 0, pipelineRefresh: 0, discussionLoadMore: 0, discussionRefresh: 0, jobLoadMore: 0, jobRefresh: 0 };
    const actions = workspaceActions({
      loadMoreMergeRequestPipelines: () => { calls.pipelineLoadMore += 1; },
      refreshMergeRequestPipelines: () => { calls.pipelineRefresh += 1; },
      loadMoreMergeRequestDiscussions: () => { calls.discussionLoadMore += 1; },
      refreshMergeRequestDiscussions: () => { calls.discussionRefresh += 1; },
      loadMoreMergeRequestJobs: () => { calls.jobLoadMore += 1; },
      refreshMergeRequestJobs: () => { calls.jobRefresh += 1; },
    });
    const root = mount(panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        pipelines: collection({ status: 'error', rows: [pipelineFixture], committedPage: 1, error: 'Could not load this activity. Try again.' }),
        discussions: collection({ status: 'error', committedPage: 1, error: 'Could not load this activity. Try again.' }),
        selectedPipelineId: pipelineFixture.id,
        jobs: collection({ status: 'error', committedPage: 1, error: 'Could not load this activity. Try again.' }),
      },
    }), actions);
    root.querySelector<HTMLButtonElement>('#mr-tab-pipelines')!.click();
    root.querySelector<HTMLButtonElement>('#mr-pipelines-retry')!.click();
    root.querySelector<HTMLButtonElement>('#mr-jobs-retry')!.click();
    root.querySelector<HTMLButtonElement>('#mr-tab-discussions')!.click();
    root.querySelector<HTMLButtonElement>('#mr-discussions-retry')!.click();
    expect(calls.pipelineRefresh).toBe(1);
    expect(calls.discussionRefresh).toBe(1);
    expect(calls.jobRefresh).toBe(1);
    workspace!.render(panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        pipelines: collection({ status: 'ready', rows: [pipelineFixture], committedPage: 1 }),
      },
    }));
    expect(root.querySelector('#mr-pipelines-list')!.textContent).toContain('Pipeline #41');

    workspace!.render(panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        pipelines: collection({ status: 'error', rows: [pipelineFixture], committedPage: 1, hasMore: true, error: 'Could not load this activity. Try again.' }),
        discussions: collection({ status: 'error', committedPage: 1, hasMore: true, error: 'Could not load this activity. Try again.' }),
        selectedPipelineId: pipelineFixture.id,
        jobs: collection({ status: 'error', committedPage: 1, hasMore: true, error: 'Could not load this activity. Try again.' }),
      },
    }));
    root.querySelector<HTMLButtonElement>('#mr-tab-pipelines')!.click();
    root.querySelector<HTMLButtonElement>('#mr-pipelines-retry')!.click();
    root.querySelector<HTMLButtonElement>('#mr-jobs-retry')!.click();
    root.querySelector<HTMLButtonElement>('#mr-tab-discussions')!.click();
    root.querySelector<HTMLButtonElement>('#mr-discussions-retry')!.click();
    expect(calls.pipelineLoadMore).toBe(1);
    expect(calls.discussionLoadMore).toBe(1);
    expect(calls.jobLoadMore).toBe(1);
  });

  // Keep external-link focus through list replacement and fall back to its tab if removed.
  it('restores a focused pipeline link after rerender and focuses the tab if it disappears', () => {
    const state = panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        pipelines: collection({ status: 'ready', rows: [pipelineFixture], committedPage: 1 }),
      },
    });
    const root = mount(state);
    const pipelinesTab = root.querySelector<HTMLButtonElement>('#mr-tab-pipelines')!;
    const document = browser!.document as unknown as Document;
    pipelinesTab.click();
    const link = root.querySelector<HTMLAnchorElement>('[data-pipeline-link="41"]')!;
    link.focus();
    workspace!.render(state);
    const replacementLink = root.querySelector<HTMLAnchorElement>('[data-pipeline-link="41"]')!;
    expect(document.activeElement).toBe(replacementLink);

    workspace!.render(panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        pipelines: collection({ status: 'ready', committedPage: 1 }),
      },
    }));
    expect(document.activeElement).toBe(pipelinesTab);
  });

  // Keep focus on a visible tab when a focused link belongs to a replaced scope.
  it('moves focused pipeline-link focus to Overview when the verified activity scope changes', () => {
    const state = panelState({
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        pipelines: collection({ status: 'ready', rows: [pipelineFixture], committedPage: 1 }),
      },
    });
    const root = mount(state);
    const document = browser!.document as unknown as Document;
    const overviewTab = root.querySelector<HTMLButtonElement>('#mr-tab-overview')!;
    const pipelinesTab = root.querySelector<HTMLButtonElement>('#mr-tab-pipelines')!;
    pipelinesTab.click();
    const oldPipelineLink = root.querySelector<HTMLAnchorElement>('[data-pipeline-link="41"]')!;
    oldPipelineLink.focus();

    const nextRequest: GitLabMergeRequest = {
      ...request,
      id: 124,
      iid: 6,
      title: 'A different verified merge request',
      webUrl: 'https://gitlab.example/group/project/-/merge_requests/6',
    };
    const nextScope = {
      ...activityScope,
      mergeRequestId: nextRequest.id,
      iid: nextRequest.iid,
      webUrl: nextRequest.webUrl,
      revision: 2,
    };
    workspace!.render(panelState({
      workspaceRoute: { kind: 'merge-request-detail', iid: nextRequest.iid, origin: 'browse' },
      mergeRequestBrowser: {
        ...panelState().mergeRequestBrowser,
        selectedIid: nextRequest.iid,
        detail: nextRequest,
      },
      mergeRequestOverview: nextRequest,
      mergeRequestActivity: {
        ...panelState().mergeRequestActivity,
        scope: nextScope,
        pipelines: collection({ status: 'ready', committedPage: 1 }),
      },
    }));

    expect(overviewTab.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector<HTMLElement>('#mr-panel-overview')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('#mr-panel-pipelines')!.hidden).toBe(true);
    expect(root.querySelector('#mr-pipelines-list')!.querySelector('[data-pipeline-link="41"]')).toBeNull();
    expect(document.activeElement).toBe(overviewTab);
  });
});
