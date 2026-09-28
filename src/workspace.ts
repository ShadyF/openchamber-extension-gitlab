import type { PanelActions, PanelState } from './panel.js';
import type { MergeRequestBrowseScope } from './merge-request-browser.js';
import type { GitLabDiscussion, GitLabDiscussionNote } from './gitlab.js';

export interface WorkspaceActions extends Pick<PanelActions,
  | 'remove'
  | 'loadIssues'
  | 'loadMoreIssues'
  | 'selectIssue'
  | 'backToIssues'
  | 'retryIssues'
  | 'retryIssue'
  | 'selectWorkType'
  | 'searchMergeRequests'
  | 'refreshMergeRequests'
  | 'refreshSessionFocus'
  | 'loadMoreMergeRequests'
  | 'selectMergeRequest'
   | 'backToMergeRequests'
   | 'retryMergeRequest'
   | 'startIssueWorktree'
   | 'loadMergeRequestPipelines'
   | 'loadMoreMergeRequestPipelines'
   | 'refreshMergeRequestPipelines'
   | 'loadMergeRequestDiscussions'
   | 'loadMoreMergeRequestDiscussions'
   | 'refreshMergeRequestDiscussions'
   | 'selectMergeRequestPipeline'
   | 'loadMoreMergeRequestJobs'
   | 'refreshMergeRequestJobs'> {
  changeProject(): void;
}

export interface WorkspaceState extends PanelState {
  changingProject: boolean;
}

export function createWorkspace(root: HTMLElement, actions: WorkspaceActions): { render(state: WorkspaceState): void; destroy(): void } {
  root.innerHTML = `
    <section id="repo-strip" class="mapping mapping-compact repo-strip" aria-label="Associated GitLab project and local repository">
      <div class="repo-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="association repo-copy" aria-label="GitLab project association">
        <div class="section-label visually-hidden" id="association-label">GitLab project</div>
        <strong id="association-value" tabindex="-1"></strong>
        <div class="mapping-repository"><span id="repository-label" class="visually-hidden">Local repository</span><span>Associated with local repository </span><strong id="repository-value"></strong></div>
      </div>
      <p id="save-hint" class="scope-note" hidden></p>
      <div class="mapping-actions">
        <button id="change-button" class="quiet-button" type="button" aria-expanded="false" aria-controls="project-picker">Change</button>
        <span id="remove-slot"></span>
      </div>
    </section>
    <section id="issues-view" class="issues-view" aria-labelledby="workspace-title" hidden>
      <div class="workspace-heading-row">
        <h2 id="workspace-title">GitLab work</h2>
        <button id="refresh-issues-button" class="quiet-button" type="button">Refresh</button>
        <button id="refresh-merge-requests-button" class="quiet-button" type="button" hidden>Refresh</button>
      </div>
      <div class="work-type-bar" aria-label="Work type">
        <button id="issues-heading" class="work-type-button" type="button">Issues</button>
        <button id="merge-requests-heading" class="work-type-button" type="button">Merge requests</button>
      </div>
      <div id="issues-list-surface">
        <div class="queue-heading"><strong>Updated</strong><span><span id="issues-count" class="issues-count"></span> · Newest first</span></div>
        <p id="issues-status" class="issues-status" role="status" aria-live="polite"></p>
        <div id="issues-error" class="error-box" role="alert" hidden><span id="issues-error-text"></span><button id="retry-issues-button" class="quiet-button" type="button">Retry</button></div>
        <div id="issues-list" class="issues-list" role="list"></div>
        <p id="issues-empty" class="issues-empty" hidden>No open issues in this project.</p>
        <button id="load-more-issues-button" class="quiet-button load-more-button" type="button" hidden>Load more issues</button>
      </div>
      <div id="merge-requests-list-surface" hidden>
        <form id="merge-request-search-form" class="merge-request-search" role="search">
          <input id="merge-request-search" class="project-search" type="search" aria-label="Search merge requests" placeholder="Search merge requests" autocomplete="off">
          <button id="search-merge-requests-button" class="quiet-button" type="submit">Search</button>
        </form>
        <div class="queue-heading"><strong>Updated</strong><span><span id="merge-requests-count" class="issues-count"></span> · Newest first</span></div>
        <p id="merge-requests-status" class="issues-status" role="status" aria-live="polite"></p>
        <div id="merge-requests-error" class="error-box" role="alert" hidden><span id="merge-requests-error-text"></span><button id="retry-merge-requests-button" class="quiet-button" type="button">Retry</button></div>
        <div id="merge-requests-list" class="issues-list" role="list"></div>
        <p id="merge-requests-empty" class="issues-empty" hidden></p>
        <button id="load-more-merge-requests-button" class="quiet-button load-more-button" type="button" hidden>Load more merge requests</button>
      </div>
    </section>
    <section id="session-link-status" class="session-link-status" aria-labelledby="session-link-status-message" hidden>
      <p id="session-link-status-message" class="session-link-status-message" role="status" aria-live="polite" tabindex="-1"></p>
      <button id="refresh-session-link" class="quiet-button" type="button" aria-label="Refresh session link">Refresh</button>
    </section>
    <article id="issue-detail" class="issue-detail" aria-labelledby="issue-heading" tabindex="-1" hidden>
      <div class="issue-detail-nav"><button id="back-to-issues" class="quiet-button back-button" type="button">← Back to issues</button><div class="issue-detail-actions"><span id="issue-reference" class="issue-reference"></span><button id="refresh-issue-context" class="quiet-button session-refresh-button" type="button" aria-label="Refresh session context" hidden>Refresh</button></div></div>
      <p id="issue-detail-status" class="issues-status" role="status" aria-live="polite"></p>
      <div id="issue-detail-error" class="error-box" role="alert" hidden><span id="issue-detail-error-text"></span><button id="retry-issue-button" class="quiet-button" type="button">Retry</button></div>
      <div id="issue-content" hidden>
        <div class="issue-state-row"><span id="issue-state" class="issue-state"></span><time id="issue-updated"></time></div>
        <h2 id="issue-heading" tabindex="-1"></h2>
        <p id="issue-description" class="issue-description"></p>
        <p id="worktree-blocker" class="worktree-blocker" hidden>Open in new worktree is available only for registered OpenChamber projects.</p>
        <button id="start-worktree-button" class="primary-button start-worktree-button" type="button" hidden>Open in new worktree</button>
        <p id="worktree-status" class="worktree-status" role="status" aria-live="polite" tabindex="-1"></p>
        <p id="worktree-error" class="worktree-error" role="alert" hidden></p>
      </div>
    </article>
    <article id="merge-request-detail" class="issue-detail" aria-labelledby="merge-request-heading" tabindex="-1" hidden>
      <div class="issue-detail-nav"><button id="back-to-merge-requests" class="quiet-button back-button" type="button">Back to merge requests</button><div class="issue-detail-actions"><span id="merge-request-reference" class="issue-reference"></span><button id="refresh-merge-request-context" class="quiet-button session-refresh-button" type="button" aria-label="Refresh session context" hidden>Refresh</button></div></div>
      <p id="merge-request-detail-label" class="detail-type-label"></p>
      <p id="merge-request-related-caution" class="merge-request-related-caution" hidden></p>
      <p id="merge-request-detail-status" class="issues-status" role="status" aria-live="polite"></p>
      <div id="merge-request-detail-error" class="error-box" role="alert" hidden><span id="merge-request-detail-error-text"></span><button id="retry-merge-request-button" class="quiet-button" type="button">Retry</button></div>
      <div id="merge-request-content" hidden>
        <div id="merge-request-tabs" class="merge-request-tabs" role="tablist" aria-label="Merge request detail" hidden>
          <button id="mr-tab-overview" class="merge-request-tab" type="button" role="tab" aria-controls="mr-panel-overview" aria-selected="true" tabindex="0">Overview</button>
          <button id="mr-tab-pipelines" class="merge-request-tab" type="button" role="tab" aria-controls="mr-panel-pipelines" aria-selected="false" tabindex="-1">Pipelines &amp; jobs</button>
          <button id="mr-tab-discussions" class="merge-request-tab" type="button" role="tab" aria-controls="mr-panel-discussions" aria-selected="false" tabindex="-1">Discussions</button>
        </div>
        <section id="mr-panel-overview" class="merge-request-tabpanel" aria-labelledby="mr-tab-overview" tabindex="0">
          <div class="issue-state-row"><span id="merge-request-state" class="issue-state"></span><time id="merge-request-updated"></time></div>
          <h2 id="merge-request-heading" tabindex="-1"></h2>
          <p id="merge-request-branches" class="merge-request-branches" hidden></p>
          <p id="merge-request-description" class="issue-description"></p>
          <a id="merge-request-web-url" class="merge-request-web-url" target="_blank" rel="noopener noreferrer"></a>
        </section>
        <section id="mr-panel-pipelines" class="merge-request-tabpanel" aria-labelledby="mr-tab-pipelines" tabindex="0" hidden>
          <div class="activity-section-heading"><h3>Pipelines</h3><button id="mr-pipelines-refresh" class="quiet-button" type="button" hidden>Refresh</button></div>
          <p id="mr-pipelines-status" class="activity-status" role="status" aria-live="polite" hidden></p>
          <div id="mr-pipelines-error" class="error-box activity-error" role="alert" hidden><span id="mr-pipelines-error-text"></span><button id="mr-pipelines-retry" class="quiet-button" type="button">Retry</button></div>
          <div id="mr-pipelines-list" class="activity-list" role="list"></div>
          <p id="mr-pipelines-empty" class="activity-empty" role="status" aria-live="polite" hidden>No pipelines were returned for this merge request.</p>
          <p id="mr-pipelines-truncated" class="activity-note" hidden>The pipeline list reached its page limit; more results may be available.</p>
          <button id="mr-pipelines-load-more" class="quiet-button load-more-button" type="button" hidden>Load more pipelines</button>
          <section id="mr-jobs-section" class="pipeline-jobs" aria-labelledby="mr-jobs-heading" hidden>
            <div class="activity-section-heading"><h3 id="mr-jobs-heading">Jobs</h3><button id="mr-jobs-refresh" class="quiet-button" type="button" hidden>Refresh jobs</button></div>
            <p id="mr-jobs-status" class="activity-status" role="status" aria-live="polite" hidden></p>
            <div id="mr-jobs-error" class="error-box activity-error" role="alert" hidden><span id="mr-jobs-error-text"></span><button id="mr-jobs-retry" class="quiet-button" type="button">Retry</button></div>
            <div id="mr-jobs-list" class="activity-list" role="list"></div>
            <p id="mr-jobs-empty" class="activity-empty" role="status" aria-live="polite" hidden>No jobs were returned for this pipeline.</p>
            <p id="mr-jobs-truncated" class="activity-note" hidden>The job list reached its page limit; more results may be available.</p>
            <button id="mr-jobs-load-more" class="quiet-button load-more-button" type="button" hidden>Load more jobs</button>
          </section>
        </section>
        <section id="mr-panel-discussions" class="merge-request-tabpanel" aria-labelledby="mr-tab-discussions" tabindex="0" hidden>
          <div class="activity-section-heading"><h3>Discussions</h3><button id="mr-discussions-refresh" class="quiet-button" type="button" hidden>Refresh</button></div>
          <p id="mr-discussions-status" class="activity-status" role="status" aria-live="polite" hidden></p>
          <div id="mr-discussions-error" class="error-box activity-error" role="alert" hidden><span id="mr-discussions-error-text"></span><button id="mr-discussions-retry" class="quiet-button" type="button">Retry</button></div>
          <div id="mr-discussions-list" class="discussion-list" role="list"></div>
          <p id="mr-discussions-empty" class="activity-empty" role="status" aria-live="polite" hidden>No discussion threads were returned for this merge request.</p>
          <p id="mr-discussions-truncated" class="activity-note" hidden>The discussion list reached its page limit; more results may be available.</p>
          <button id="mr-discussions-load-more" class="quiet-button load-more-button" type="button" hidden>Load more discussions</button>
        </section>
      </div>
    </article>`;

  const get = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const mappingActions = root.querySelector<HTMLElement>('.mapping-actions')!;
  const associationLabel = get<HTMLElement>('association-label');
  const associationValue = get<HTMLElement>('association-value');
  const repositoryLabel = get<HTMLElement>('repository-label');
  const repository = get<HTMLElement>('repository-value');
  const scopeNote = get<HTMLElement>('save-hint');
  const changeButton = get<HTMLButtonElement>('change-button');
  const removeSlot = get<HTMLElement>('remove-slot');
  const removeButton = document.createElement('button');
  removeButton.id = 'remove-button';
  removeButton.type = 'button';
  removeButton.className = 'quiet-button';
  removeSlot.append(removeButton);
  const issuesView = get<HTMLElement>('issues-view');
  const issuesChoice = get<HTMLButtonElement>('issues-heading');
  const mergeRequestsChoice = get<HTMLButtonElement>('merge-requests-heading');
  const issuesListSurface = get<HTMLElement>('issues-list-surface');
  const mergeRequestsListSurface = get<HTMLElement>('merge-requests-list-surface');
  const issuesCount = get<HTMLElement>('issues-count');
  const refreshIssuesButton = get<HTMLButtonElement>('refresh-issues-button');
  const refreshMergeRequestsButton = get<HTMLButtonElement>('refresh-merge-requests-button');
  const issuesStatus = get<HTMLElement>('issues-status');
  const issuesError = get<HTMLElement>('issues-error');
  const issuesErrorText = get<HTMLElement>('issues-error-text');
  const retryIssuesButton = get<HTMLButtonElement>('retry-issues-button');
  const issuesList = get<HTMLElement>('issues-list');
  const issuesEmpty = get<HTMLElement>('issues-empty');
  const loadMoreIssuesButton = get<HTMLButtonElement>('load-more-issues-button');
  const mergeRequestSearchForm = get<HTMLFormElement>('merge-request-search-form');
  const mergeRequestSearch = get<HTMLInputElement>('merge-request-search');
  const mergeRequestsCount = get<HTMLElement>('merge-requests-count');
  const mergeRequestsStatus = get<HTMLElement>('merge-requests-status');
  const mergeRequestsError = get<HTMLElement>('merge-requests-error');
  const mergeRequestsErrorText = get<HTMLElement>('merge-requests-error-text');
  const retryMergeRequestsButton = get<HTMLButtonElement>('retry-merge-requests-button');
  const mergeRequestsList = get<HTMLElement>('merge-requests-list');
  const mergeRequestsEmpty = get<HTMLElement>('merge-requests-empty');
  const loadMoreMergeRequestsButton = get<HTMLButtonElement>('load-more-merge-requests-button');
  const issueDetail = get<HTMLElement>('issue-detail');
  const sessionLinkStatus = get<HTMLElement>('session-link-status');
  const sessionLinkStatusMessage = get<HTMLElement>('session-link-status-message');
  const refreshSessionLinkButton = get<HTMLButtonElement>('refresh-session-link');
  const backToIssuesButton = get<HTMLButtonElement>('back-to-issues');
  const refreshIssueContextButton = get<HTMLButtonElement>('refresh-issue-context');
  const issueReference = get<HTMLElement>('issue-reference');
  const issueDetailStatus = get<HTMLElement>('issue-detail-status');
  const issueDetailError = get<HTMLElement>('issue-detail-error');
  const issueDetailErrorText = get<HTMLElement>('issue-detail-error-text');
  const retryIssueButton = get<HTMLButtonElement>('retry-issue-button');
  const issueContent = get<HTMLElement>('issue-content');
  const issueState = get<HTMLElement>('issue-state');
  const issueUpdated = get<HTMLTimeElement>('issue-updated');
  const issueHeading = get<HTMLElement>('issue-heading');
  const issueDescription = get<HTMLElement>('issue-description');
  const worktreeBlocker = get<HTMLElement>('worktree-blocker');
  const startWorktreeButton = get<HTMLButtonElement>('start-worktree-button');
  const worktreeStatus = get<HTMLElement>('worktree-status');
  const worktreeError = get<HTMLElement>('worktree-error');
  const mergeRequestDetail = get<HTMLElement>('merge-request-detail');
  const backToMergeRequestsButton = get<HTMLButtonElement>('back-to-merge-requests');
  const refreshMergeRequestContextButton = get<HTMLButtonElement>('refresh-merge-request-context');
  const mergeRequestReference = get<HTMLElement>('merge-request-reference');
  const mergeRequestDetailLabel = get<HTMLElement>('merge-request-detail-label');
  const mergeRequestRelatedCaution = get<HTMLElement>('merge-request-related-caution');
  const mergeRequestDetailStatus = get<HTMLElement>('merge-request-detail-status');
  const mergeRequestDetailError = get<HTMLElement>('merge-request-detail-error');
  const mergeRequestDetailErrorText = get<HTMLElement>('merge-request-detail-error-text');
  const retryMergeRequestButton = get<HTMLButtonElement>('retry-merge-request-button');
  const mergeRequestContent = get<HTMLElement>('merge-request-content');
  const mergeRequestState = get<HTMLElement>('merge-request-state');
  const mergeRequestUpdated = get<HTMLTimeElement>('merge-request-updated');
  const mergeRequestHeading = get<HTMLElement>('merge-request-heading');
  const mergeRequestBranches = get<HTMLElement>('merge-request-branches');
  const mergeRequestDescription = get<HTMLElement>('merge-request-description');
  const mergeRequestWebUrl = get<HTMLAnchorElement>('merge-request-web-url');
  const mergeRequestTabs = get<HTMLElement>('merge-request-tabs');
  const mergeRequestTabButtons = {
    overview: get<HTMLButtonElement>('mr-tab-overview'),
    pipelines: get<HTMLButtonElement>('mr-tab-pipelines'),
    discussions: get<HTMLButtonElement>('mr-tab-discussions'),
  };
  const mergeRequestTabPanels = {
    overview: get<HTMLElement>('mr-panel-overview'),
    pipelines: get<HTMLElement>('mr-panel-pipelines'),
    discussions: get<HTMLElement>('mr-panel-discussions'),
  };
  const pipelinesStatus = get<HTMLElement>('mr-pipelines-status');
  const pipelinesError = get<HTMLElement>('mr-pipelines-error');
  const pipelinesErrorText = get<HTMLElement>('mr-pipelines-error-text');
  const pipelinesRetryButton = get<HTMLButtonElement>('mr-pipelines-retry');
  const pipelinesRefreshButton = get<HTMLButtonElement>('mr-pipelines-refresh');
  const pipelinesList = get<HTMLElement>('mr-pipelines-list');
  const pipelinesEmpty = get<HTMLElement>('mr-pipelines-empty');
  const pipelinesTruncated = get<HTMLElement>('mr-pipelines-truncated');
  const pipelinesLoadMoreButton = get<HTMLButtonElement>('mr-pipelines-load-more');
  const jobsSection = get<HTMLElement>('mr-jobs-section');
  const jobsStatus = get<HTMLElement>('mr-jobs-status');
  const jobsError = get<HTMLElement>('mr-jobs-error');
  const jobsErrorText = get<HTMLElement>('mr-jobs-error-text');
  const jobsRetryButton = get<HTMLButtonElement>('mr-jobs-retry');
  const jobsRefreshButton = get<HTMLButtonElement>('mr-jobs-refresh');
  const jobsList = get<HTMLElement>('mr-jobs-list');
  const jobsEmpty = get<HTMLElement>('mr-jobs-empty');
  const jobsTruncated = get<HTMLElement>('mr-jobs-truncated');
  const jobsLoadMoreButton = get<HTMLButtonElement>('mr-jobs-load-more');
  const discussionsStatus = get<HTMLElement>('mr-discussions-status');
  const discussionsError = get<HTMLElement>('mr-discussions-error');
  const discussionsErrorText = get<HTMLElement>('mr-discussions-error-text');
  const discussionsRetryButton = get<HTMLButtonElement>('mr-discussions-retry');
  const discussionsRefreshButton = get<HTMLButtonElement>('mr-discussions-refresh');
  const discussionsList = get<HTMLElement>('mr-discussions-list');
  const discussionsEmpty = get<HTMLElement>('mr-discussions-empty');
  const discussionsTruncated = get<HTMLElement>('mr-discussions-truncated');
  const discussionsLoadMoreButton = get<HTMLButtonElement>('mr-discussions-load-more');
  let current: WorkspaceState | null = null;
  let actionFocusPending = false;
  let removeFocusPending = false;
  let detailFocusPending = false;
  let listFocusIid: number | null = null;
  let mergeRequestListFocusIid: number | null = null;
  let focusedSessionIssueIid: number | null = null;
  let mergeRequestDetailFocusPending = false;
  let sessionRefreshFocusPending = false;
  let mergeRequestDraft = '';
  let mergeRequestSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let renderedMergeRequestScope: MergeRequestBrowseScope | null = null;
  type MergeRequestTab = keyof typeof mergeRequestTabButtons;
  let activeMergeRequestTab: MergeRequestTab = 'overview';
  let mergeRequestTabIdentity: string | null = null;
  const requestedMergeRequestTabs = new Set<MergeRequestTab>();
  let pipelineRowFocusId: number | null = null;

  // Match both the revision and project identity so an earlier search cannot cross scopes.
  const sameMergeRequestScope = (left: MergeRequestBrowseScope | null, right: MergeRequestBrowseScope | null): boolean =>
    left !== null && right !== null
    && left.revision === right.revision && left.directory === right.directory
    && left.localProjectId === right.localProjectId && left.accountId === right.accountId
    && left.variant === right.variant && left.projectId === right.projectId;

  // Match route-specific session fields before exposing any activity records.
  const activityScopeMatchesRoute = (
    route: Extract<PanelState['workspaceRoute'], { kind: 'merge-request-detail' }>,
    scope: NonNullable<PanelState['mergeRequestActivity']['scope']>,
  ): boolean => route.origin === 'browse'
    || (route.origin === 'explicit-session' && scope.sessionId === route.sessionId)
    || (route.origin === 'related-issue' && scope.sessionId === route.sessionId && scope.issueIid === route.issueIid);

  // Expose activity only when overview and activity share the verified route identity.
  const currentMergeRequestActivityContext = () => {
    const state = current;
    if (!state?.association || state.error || state.changingProject
      || state.sessionFocus.kind === 'checking' || state.sessionFocus.kind === 'explicit-unavailable'
      || state.workspaceRoute.kind !== 'merge-request-detail') return null;
    const route = state.workspaceRoute;
    const overview = state.mergeRequestOverview;
    const scope = state.mergeRequestActivity.scope;
    if (!overview || !scope || !activityScopeMatchesRoute(route, scope)) return null;
    const sameMergeRequest = overview.iid === route.iid && overview.id === scope.mergeRequestId
      && overview.projectId === scope.targetProjectId && overview.targetProjectId === scope.targetProjectId
      && overview.webUrl === scope.webUrl && scope.iid === route.iid && scope.origin === route.origin;
    if (!sameMergeRequest || (route.origin === 'browse'
      && (state.mergeRequestBrowser.detailLoading || state.mergeRequestBrowser.detailError))) return null;
    return { overview, scope, identity: JSON.stringify([route, scope]) };
  };

  // Keep tab semantics and visible panel content in sync with the local presentation choice.
  const syncMergeRequestTabPresentation = (available: boolean) => {
    mergeRequestTabs.hidden = !available;
    for (const tab of Object.keys(mergeRequestTabButtons) as MergeRequestTab[]) {
      const button = mergeRequestTabButtons[tab];
      const panel = mergeRequestTabPanels[tab];
      const selected = available && activeMergeRequestTab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      panel.hidden = tab === 'overview' ? available && !selected : !selected;
      if (available) {
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', button.id);
        panel.tabIndex = 0;
      } else if (tab === 'overview') {
        panel.removeAttribute('role');
        panel.removeAttribute('aria-labelledby');
        panel.removeAttribute('tabindex');
      }
    }
  };

  // Load each activity section only after the user activates its matching tab.
  const requestMergeRequestTab = (tab: MergeRequestTab) => {
    const context = currentMergeRequestActivityContext();
    if (!context || context.identity !== mergeRequestTabIdentity || requestedMergeRequestTabs.has(tab)) return;
    const activity = current!.mergeRequestActivity;
    if (tab === 'pipelines' && activity.pipelines.status === 'idle') {
      requestedMergeRequestTabs.add(tab);
      actions.loadMergeRequestPipelines();
    } else if (tab === 'discussions' && activity.discussions.status === 'idle') {
      requestedMergeRequestTabs.add(tab);
      actions.loadMergeRequestDiscussions();
    }
  };

  // Move focus with the tablist pattern and activate only verified activity sections.
  const activateMergeRequestTab = (tab: MergeRequestTab, moveFocus: boolean) => {
    const context = currentMergeRequestActivityContext();
    if (!context || context.identity !== mergeRequestTabIdentity) return;
    const changed = activeMergeRequestTab !== tab;
    activeMergeRequestTab = tab;
    syncMergeRequestTabPresentation(true);
    if (moveFocus) mergeRequestTabButtons[tab].focus();
    if (changed) requestMergeRequestTab(tab);
  };

  // Activate a selected tab only when its verified tablist receives a click.
  const onMergeRequestTabClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role="tab"]') : null;
    if (!target || !mergeRequestTabs.contains(target)) return;
    const tab = (Object.keys(mergeRequestTabButtons) as MergeRequestTab[])
      .find((key) => mergeRequestTabButtons[key] === target);
    if (tab) activateMergeRequestTab(tab, false);
  };

  // Use standard arrow and edge keys so the three read-only sections work without a mouse.
  const onMergeRequestTabKeydown = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role="tab"]') : null;
    if (!target || !mergeRequestTabs.contains(target)) return;
    const tabs = Object.keys(mergeRequestTabButtons) as MergeRequestTab[];
    const currentIndex = tabs.findIndex((tab) => mergeRequestTabButtons[tab] === target);
    let nextIndex: number;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    activateMergeRequestTab(tabs[nextIndex], true);
  };

  // Let each pipeline row select its validated owner without nesting links in buttons.
  const onPipelineListClick = (event: MouseEvent) => {
    const context = currentMergeRequestActivityContext();
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-pipeline-id]') : null;
    if (!context || context.identity !== mergeRequestTabIdentity || activeMergeRequestTab !== 'pipelines'
      || !target || !pipelinesList.contains(target)) return;
    const pipelineId = Number(target.dataset.pipelineId);
    if (!Number.isSafeInteger(pipelineId) || pipelineId <= 0) return;
    pipelineRowFocusId = pipelineId;
    const selectedId = current!.mergeRequestActivity.selectedPipelineId;
    actions.selectMergeRequestPipeline(selectedId === pipelineId ? null : pipelineId);
  };

  // Continue failed pagination when possible, restart committed results, or load the first page.
  const onRetryPipelines = () => {
    if (!currentMergeRequestActivityContext()) return;
    const collection = current!.mergeRequestActivity.pipelines;
    if (collection.committedPage > 0) {
      if (collection.hasMore) actions.loadMoreMergeRequestPipelines();
      else actions.refreshMergeRequestPipelines();
    } else actions.loadMergeRequestPipelines();
  };
  const onRefreshPipelines = () => {
    if (currentMergeRequestActivityContext()) actions.refreshMergeRequestPipelines();
  };
  const onLoadMorePipelines = () => {
    if (currentMergeRequestActivityContext()) actions.loadMoreMergeRequestPipelines();
  };
  const onRetryDiscussions = () => {
    if (!currentMergeRequestActivityContext()) return;
    const collection = current!.mergeRequestActivity.discussions;
    if (collection.committedPage > 0) {
      if (collection.hasMore) actions.loadMoreMergeRequestDiscussions();
      else actions.refreshMergeRequestDiscussions();
    } else actions.loadMergeRequestDiscussions();
  };
  const onRefreshDiscussions = () => {
    if (currentMergeRequestActivityContext()) actions.refreshMergeRequestDiscussions();
  };
  const onLoadMoreDiscussions = () => {
    if (currentMergeRequestActivityContext()) actions.loadMoreMergeRequestDiscussions();
  };
  const onRetryJobs = () => {
    if (!currentMergeRequestActivityContext()) return;
    const collection = current!.mergeRequestActivity.jobs;
    if (collection.committedPage > 0 && collection.hasMore) actions.loadMoreMergeRequestJobs();
    else actions.refreshMergeRequestJobs();
  };
  const onRefreshJobs = () => {
    if (currentMergeRequestActivityContext()) actions.refreshMergeRequestJobs();
  };
  const onLoadMoreJobs = () => {
    if (currentMergeRequestActivityContext()) actions.loadMoreMergeRequestJobs();
  };

  const visibleMergeRequestScope = (): MergeRequestBrowseScope | null => {
    if (!current?.association || current.error || current.changingProject
      || current.sessionFocus.kind === 'checking' || current.sessionFocus.kind === 'explicit-unavailable'
      || current.workspaceRoute.kind !== 'merge-requests-list') return null;
    return current.mergeRequestBrowser.scope;
  };

  const cancelMergeRequestSearch = () => {
    if (mergeRequestSearchTimer) clearTimeout(mergeRequestSearchTimer);
    mergeRequestSearchTimer = null;
  };

  // Format provider timestamps for reading while preserving malformed values as plain text.
  const formatUpdatedAt = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return value;
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  };

  // Use only validated HTTPS links from GitLab's parsed display models.
  const createGitLabLink = (url: string, label: string, className: string, accessibleLabel: string): HTMLAnchorElement | null => {
    let safeUrl: URL;
    try {
      safeUrl = new URL(url);
    } catch {
      return null;
    }
    if (safeUrl.protocol !== 'https:' || safeUrl.username || safeUrl.password) return null;
    const link = document.createElement('a');
    link.className = className;
    link.href = safeUrl.toString();
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    link.setAttribute('aria-label', accessibleLabel);
    return link;
  };

  // Keep collection messages distinct so an unavailable endpoint never looks empty.
  const activityStatusMessage = (status: string, loadingMore: boolean, label: string): string => {
    if (loadingMore) return `Loading more ${label}…`;
    if (status === 'loading') return `Loading ${label}…`;
    if (status === 'idle') return `${label[0].toUpperCase()}${label.slice(1)} have not been loaded yet.`;
    if (status === 'unavailable') return `GitLab did not make ${label} data available.`;
    return '';
  };

  // Render real pipeline fields and preserve row or link focus on updates.
  const renderPipelineRows = (activity: PanelState['mergeRequestActivity'], tabsAvailable: boolean) => {
    const focusedRow = document.activeElement instanceof HTMLElement && pipelinesList.contains(document.activeElement)
      ? document.activeElement.closest<HTMLElement>('[data-pipeline-focus-id]') : null;
    const focusedPipelineId = focusedRow ? Number(focusedRow.dataset.pipelineFocusId) : null;
    const focusedPipelineLinkId = document.activeElement instanceof HTMLAnchorElement
      && pipelinesList.contains(document.activeElement) ? Number(document.activeElement.dataset.pipelineLink) : null;
    pipelinesList.replaceChildren();

    // Build each accessible row without parsing any provider value as markup.
    for (const pipeline of activity.pipelines.rows) {
      const item = document.createElement('div');
      item.className = 'activity-list-item';
      item.setAttribute('role', 'listitem');
      const selection = document.createElement('button');
      selection.className = 'activity-row-select';
      selection.type = 'button';
      selection.dataset.pipelineId = String(pipeline.id);
      selection.dataset.pipelineFocusId = String(pipeline.id);
      selection.setAttribute('aria-pressed', String(activity.selectedPipelineId === pipeline.id));
      const title = document.createElement('span');
      title.className = 'activity-row-title';
      const identifier = document.createElement('strong');
      identifier.textContent = `Pipeline #${pipeline.id}`;
      const status = document.createElement('span');
      status.className = 'activity-state';
      status.textContent = pipeline.status || 'Status unavailable';
      title.append(identifier, status);
      const details = document.createElement('span');
      details.className = 'activity-row-meta';
      if (pipeline.ref) {
        const reference = document.createElement('span');
        reference.textContent = `Ref: ${pipeline.ref}`;
        details.append(reference);
      }
      const timestamp = pipeline.updatedAt ? ['Updated', pipeline.updatedAt]
        : pipeline.finishedAt ? ['Finished', pipeline.finishedAt]
          : pipeline.startedAt ? ['Started', pipeline.startedAt]
            : pipeline.createdAt ? ['Created', pipeline.createdAt] : null;
      if (timestamp) {
        const time = document.createElement('time');
        time.dateTime = timestamp[1];
        time.textContent = `${timestamp[0]} ${formatUpdatedAt(timestamp[1])}`;
        details.append(time);
      }
      selection.append(title, details);
      item.append(selection);
      const link = pipeline.webUrl
        ? createGitLabLink(pipeline.webUrl, 'Open in GitLab', 'activity-external-link', `Open pipeline #${pipeline.id} in GitLab`)
        : null;
      if (link) {
        link.dataset.pipelineLink = String(pipeline.id);
        item.append(link);
      }
      pipelinesList.append(item);
    }

    // Restore focused row or link controls, and keep focus visible after a scope change.
    const focusId = pipelineRowFocusId ?? focusedPipelineId ?? focusedPipelineLinkId;
    if (focusId !== null && Number.isSafeInteger(focusId)) {
      if (tabsAvailable && activeMergeRequestTab === 'pipelines') {
        const link = focusedPipelineLinkId === focusId
          ? pipelinesList.querySelector<HTMLAnchorElement>(`[data-pipeline-link="${focusId}"]`) : null;
        const target = link ?? pipelinesList.querySelector<HTMLButtonElement>(`[data-pipeline-focus-id="${focusId}"]`);
        (target ?? mergeRequestTabButtons.pipelines).focus();
      } else if (focusedPipelineId !== null || focusedPipelineLinkId !== null) {
        (tabsAvailable ? mergeRequestTabButtons[activeMergeRequestTab] : mergeRequestDetail).focus();
      }
    }
    pipelineRowFocusId = null;
  };

  // Show jobs only for the selected pipeline and never guess a missing project owner.
  const renderPipelineJobs = (activity: PanelState['mergeRequestActivity']) => {
    const pipeline = activity.pipelines.rows.find((row) => row.id === activity.selectedPipelineId) ?? null;
    const ownerAvailable = pipeline !== null && pipeline.projectId !== null
      && Number.isSafeInteger(pipeline.projectId) && pipeline.projectId > 0;
    jobsSection.hidden = !pipeline;
    jobsList.replaceChildren();
    if (!pipeline) return;
    if (!ownerAvailable) {
      jobsStatus.textContent = 'GitLab did not identify this pipeline’s project, so its jobs cannot be loaded safely.';
      jobsStatus.hidden = false;
      jobsError.hidden = true;
      jobsRefreshButton.hidden = true;
      jobsLoadMoreButton.hidden = true;
      jobsEmpty.hidden = true;
      jobsTruncated.hidden = true;
      return;
    }

    // Render actual job fields while keeping provider values as text.
    for (const job of activity.jobs.rows) {
      const item = document.createElement('div');
      item.className = 'activity-list-item job-list-item';
      item.setAttribute('role', 'listitem');
      const details = document.createElement('div');
      details.className = 'job-row';
      const name = document.createElement('strong');
      name.className = 'job-name';
      name.textContent = job.name;
      const status = document.createElement('span');
      status.className = 'activity-state';
      status.textContent = job.status;
      details.append(name, status);
      if (job.stage) {
        const stage = document.createElement('span');
        stage.className = 'job-stage';
        stage.textContent = `Stage: ${job.stage}`;
        details.append(stage);
      }
      const timestamp = job.finishedAt ? ['Finished', job.finishedAt]
        : job.startedAt ? ['Started', job.startedAt]
          : job.createdAt ? ['Created', job.createdAt] : null;
      if (timestamp) {
        const time = document.createElement('time');
        time.dateTime = timestamp[1];
        time.textContent = `${timestamp[0]} ${formatUpdatedAt(timestamp[1])}`;
        details.append(time);
      }
      item.append(details);
      const link = job.webUrl
        ? createGitLabLink(job.webUrl, 'Open in GitLab', 'activity-external-link', `Open job ${job.name} in GitLab`)
        : null;
      if (link) item.append(link);
      jobsList.append(item);
    }

    const collection = activity.jobs;
    // Keep job retries and pagination tied to this one selected pipeline.
    jobsStatus.textContent = activityStatusMessage(collection.status, collection.loadingMore, 'jobs');
    jobsStatus.hidden = !jobsStatus.textContent;
    jobsError.hidden = (!collection.error && collection.status !== 'error') || collection.status === 'unavailable';
    jobsErrorText.textContent = collection.error ?? 'GitLab could not load jobs for this pipeline.';
    jobsRetryButton.disabled = collection.status === 'loading' || collection.loadingMore;
    jobsRetryButton.textContent = collection.committedPage > 0 && collection.hasMore ? 'Retry loading more' : 'Retry';
    jobsRefreshButton.hidden = collection.status !== 'ready' && collection.status !== 'unavailable';
    jobsRefreshButton.disabled = collection.status === 'loading' || collection.loadingMore;
    jobsEmpty.hidden = collection.status !== 'ready' || collection.rows.length > 0 || Boolean(collection.error);
    jobsTruncated.hidden = !collection.truncated || collection.rows.length === 0;
    jobsLoadMoreButton.hidden = !collection.hasMore || collection.status === 'loading' || Boolean(collection.error);
    jobsLoadMoreButton.disabled = collection.loadingMore;
    jobsLoadMoreButton.textContent = collection.loadingMore ? 'Loading more jobs…' : 'Load more jobs';
  };

  // Keep note bodies plain text and show resolution only when GitLab supplies both flags.
  const renderDiscussionNote = (note: GitLabDiscussionNote): HTMLElement => {
    const entry = document.createElement('article');
    entry.className = 'discussion-note';
    const metadata = document.createElement('div');
    metadata.className = 'discussion-note-meta';
    const author = document.createElement('strong');
    author.textContent = note.system === true ? 'GitLab system note'
      : note.author?.name || note.author?.username || 'Unknown author';
    metadata.append(author);
    if (note.createdAt) {
      const time = document.createElement('time');
      time.dateTime = note.createdAt;
      time.textContent = formatUpdatedAt(note.createdAt);
      metadata.append(time);
    }
    if (note.resolvable === true && note.resolved !== null) {
      const resolution = document.createElement('span');
      resolution.className = 'discussion-resolution';
      if (note.resolved) {
        const resolvedBy = note.resolvedBy?.name || note.resolvedBy?.username;
        resolution.textContent = resolvedBy ? `Resolved by ${resolvedBy}` : 'Resolved';
        if (note.resolvedAt) resolution.textContent += ` · ${formatUpdatedAt(note.resolvedAt)}`;
      } else {
        resolution.textContent = 'Unresolved';
      }
      metadata.append(resolution);
    }
    const body = document.createElement('p');
    body.className = 'discussion-note-body';
    body.textContent = note.body;
    entry.append(metadata, body);
    return entry;
  };

  // Preserve thread boundaries and multiline note text with ordinary DOM text nodes.
  const renderDiscussionThreads = (threads: readonly GitLabDiscussion[]) => {
    discussionsList.replaceChildren();
    for (const thread of threads) {
      const item = document.createElement('section');
      item.className = 'discussion-thread';
      item.setAttribute('role', 'listitem');
      if (thread.notes.length) {
        for (const note of thread.notes) item.append(renderDiscussionNote(note));
      } else {
        const emptyNote = document.createElement('p');
        emptyNote.className = 'discussion-empty-note';
        emptyNote.textContent = 'This discussion has no notes.';
        item.append(emptyNote);
      }
      discussionsList.append(item);
    }
  };

  // Render collection loading, empty, failure, pagination, and truncation states distinctly.
  const renderMergeRequestActivity = (activity: PanelState['mergeRequestActivity'], tabsAvailable: boolean) => {
    renderPipelineRows(activity, tabsAvailable);
    renderDiscussionThreads(activity.discussions.rows);

    // Report pipeline loading and pagination without hiding already loaded rows.
    const pipelines = activity.pipelines;
    pipelinesStatus.textContent = activityStatusMessage(pipelines.status, pipelines.loadingMore, 'pipelines');
    pipelinesStatus.hidden = !pipelinesStatus.textContent;
    pipelinesError.hidden = (!pipelines.error && pipelines.status !== 'error') || pipelines.status === 'unavailable';
    pipelinesErrorText.textContent = pipelines.error ?? 'GitLab could not load pipelines for this merge request.';
    pipelinesRetryButton.disabled = pipelines.status === 'loading' || pipelines.loadingMore;
    pipelinesRetryButton.textContent = pipelines.committedPage > 0 && pipelines.hasMore ? 'Retry loading more' : 'Retry';
    pipelinesRefreshButton.hidden = pipelines.status !== 'ready' && pipelines.status !== 'unavailable';
    pipelinesRefreshButton.disabled = pipelines.status === 'loading' || pipelines.loadingMore;
    pipelinesEmpty.hidden = pipelines.status !== 'ready' || pipelines.rows.length > 0 || Boolean(pipelines.error);
    pipelinesTruncated.hidden = !pipelines.truncated || pipelines.rows.length === 0;
    pipelinesLoadMoreButton.hidden = !pipelines.hasMore || pipelines.status === 'loading' || Boolean(pipelines.error);
    pipelinesLoadMoreButton.disabled = pipelines.loadingMore;
    pipelinesLoadMoreButton.textContent = pipelines.loadingMore ? 'Loading more pipelines…' : 'Load more pipelines';

    // Keep discussion loading and pagination independent from pipeline state.
    const discussions = activity.discussions;
    discussionsStatus.textContent = activityStatusMessage(discussions.status, discussions.loadingMore, 'discussions');
    discussionsStatus.hidden = !discussionsStatus.textContent;
    discussionsError.hidden = (!discussions.error && discussions.status !== 'error') || discussions.status === 'unavailable';
    discussionsErrorText.textContent = discussions.error ?? 'GitLab could not load discussions for this merge request.';
    discussionsRetryButton.disabled = discussions.status === 'loading' || discussions.loadingMore;
    discussionsRetryButton.textContent = discussions.committedPage > 0 && discussions.hasMore ? 'Retry loading more' : 'Retry';
    discussionsRefreshButton.hidden = discussions.status !== 'ready' && discussions.status !== 'unavailable';
    discussionsRefreshButton.disabled = discussions.status === 'loading' || discussions.loadingMore;
    discussionsEmpty.hidden = discussions.status !== 'ready' || discussions.rows.length > 0 || Boolean(discussions.error);
    discussionsTruncated.hidden = !discussions.truncated || discussions.rows.length === 0;
    discussionsLoadMoreButton.hidden = !discussions.hasMore || discussions.status === 'loading' || Boolean(discussions.error);
    discussionsLoadMoreButton.disabled = discussions.loadingMore;
    discussionsLoadMoreButton.textContent = discussions.loadingMore ? 'Loading more discussions…' : 'Load more discussions';

    // Reveal jobs only beneath the pipeline selected from the current response.
    renderPipelineJobs(activity);
  };

  // Clear stale activity when its verified detail route is no longer visible.
  const clearMergeRequestActivity = () => {
    pipelinesList.replaceChildren();
    discussionsList.replaceChildren();
    jobsList.replaceChildren();
    jobsSection.hidden = true;
    // Clear transient status text but keep the static empty and cap explanations intact.
    for (const element of [pipelinesStatus, discussionsStatus, jobsStatus]) {
      element.hidden = true;
      element.textContent = '';
    }
    for (const element of [pipelinesEmpty, pipelinesTruncated, discussionsEmpty, discussionsTruncated, jobsEmpty, jobsTruncated]) {
      element.hidden = true;
    }
    pipelinesError.hidden = true;
    pipelinesErrorText.textContent = '';
    discussionsError.hidden = true;
    discussionsErrorText.textContent = '';
    jobsError.hidden = true;
    jobsErrorText.textContent = '';
    pipelinesRefreshButton.hidden = true;
    pipelinesLoadMoreButton.hidden = true;
    discussionsRefreshButton.hidden = true;
    discussionsLoadMoreButton.hidden = true;
    jobsRefreshButton.hidden = true;
    jobsLoadMoreButton.hidden = true;
    pipelineRowFocusId = null;
  };

  // Forward workspace actions while the controller remains responsible for provider and host work.
  const onChange = () => actions.changeProject();
  const onRemove = () => {
    if (current?.canRemove && !current.busy) {
      removeFocusPending = document.activeElement === removeButton;
      actions.remove();
    }
  };
  const onRetryIssues = () => actions.retryIssues();
  const onLoadIssues = () => actions.loadIssues();
  const onLoadMoreIssues = () => actions.loadMoreIssues();
  const onBackToIssues = () => {
    if (current?.issueRoute.kind !== 'detail' || current.issueRoute.origin === 'session') return;
    listFocusIid = current.issueRoute.iid;
    actions.backToIssues();
  };
  const onRetryIssue = () => {
    if (current?.issueRoute.kind === 'detail') actions.retryIssue(current.issueRoute.iid);
  };
  const onStartWorktree = () => {
    if (current?.issueRoute.kind !== 'detail' || !current.canStartWorktree || current.startingWorktree) return;
    actionFocusPending = document.activeElement === startWorktreeButton;
    actions.startIssueWorktree(current.issueRoute.iid);
  };
  const onSelectIssues = () => actions.selectWorkType('issues');
  const onSelectMergeRequests = () => actions.selectWorkType('merge-requests');
  const submitMergeRequestSearch = (query = mergeRequestDraft, scope = renderedMergeRequestScope) => {
    cancelMergeRequestSearch();
    if (!sameMergeRequestScope(scope, visibleMergeRequestScope())) return;
    mergeRequestDraft = query;
    actions.searchMergeRequests(query);
  };
  const onMergeRequestSearchInput = () => {
    const scope = visibleMergeRequestScope();
    if (!sameMergeRequestScope(scope, renderedMergeRequestScope)) return;
    mergeRequestDraft = mergeRequestSearch.value;
    cancelMergeRequestSearch();
    const query = mergeRequestDraft;
    mergeRequestSearchTimer = setTimeout(() => submitMergeRequestSearch(query, scope), 80);
  };
  const onMergeRequestSearchSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!sameMergeRequestScope(renderedMergeRequestScope, visibleMergeRequestScope())) return;
    mergeRequestDraft = mergeRequestSearch.value;
    submitMergeRequestSearch();
  };
  const onRefreshMergeRequests = () => actions.refreshMergeRequests();
  const onRetryMergeRequests = () => actions.refreshMergeRequests();
  const onLoadMoreMergeRequests = () => actions.loadMoreMergeRequests();
  const onBackToMergeRequests = () => {
    if (current?.workspaceRoute.kind !== 'merge-request-detail') return;
    mergeRequestListFocusIid = current.workspaceRoute.iid;
    actions.backToMergeRequests();
  };
  const onRetryMergeRequest = () => {
    if (current?.workspaceRoute.kind === 'merge-request-detail') actions.retryMergeRequest(current.workspaceRoute.iid);
  };
  // Refresh session focus through the controller-owned verification flow.
  const onRefreshSessionFocus = () => {
    if (current && current.sessionFocus.kind !== 'checking'
      && (current.sessionFocus.kind === 'explicit-unavailable'
        || current.sessionFocus.kind === 'verified-issue'
        || current.sessionFocus.kind === 'verified-MR')) {
      sessionRefreshFocusPending = true;
      actions.refreshSessionFocus();
    }
  };
  const onIssuesClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-issue-iid]') : null;
    if (!target || !issuesList.contains(target)) return;
    const iid = Number(target.dataset.issueIid);
    if (!Number.isSafeInteger(iid) || iid <= 0) return;
    detailFocusPending = true;
    actions.selectIssue(iid);
  };
  const onMergeRequestsClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-merge-request-iid]') : null;
    if (!target || !mergeRequestsList.contains(target)) return;
    const iid = Number(target.dataset.mergeRequestIid);
    if (!Number.isSafeInteger(iid) || iid <= 0) return;
    mergeRequestDetailFocusPending = true;
    actions.selectMergeRequest(iid);
  };
  changeButton.addEventListener('click', onChange);
  removeButton.addEventListener('click', onRemove);
  retryIssuesButton.addEventListener('click', onRetryIssues);
  refreshIssuesButton.addEventListener('click', onLoadIssues);
  loadMoreIssuesButton.addEventListener('click', onLoadMoreIssues);
  backToIssuesButton.addEventListener('click', onBackToIssues);
  retryIssueButton.addEventListener('click', onRetryIssue);
  refreshIssueContextButton.addEventListener('click', onRefreshSessionFocus);
  refreshSessionLinkButton.addEventListener('click', onRefreshSessionFocus);
  startWorktreeButton.addEventListener('click', onStartWorktree);
  issuesList.addEventListener('click', onIssuesClick);
  issuesChoice.addEventListener('click', onSelectIssues);
  mergeRequestsChoice.addEventListener('click', onSelectMergeRequests);
  mergeRequestSearch.addEventListener('input', onMergeRequestSearchInput);
  mergeRequestSearchForm.addEventListener('submit', onMergeRequestSearchSubmit);
  refreshMergeRequestsButton.addEventListener('click', onRefreshMergeRequests);
  retryMergeRequestsButton.addEventListener('click', onRetryMergeRequests);
  loadMoreMergeRequestsButton.addEventListener('click', onLoadMoreMergeRequests);
  backToMergeRequestsButton.addEventListener('click', onBackToMergeRequests);
  retryMergeRequestButton.addEventListener('click', onRetryMergeRequest);
  refreshMergeRequestContextButton.addEventListener('click', onRefreshSessionFocus);
  mergeRequestsList.addEventListener('click', onMergeRequestsClick);
  // Keep activity controls connected to controller actions without owning request state.
  mergeRequestTabs.addEventListener('click', onMergeRequestTabClick);
  mergeRequestTabs.addEventListener('keydown', onMergeRequestTabKeydown);
  pipelinesList.addEventListener('click', onPipelineListClick);
  pipelinesRetryButton.addEventListener('click', onRetryPipelines);
  pipelinesRefreshButton.addEventListener('click', onRefreshPipelines);
  pipelinesLoadMoreButton.addEventListener('click', onLoadMorePipelines);
  jobsRetryButton.addEventListener('click', onRetryJobs);
  jobsRefreshButton.addEventListener('click', onRefreshJobs);
  jobsLoadMoreButton.addEventListener('click', onLoadMoreJobs);
  discussionsRetryButton.addEventListener('click', onRetryDiscussions);
  discussionsRefreshButton.addEventListener('click', onRefreshDiscussions);
  discussionsLoadMoreButton.addEventListener('click', onLoadMoreDiscussions);

  return {
    render(state) {
      const focusedIssue = state.sessionFocus.kind === 'verified-issue' ? state.sessionFocus.issue : null;
      const issueRoute = focusedIssue
        ? { kind: 'detail' as const, iid: focusedIssue.iid, origin: 'session' as const }
        : state.issueRoute;
      const issue = focusedIssue ?? state.issue;

      // Reset a focused search when its project scope changes, and stop hidden searches.
      const nextScope = state.mergeRequestBrowser.scope;
      const scopeChanged = renderedMergeRequestScope !== nextScope
        && (renderedMergeRequestScope === null || nextScope === null
          || !sameMergeRequestScope(renderedMergeRequestScope, nextScope));
      if (scopeChanged || !state.association || state.error || state.changingProject
        || state.sessionFocus.kind === 'checking' || state.sessionFocus.kind === 'explicit-unavailable'
        || state.workspaceRoute.kind !== 'merge-requests-list') cancelMergeRequestSearch();
      if (scopeChanged) {
        mergeRequestDraft = state.mergeRequestBrowser.submittedQuery;
        mergeRequestSearch.value = mergeRequestDraft;
      }
      renderedMergeRequestScope = nextScope ? { ...nextScope } : null;
      current = state;

      // Reset presentation state whenever the verified route or activity revision changes.
      const nextActivityContext = currentMergeRequestActivityContext();
      const nextActivityIdentity = nextActivityContext?.identity ?? null;
      const focusWasOnActivityTab = (Object.keys(mergeRequestTabButtons) as MergeRequestTab[])
        .some((tab) => document.activeElement === mergeRequestTabButtons[tab]);
      if (mergeRequestTabIdentity !== nextActivityIdentity) {
        activeMergeRequestTab = 'overview';
        mergeRequestTabIdentity = nextActivityIdentity;
        requestedMergeRequestTabs.clear();
        pipelineRowFocusId = null;
        if (focusWasOnActivityTab && nextActivityIdentity) mergeRequestTabButtons.overview.focus();
      }

      // Keep project identity compact so the real work list remains the primary surface.
      associationLabel.textContent = state.isUnknown ? 'GitLab project for this session' : 'GitLab project';
      associationValue.textContent = state.association?.path ?? (state.repositoryState === 'none' || !state.canSearch
        ? 'Not available'
        : state.isUnknown ? 'No project chosen for this session' : 'No GitLab project associated');
      repositoryLabel.textContent = state.isUnknown ? 'Directory' : 'Local repository';
      repository.textContent = state.repository ?? ({
        checking: 'Checking local repository…',
        unverified: 'Local repository not verified',
        none: 'No local repository open',
        unknown: 'Unregistered directory',
        registered: 'Local repository not verified',
      }[state.repositoryState]);
      scopeNote.textContent = state.isUnknown ? 'This project choice applies to this panel session only.' : '';
      scopeNote.hidden = !scopeNote.textContent;
      changeButton.disabled = !state.canSearch || state.busy;
      changeButton.hidden = !state.association;
      changeButton.textContent = state.changingProject ? 'Cancel' : 'Change project';
      changeButton.setAttribute('aria-expanded', String(state.changingProject));
      removeSlot.hidden = !state.association || state.changingProject;
      removeButton.textContent = state.isUnknown ? 'Clear session choice' : 'Remove association';
      removeButton.disabled = !state.canRemove || state.busy;

      // Move removal focus to stable controller feedback when the association is being cleared.
      if (removeFocusPending && state.busy) {
        root.ownerDocument.querySelector<HTMLElement>('#panel-status')?.focus();
        removeFocusPending = false;
      }

      // Keep the same Change control available in Setup so Cancel restores this exact workspace.
      const setupActionSlot = root.ownerDocument.querySelector<HTMLElement>('#setup-action-slot');
      if (state.changingProject && setupActionSlot) {
        if (changeButton.parentElement !== setupActionSlot) setupActionSlot.append(changeButton);
      }
      else if (changeButton.parentElement !== mappingActions) mappingActions.prepend(changeButton);

      // Select one real content surface from the controller-owned workspace route.
      const hasWorkspace = Boolean(state.association) && !state.error && !state.changingProject;
      // Keep browse content out of view until an attached session link is verified.
      const checkingSessionLink = hasWorkspace && state.sessionFocus.kind === 'checking';
      const explicitLinkUnavailable = hasWorkspace && state.sessionFocus.kind === 'explicit-unavailable';
      const showingSessionLinkStatus = checkingSessionLink || explicitLinkUnavailable;
      const showingIssuesList = hasWorkspace && !showingSessionLinkStatus && state.workspaceRoute.kind === 'issues-list';
      const showingIssueDetail = hasWorkspace && !showingSessionLinkStatus && state.workspaceRoute.kind === 'issue-detail';
      const showingMergeRequestsList = hasWorkspace && !showingSessionLinkStatus && state.workspaceRoute.kind === 'merge-requests-list';
      const showingMergeRequestDetail = hasWorkspace && !showingSessionLinkStatus && state.workspaceRoute.kind === 'merge-request-detail';
      const showingList = showingIssuesList || showingMergeRequestsList;
      const activeBeforeRouteChange = document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
        ? document.activeElement : null;
      const activeIssueRow = showingIssuesList && document.activeElement instanceof HTMLElement && issuesList.contains(document.activeElement)
        ? document.activeElement.closest<HTMLButtonElement>('[data-issue-iid]') : null;
      const activeMergeRequestRow = showingMergeRequestsList && document.activeElement instanceof HTMLElement && mergeRequestsList.contains(document.activeElement)
        ? document.activeElement.closest<HTMLButtonElement>('[data-merge-request-iid]') : null;
      const rerenderFocusIid = activeIssueRow ? Number(activeIssueRow.dataset.issueIid) : null;
      const rerenderMergeRequestFocusIid = activeMergeRequestRow ? Number(activeMergeRequestRow.dataset.mergeRequestIid) : null;
      if (!showingMergeRequestDetail) syncMergeRequestTabPresentation(false);
      // Remember a focused row before hiding browse results for session verification.
      if (showingSessionLinkStatus && activeBeforeRouteChange) {
        const focusedIssueRow = activeBeforeRouteChange.closest<HTMLButtonElement>('[data-issue-iid]');
        const focusedMergeRequestRow = activeBeforeRouteChange.closest<HTMLButtonElement>('[data-merge-request-iid]');
        if (focusedIssueRow && issuesList.contains(focusedIssueRow)) listFocusIid = Number(focusedIssueRow.dataset.issueIid);
        if (focusedMergeRequestRow && mergeRequestsList.contains(focusedMergeRequestRow)) {
          mergeRequestListFocusIid = Number(focusedMergeRequestRow.dataset.mergeRequestIid);
        }
      }
      issuesView.hidden = !showingList;
      sessionLinkStatus.hidden = !showingSessionLinkStatus;
      sessionLinkStatusMessage.textContent = checkingSessionLink ? 'Checking session link…'
        : state.sessionFocus.kind === 'explicit-unavailable' && state.sessionFocus.reason === 'invalid'
          ? 'The attached merge request link is invalid and could not be verified.'
          : state.sessionFocus.kind === 'explicit-unavailable'
            ? 'The attached merge request could not be accessed or may have changed, so it could not be verified.' : '';
      refreshSessionLinkButton.setAttribute('aria-disabled', String(checkingSessionLink));
      issuesListSurface.hidden = !showingIssuesList;
      mergeRequestsListSurface.hidden = !showingMergeRequestsList;
      issueDetail.hidden = !showingIssueDetail;
      mergeRequestDetail.hidden = !showingMergeRequestDetail;
      refreshIssuesButton.hidden = !showingIssuesList;
      refreshMergeRequestsButton.hidden = !showingMergeRequestsList;
      issuesChoice.setAttribute('aria-pressed', String(state.workType === 'issues'));
      mergeRequestsChoice.setAttribute('aria-pressed', String(state.workType === 'merge-requests'));
      if (showingList) focusedSessionIssueIid = null;

      // Move focus only when a route transition hides the user's active control.
      if (activeBeforeRouteChange?.closest('[hidden]')) {
        const visibleRouteTarget = showingSessionLinkStatus ? sessionLinkStatusMessage
          : showingIssueDetail ? issueDetail
          : showingMergeRequestDetail ? mergeRequestDetail
            : showingList ? get<HTMLElement>('workspace-title') : null;
        visibleRouteTarget?.focus();
      }
      if (!showingMergeRequestDetail) clearMergeRequestActivity();

      // Return focus to the retry control when explicit link verification still fails.
      if (explicitLinkUnavailable && sessionRefreshFocusPending) {
        refreshSessionLinkButton.focus();
        sessionRefreshFocusPending = false;
      }

      // Keep loading and provider errors inside the issue list without replacing project identity.
      issuesStatus.textContent = state.issuesLoading
        ? 'Loading open issues…'
        : state.issuesLoadingMore ? 'Loading more open issues…' : '';
      issuesStatus.hidden = !issuesStatus.textContent;
      issuesError.hidden = !state.issuesError;
      issuesErrorText.textContent = state.issuesError ?? '';
      retryIssuesButton.disabled = state.issuesLoading;
      refreshIssuesButton.disabled = state.issuesLoading || state.issuesLoadingMore;
      issuesCount.textContent = state.issuesLoading && !state.issues.length ? '' : `${state.issues.length} shown`;
      issuesList.replaceChildren();

      // Build rows with text nodes so provider content is never interpreted as markup.
      for (const issue of state.issues) {
        const item = document.createElement('div');
        item.className = 'issue-list-item';
        item.setAttribute('role', 'listitem');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'issue-row';
        button.dataset.issueIid = String(issue.iid);
        const title = document.createElement('strong');
        title.textContent = issue.title;
        const titleRow = document.createElement('span');
        titleRow.className = 'issue-row-title';
        const stateBadge = document.createElement('span');
        stateBadge.className = 'issue-state';
        stateBadge.classList.toggle('issue-state-open', issue.state === 'opened');
        stateBadge.textContent = issue.state === 'opened' ? 'Open' : 'Closed';
        const meta = document.createElement('span');
        meta.className = 'issue-row-meta';
        meta.textContent = `Issue · #${issue.iid} · Updated ${formatUpdatedAt(issue.updatedAt)}`;
        titleRow.append(title, stateBadge);
        button.append(titleRow, meta);
        item.append(button);
        issuesList.append(item);
      }
      issuesEmpty.hidden = state.issuesLoading || Boolean(state.issuesError) || state.issues.length > 0;
      loadMoreIssuesButton.hidden = !state.issuesHasMore || Boolean(state.issuesError) || state.issuesLoading;
      loadMoreIssuesButton.disabled = state.issuesLoadingMore;
      loadMoreIssuesButton.textContent = state.issuesLoadingMore ? 'Loading more…' : 'Load more issues';

      // Restore list focus after returning from detail or refreshing the same list.
      const nextFocusIid = listFocusIid ?? rerenderFocusIid;
      if (showingIssuesList && nextFocusIid !== null && Number.isSafeInteger(nextFocusIid)) {
        issuesList.querySelector<HTMLButtonElement>(`[data-issue-iid="${nextFocusIid}"]`)?.focus();
        listFocusIid = null;
      }

      // Keep search controls and result states stable while the merge-request browser refreshes.
      const mergeRequestBrowser = state.mergeRequestBrowser;
      if (!mergeRequestSearchTimer && document.activeElement !== mergeRequestSearch
        && mergeRequestDraft !== mergeRequestBrowser.submittedQuery) {
        mergeRequestDraft = mergeRequestBrowser.submittedQuery;
      }
      if (mergeRequestSearch.value !== mergeRequestDraft) mergeRequestSearch.value = mergeRequestDraft;
      refreshMergeRequestsButton.disabled = mergeRequestBrowser.listLoading;
      mergeRequestsCount.textContent = mergeRequestBrowser.listLoading && !mergeRequestBrowser.rows.length
        ? '' : `${mergeRequestBrowser.rows.length} shown`;
      mergeRequestsStatus.textContent = mergeRequestBrowser.listLoading
        ? (mergeRequestBrowser.rows.length ? 'Loading more merge requests…' : 'Loading merge requests…') : '';
      mergeRequestsStatus.hidden = !mergeRequestsStatus.textContent;
      mergeRequestsError.hidden = !mergeRequestBrowser.listError;
      mergeRequestsErrorText.textContent = mergeRequestBrowser.listError ?? '';
      retryMergeRequestsButton.disabled = mergeRequestBrowser.listLoading;
      mergeRequestsList.replaceChildren();

      // Build merge-request rows from provider text without introducing unsupported actions.
      for (const mergeRequest of mergeRequestBrowser.rows) {
        const item = document.createElement('div');
        item.className = 'issue-list-item';
        item.setAttribute('role', 'listitem');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'issue-row merge-request-row';
        button.dataset.mergeRequestIid = String(mergeRequest.iid);
        const title = document.createElement('strong');
        title.textContent = mergeRequest.title;
        const titleRow = document.createElement('span');
        titleRow.className = 'issue-row-title';
        const stateBadge = document.createElement('span');
        stateBadge.className = 'issue-state';
        stateBadge.classList.toggle('issue-state-open', mergeRequest.state === 'opened');
        stateBadge.textContent = mergeRequest.state === 'opened' ? 'Open' : mergeRequest.state;
        const meta = document.createElement('span');
        meta.className = 'issue-row-meta';
        meta.textContent = `Merge request · !${mergeRequest.iid} · Updated ${formatUpdatedAt(mergeRequest.updatedAt)}`;
        titleRow.append(title, stateBadge);
        button.append(titleRow, meta);
        item.append(button);
        mergeRequestsList.append(item);
      }
      const hasMergeRequestEmptyState = !mergeRequestBrowser.listLoading
        && !mergeRequestBrowser.listError && mergeRequestBrowser.rows.length === 0;
      mergeRequestsEmpty.hidden = !hasMergeRequestEmptyState;
      mergeRequestsEmpty.textContent = mergeRequestBrowser.submittedQuery
        ? `No merge requests match “${mergeRequestBrowser.submittedQuery}”.`
        : 'No merge requests in this project.';
      loadMoreMergeRequestsButton.hidden = !mergeRequestBrowser.hasMore
        || Boolean(mergeRequestBrowser.listError) || mergeRequestBrowser.listLoading;
      loadMoreMergeRequestsButton.disabled = mergeRequestBrowser.listLoading;

      // Restore the exact merge-request row after Back or a list refresh.
      const nextMergeRequestFocusIid = mergeRequestListFocusIid ?? rerenderMergeRequestFocusIid;
      if (showingMergeRequestsList && nextMergeRequestFocusIid !== null && Number.isSafeInteger(nextMergeRequestFocusIid)) {
        mergeRequestsList.querySelector<HTMLButtonElement>(`[data-merge-request-iid="${nextMergeRequestFocusIid}"]`)?.focus();
        mergeRequestListFocusIid = null;
      }

      if (showingMergeRequestDetail && state.workspaceRoute.kind === 'merge-request-detail') {
        // Keep browse retry behavior and render one controller-verified overview source.
        const route = state.workspaceRoute;
        const mergeRequest = state.mergeRequestOverview?.iid === route.iid ? state.mergeRequestOverview : null;
        const fromSession = route.origin !== 'browse';
        const isRelated = route.origin === 'related-issue';
        const detailLoading = !fromSession && mergeRequestBrowser.detailLoading;
        const detailError = fromSession ? null : mergeRequestBrowser.detailError;
        const activityContext = currentMergeRequestActivityContext();
        const showActivityTabs = Boolean(mergeRequest && !detailLoading && !detailError
          && activityContext?.overview.id === mergeRequest.id);
        const focusedActivityControl = document.activeElement instanceof HTMLElement
          && (mergeRequestTabs.contains(document.activeElement) || pipelinesList.contains(document.activeElement))
          ? document.activeElement : null;
        mergeRequestReference.textContent = `!${route.iid}`;
        backToMergeRequestsButton.hidden = fromSession;
        refreshMergeRequestContextButton.hidden = !fromSession;
        mergeRequestDetailLabel.textContent = route.origin === 'explicit-session' ? 'Linked to this session'
          : isRelated ? `Related to issue #${route.issueIid}`
            : 'Merge request details';
        mergeRequestRelatedCaution.textContent = 'Related results can include mentions and may omit merge requests you cannot access.';
        mergeRequestRelatedCaution.hidden = !isRelated;
        mergeRequestDetailStatus.textContent = detailLoading || (fromSession && !mergeRequest)
          ? 'Loading merge request…'
          : !mergeRequest && !detailError ? 'Merge request details are not available for this route.' : '';
        mergeRequestDetailStatus.hidden = !mergeRequestDetailStatus.textContent;
        mergeRequestDetailError.hidden = !detailError;
        mergeRequestDetailErrorText.textContent = detailError ?? '';
        retryMergeRequestButton.disabled = fromSession || detailLoading;
        retryMergeRequestButton.hidden = fromSession;
        mergeRequestContent.hidden = !mergeRequest || detailLoading || Boolean(detailError);
        syncMergeRequestTabPresentation(showActivityTabs);
        if (mergeRequest) {
          mergeRequestState.textContent = mergeRequest.state === 'opened' ? 'Open' : mergeRequest.state;
          mergeRequestState.classList.toggle('issue-state-open', mergeRequest.state === 'opened');
          mergeRequestUpdated.dateTime = mergeRequest.updatedAt;
          mergeRequestUpdated.textContent = `Updated ${formatUpdatedAt(mergeRequest.updatedAt)}`;
          mergeRequestHeading.textContent = mergeRequest.title;
          const branches = mergeRequest.sourceBranch && mergeRequest.targetBranch
            ? `${mergeRequest.sourceBranch} → ${mergeRequest.targetBranch}` : mergeRequest.sourceBranch ?? mergeRequest.targetBranch ?? '';
          mergeRequestBranches.textContent = branches;
          mergeRequestBranches.hidden = !branches;
          mergeRequestDescription.textContent = mergeRequest.description?.trim() || 'No description provided.';
          const webUrl = createGitLabLink(mergeRequest.webUrl, mergeRequest.webUrl, mergeRequestWebUrl.className,
            `Open merge request !${mergeRequest.iid} in GitLab`);
          mergeRequestWebUrl.hidden = !webUrl;
          if (webUrl) {
            mergeRequestWebUrl.href = webUrl.href;
            mergeRequestWebUrl.target = webUrl.target;
            mergeRequestWebUrl.rel = webUrl.rel;
            mergeRequestWebUrl.textContent = webUrl.textContent;
          }
          if (mergeRequestDetailFocusPending || (fromSession && sessionRefreshFocusPending)) {
            mergeRequestHeading.focus();
            mergeRequestDetailFocusPending = false;
          }
        }
        if (fromSession && sessionRefreshFocusPending && mergeRequest) {
          refreshMergeRequestContextButton.focus();
          sessionRefreshFocusPending = false;
        }

        // Hide stale activity whenever this route has no matching verified scope.
        if (showActivityTabs) renderMergeRequestActivity(state.mergeRequestActivity, true);
        else clearMergeRequestActivity();
        if (!showActivityTabs && focusedActivityControl) mergeRequestDetail.focus();
        return;
      }

      if (!showingIssueDetail || issueRoute.kind !== 'detail') {
        if (sessionRefreshFocusPending && !checkingSessionLink) sessionRefreshFocusPending = false;
        return;
      }

      // Present one selected issue at full width, with no unrelated queue beside it.
      backToIssuesButton.hidden = issueRoute.origin === 'session';
      refreshIssueContextButton.hidden = issueRoute.origin !== 'session';
      issueReference.textContent = `#${issueRoute.iid}`;
      // Keep the issue visible and report why an attached MR did not verify.
      const relatedCheck = issueRoute.origin === 'session' && state.sessionFocus.kind === 'verified-issue'
        && state.sessionFocus.issue.iid === issueRoute.iid ? state.sessionFocus.relatedCheck : null;
      let relatedStatus = '';
      if (relatedCheck === 'explicit-invalid') {
        relatedStatus = 'The attached merge request link is invalid and could not be verified. Related merge requests were not searched.';
      } else if (relatedCheck === 'explicit-unavailable') {
        relatedStatus = 'The attached merge request could not be accessed or may have changed, so it could not be verified. Related merge requests were not searched.';
      } else if (relatedCheck === 'none') {
        relatedStatus = 'No open related merge request appeared in the visible results.';
      } else if (relatedCheck === 'ambiguous') {
        relatedStatus = 'Related results could not identify one open merge request; showing this issue.';
      } else if (relatedCheck === 'outside-project') {
        relatedStatus = 'The related merge request is outside this project; showing this issue.';
      } else if (relatedCheck === 'incomplete') {
        relatedStatus = 'The related merge request search did not finish; showing this issue.';
      } else if (relatedCheck === 'unavailable') {
        relatedStatus = 'Related merge requests could not be checked; showing this issue.';
      }
      const hasExplicitSessionMrProblem = relatedCheck === 'explicit-invalid' || relatedCheck === 'explicit-unavailable';
      issueDetailStatus.textContent = hasExplicitSessionMrProblem ? relatedStatus
        : state.issueLoading ? 'Loading issue…' : relatedStatus;
      issueDetailStatus.hidden = !issueDetailStatus.textContent;
      issueDetailError.hidden = !state.issueError;
      issueDetailErrorText.textContent = state.issueError ?? '';
      retryIssueButton.disabled = state.issueLoading;
      const visibleIssue = issue?.iid === issueRoute.iid ? issue : null;
      issueContent.hidden = !visibleIssue || state.issueLoading || Boolean(state.issueError);
      if (!visibleIssue) return;

      // Publish issue detail as safe plain text with only the supported worktree action.
      issueState.textContent = visibleIssue.state === 'opened' ? 'Open' : 'Closed';
      issueState.classList.toggle('issue-state-open', visibleIssue.state === 'opened');
      issueUpdated.dateTime = visibleIssue.updatedAt;
      issueUpdated.textContent = `Updated ${formatUpdatedAt(visibleIssue.updatedAt)}`;
      issueHeading.textContent = visibleIssue.title;
      issueDescription.textContent = visibleIssue.description?.trim() || 'No description provided.';
      worktreeBlocker.hidden = !state.isUnknown;
      startWorktreeButton.hidden = !state.canStartWorktree && !state.startingWorktree;
      startWorktreeButton.disabled = state.startingWorktree;
      startWorktreeButton.textContent = state.startingWorktree ? 'Opening worktree…' : 'Open in new worktree';
      const recoveryActive = state.recovery.phase !== 'clear';
      worktreeStatus.textContent = recoveryActive ? '' : state.worktreeStatus;
      worktreeStatus.hidden = !worktreeStatus.textContent;
      worktreeError.textContent = recoveryActive ? '' : state.worktreeError ?? '';
      worktreeError.hidden = !worktreeError.textContent;

      // Move focus once when the route changes without stealing it on later status renders.
      if (detailFocusPending || (issueRoute.origin === 'session' && focusedSessionIssueIid !== visibleIssue.iid)) {
        issueHeading.focus();
        detailFocusPending = false;
        if (issueRoute.origin === 'session') focusedSessionIssueIid = visibleIssue.iid;
      }
      if (issueRoute.origin === 'session' && sessionRefreshFocusPending) {
        refreshIssueContextButton.focus();
        sessionRefreshFocusPending = false;
      }
      if (actionFocusPending && state.startingWorktree) {
        worktreeStatus.focus();
        actionFocusPending = false;
      }

    },
    destroy() {
      // Stop delayed searches before removing the workspace and its listeners.
      if (mergeRequestSearchTimer) clearTimeout(mergeRequestSearchTimer);
      changeButton.removeEventListener('click', onChange);
      removeButton.removeEventListener('click', onRemove);
      retryIssuesButton.removeEventListener('click', onRetryIssues);
      refreshIssuesButton.removeEventListener('click', onLoadIssues);
      loadMoreIssuesButton.removeEventListener('click', onLoadMoreIssues);
      backToIssuesButton.removeEventListener('click', onBackToIssues);
      retryIssueButton.removeEventListener('click', onRetryIssue);
      refreshIssueContextButton.removeEventListener('click', onRefreshSessionFocus);
      refreshSessionLinkButton.removeEventListener('click', onRefreshSessionFocus);
      startWorktreeButton.removeEventListener('click', onStartWorktree);
      issuesList.removeEventListener('click', onIssuesClick);
      issuesChoice.removeEventListener('click', onSelectIssues);
      mergeRequestsChoice.removeEventListener('click', onSelectMergeRequests);
      mergeRequestSearch.removeEventListener('input', onMergeRequestSearchInput);
      mergeRequestSearchForm.removeEventListener('submit', onMergeRequestSearchSubmit);
      refreshMergeRequestsButton.removeEventListener('click', onRefreshMergeRequests);
      retryMergeRequestsButton.removeEventListener('click', onRetryMergeRequests);
      loadMoreMergeRequestsButton.removeEventListener('click', onLoadMoreMergeRequests);
      backToMergeRequestsButton.removeEventListener('click', onBackToMergeRequests);
      retryMergeRequestButton.removeEventListener('click', onRetryMergeRequest);
      refreshMergeRequestContextButton.removeEventListener('click', onRefreshSessionFocus);
      mergeRequestsList.removeEventListener('click', onMergeRequestsClick);
      mergeRequestTabs.removeEventListener('click', onMergeRequestTabClick);
      mergeRequestTabs.removeEventListener('keydown', onMergeRequestTabKeydown);
      pipelinesList.removeEventListener('click', onPipelineListClick);
      pipelinesRetryButton.removeEventListener('click', onRetryPipelines);
      pipelinesRefreshButton.removeEventListener('click', onRefreshPipelines);
      pipelinesLoadMoreButton.removeEventListener('click', onLoadMorePipelines);
      jobsRetryButton.removeEventListener('click', onRetryJobs);
      jobsRefreshButton.removeEventListener('click', onRefreshJobs);
      jobsLoadMoreButton.removeEventListener('click', onLoadMoreJobs);
      discussionsRetryButton.removeEventListener('click', onRetryDiscussions);
      discussionsRefreshButton.removeEventListener('click', onRefreshDiscussions);
      discussionsLoadMoreButton.removeEventListener('click', onLoadMoreDiscussions);
      root.replaceChildren();
      current = null;
    },
  };
}
