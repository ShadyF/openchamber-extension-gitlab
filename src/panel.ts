import type { GitLabIssue, GitLabMergeRequest } from './gitlab.js';
import type { MergeRequestBrowserSnapshot } from './merge-request-browser.js';
import type { MergeRequestActivitySnapshot } from './merge-request-activity.js';
import type { SessionFocusSnapshot } from './session-focus.js';
import { createWorkspace } from './workspace.js';

export type IssueRoute =
  | { kind: 'list' }
  | { kind: 'detail'; iid: number; origin: 'browse' | 'session' };

export type WorkType = 'issues' | 'merge-requests';

export type WorkspaceRoute =
  | { kind: 'issues-list' }
  | { kind: 'issue-detail'; iid: number; origin: 'browse' | 'session' }
  | { kind: 'merge-requests-list' }
  | { kind: 'merge-request-detail'; iid: number; origin: 'browse' }
  | { kind: 'merge-request-detail'; iid: number; origin: 'explicit-session'; sessionId: string }
  | { kind: 'merge-request-detail'; iid: number; origin: 'related-issue'; sessionId: string; issueIid: number };

export interface WorktreeRecoveryView {
  attemptId: string | null;
  phase: 'loading' | 'clear' | 'read-error' | 'invalid' | 'unresolved' | 'created' | 'retained';
  message: string;
  originLabel: string | null;
  directory: string | null;
  busy: boolean;
  canCheck: boolean;
  canOpenSession: boolean;
  canRelease: boolean;
}

export interface PanelState {
  account: string | null;
  directory: string | null;
  repository: string | null;
  repositoryState: 'checking' | 'unverified' | 'none' | 'unknown' | 'registered';
  association: { id: number; path: string } | null;
  projects: Array<{ id: number; path: string }>;
  selectedId: number | null;
  busy: boolean;
  searching: boolean;
  status: string;
  error: string | null;
  canSearch: boolean;
  searchBlocker: string | null;
  canSave: boolean;
  canRemove: boolean;
  isUnknown: boolean;
  workType: WorkType;
  workspaceRoute: WorkspaceRoute;
  sessionFocus: SessionFocusSnapshot;
  issues: readonly GitLabIssue[];
  issueRoute: IssueRoute;
  issue: GitLabIssue | null;
  issuesLoading: boolean;
  issuesLoadingMore: boolean;
  issuesHasMore: boolean;
  issueLoading: boolean;
  issuesError: string | null;
  issueError: string | null;
  mergeRequestBrowser: MergeRequestBrowserSnapshot;
  mergeRequestOverview: GitLabMergeRequest | null;
  mergeRequestActivity: MergeRequestActivitySnapshot;
  canStartWorktree: boolean;
  startingWorktree: boolean;
  worktreeStatus: string;
  worktreeError: string | null;
  recovery: WorktreeRecoveryView;
}

export interface PanelActions {
  search(query: string): void;
  save(projectId: number): void;
  remove(): void;
  retry(): void;
  loadIssues(): void;
  loadMoreIssues(): void;
  selectIssue(iid: number): void;
  backToIssues(): void;
  retryIssues(): void;
  retryIssue(iid: number): void;
  selectWorkType(type: WorkType): void;
  searchMergeRequests(query: string): void;
  refreshMergeRequests(): void;
  refreshSessionFocus(): void;
  loadMoreMergeRequests(): void;
  selectMergeRequest(iid: number): void;
  backToMergeRequests(): void;
  retryMergeRequest(iid: number): void;
  loadMergeRequestPipelines(): void;
  loadMoreMergeRequestPipelines(): void;
  refreshMergeRequestPipelines(): void;
  loadMergeRequestDiscussions(): void;
  loadMoreMergeRequestDiscussions(): void;
  refreshMergeRequestDiscussions(): void;
  selectMergeRequestPipeline(pipelineId: number | null): void;
  loadMoreMergeRequestJobs(): void;
  refreshMergeRequestJobs(): void;
  startIssueWorktree(iid: number): void;
  retryRecoveryRead(): void;
  checkWorktreeOutcome(): void;
  openCreatedSession(): void;
  releaseWorktreeRecovery(): void;
}

export function createPanel(root: HTMLElement, actions: PanelActions): { render(state: PanelState): void; destroy(): void } {
  // Lead with the active GitLab project while keeping its local repository scope close by.
  root.innerHTML = `
    <div class="panel">
      <header id="panel-header" class="panel-header">
        <h1>GitLab project</h1>
      </header>
      <section id="setup-view" class="setup-view" aria-labelledby="setup-heading">
        <header class="setup-intro">
          <p id="setup-scope" class="setup-scope"></p>
          <h1 id="setup-heading"></h1>
          <p id="setup-purpose"></p>
          <div id="setup-action-slot" class="setup-action-slot"></div>
        </header>
        <section id="project-picker" class="project-picker" aria-labelledby="project-heading">
          <div class="section-heading"><h2 id="project-heading" class="visually-hidden">Project search</h2><span id="searching-indicator" hidden>Searching…</span></div>
          <div id="project-search-form">
            <input id="project-search" class="project-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search visible projects…" aria-label="Search GitLab projects by name or full namespace" aria-controls="project-results" aria-describedby="search-hint search-blocker" />
            <p id="search-hint" class="helper">Search by project name or full namespace.</p>
            <div id="project-results" class="project-results" role="group" aria-label="GitLab projects"></div>
          </div>
          <p id="search-blocker" class="search-blocker" role="status" tabindex="-1" hidden></p>
        </section>
      </section>
      <section id="workspace-view" class="workspace-view" aria-label="GitLab project workspace" hidden></section>
      <p id="panel-status" class="panel-status" role="status" aria-live="polite" tabindex="-1"></p>
      <div id="error-box" class="error-box" role="alert" hidden><span id="error-text"></span><button id="retry-button" class="quiet-button" type="button">Retry</button></div>
      <section id="recovery-banner" class="recovery-banner" aria-labelledby="recovery-heading" hidden>
        <div class="recovery-heading-row"><h2 id="recovery-heading">Worktree recovery</h2><span id="recovery-phase" class="recovery-phase"></span></div>
        <p id="recovery-message" class="recovery-message" role="status" aria-live="polite" tabindex="-1"></p>
        <dl id="recovery-context" class="recovery-context">
          <div id="recovery-origin-row"><dt>Origin repository / issue</dt><dd id="recovery-origin"></dd></div>
          <div id="recovery-directory-row"><dt>Worktree directory</dt><dd id="recovery-directory"></dd></div>
        </dl>
        <p id="recovery-guidance" class="recovery-guidance" hidden></p>
        <div class="recovery-actions">
          <button id="retry-recovery-button" class="quiet-button" type="button" hidden>Retry recovery read</button>
          <button id="check-recovery-button" class="primary-button" type="button" hidden>Check outcome</button>
          <button id="open-recovery-session-button" class="primary-button" type="button" hidden>Open created session</button>
        </div>
        <div id="release-recovery" class="release-recovery" hidden>
          <label><input id="release-recovery-confirm" type="checkbox" /> <span>I understand the timed-out operation may finish later, and another attempt could create a duplicate worktree.</span></label>
          <button id="release-recovery-button" class="quiet-button danger-button" type="button" disabled>Release recovery record</button>
        </div>
      </section>
      <details class="context">
        <summary>Connection and directory details</summary>
        <div class="context-line"><span>Account</span><strong id="account-value"></strong></div>
        <div class="context-line"><span>Directory</span><span id="directory-value" class="directory-value"></span></div>
        <p class="settings-note">Manage the connection and configured host in <strong>Settings → Integrations</strong>.</p>
      </details>
    </div>`;

  const get = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const account = get<HTMLElement>('account-value');
  const panelHeader = get<HTMLElement>('panel-header');
  const workspaceView = get<HTMLElement>('workspace-view');
  const setupView = get<HTMLElement>('setup-view');
  const setupScope = get<HTMLElement>('setup-scope');
  const setupHeading = get<HTMLElement>('setup-heading');
  const setupPurpose = get<HTMLElement>('setup-purpose');
  const directory = get<HTMLElement>('directory-value');
  const projectPicker = get<HTMLElement>('project-picker');
  const searchInput = get<HTMLInputElement>('project-search');
  const searchForm = get<HTMLElement>('project-search-form');
  const sectionHeading = root.querySelector<HTMLElement>('.section-heading')!;
  const searchingIndicator = get<HTMLElement>('searching-indicator');
  const searchBlocker = get<HTMLElement>('search-blocker');
  const searchHint = get<HTMLElement>('search-hint');
  const results = get<HTMLElement>('project-results');
  const errorBox = get<HTMLElement>('error-box');
  const errorText = get<HTMLElement>('error-text');
  const retryButton = get<HTMLButtonElement>('retry-button');
  const status = get<HTMLElement>('panel-status');
  const recoveryBanner = get<HTMLElement>('recovery-banner');
  const recoveryPhase = get<HTMLElement>('recovery-phase');
  const recoveryMessage = get<HTMLElement>('recovery-message');
  const recoveryOriginRow = get<HTMLElement>('recovery-origin-row');
  const recoveryOrigin = get<HTMLElement>('recovery-origin');
  const recoveryDirectoryRow = get<HTMLElement>('recovery-directory-row');
  const recoveryDirectory = get<HTMLElement>('recovery-directory');
  const recoveryGuidance = get<HTMLElement>('recovery-guidance');
  const retryRecoveryButton = get<HTMLButtonElement>('retry-recovery-button');
  const checkRecoveryButton = get<HTMLButtonElement>('check-recovery-button');
  const openRecoverySessionButton = get<HTMLButtonElement>('open-recovery-session-button');
  const releaseRecovery = get<HTMLElement>('release-recovery');
  const releaseRecoveryConfirm = get<HTMLInputElement>('release-recovery-confirm');
  const releaseRecoveryButton = get<HTMLButtonElement>('release-recovery-button');
  let current: PanelState | null = null;
  let query = '';
  let actionFocusPending = false;
  let changingProject = false;
  let renderedAssociationId: number | null = null;
  let renderedRecoveryKey: string | null = null;
  let recoveryActionFocus: 'message' | 'retry' | 'check' | 'open' | 'release' | null = null;

  // Forward edits while preserving the input and its focus across controller renders.
  const onInput = () => {
    query = searchInput.value;
    actions.search(query);
  };
  const onChange = () => {
    changingProject = !changingProject;
    if (current) {
      setupView.hidden = !changingProject;
      workspaceView.hidden = changingProject;
      projectPicker.hidden = false;
      workspace.render({ ...current, changingProject });
    }
    if (changingProject) {
      searchInput.focus();
      return;
    }

    // Cancel only the chooser request, then restore the same issue route and workspace content.
    query = '';
    searchInput.value = '';
    actions.search('');
    projectPicker.hidden = true;
    root.querySelector<HTMLButtonElement>('#change-button')?.focus();
  };
  const onRetry = () => actions.retry();

  // Delegate the associated project and issue experience to one presentation module.
  const workspace = createWorkspace(workspaceView, { ...actions, changeProject: onChange });

  // Keep recovery actions separate from creation so an uncertain attempt is never dispatched again.
  const onRetryRecovery = () => {
    if (!current?.recovery.busy && current?.recovery.phase === 'read-error') {
      recoveryActionFocus = 'retry';
      actions.retryRecoveryRead();
    }
  };
  const onCheckRecovery = () => {
    if (current?.recovery.canCheck && !current.recovery.busy) {
      recoveryActionFocus = 'check';
      actions.checkWorktreeOutcome();
    }
  };
  const onOpenRecoverySession = () => {
    if (current?.recovery.canOpenSession && !current.recovery.busy) {
      recoveryActionFocus = 'open';
      actions.openCreatedSession();
    }
  };
  const onReleaseRecoveryConfirm = () => {
    releaseRecoveryButton.disabled = !releaseRecoveryConfirm.checked || Boolean(current?.recovery.busy);
  };
  const onReleaseRecovery = () => {
    if (current?.recovery.canRelease && !current.recovery.busy && releaseRecoveryConfirm.checked) {
      recoveryActionFocus = 'release';
      actions.releaseWorktreeRecovery();
    }
  };
  const onSearchKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' || !current?.projects.some(project => current?.canSave && !current?.busy)) return;
    event.preventDefault();
    results.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };
  const onResultsKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(results.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    (buttons[next] ?? (next < 0 ? searchInput : buttons[buttons.length - 1]))?.focus();
  };
  searchInput.addEventListener('input', onInput);
  searchInput.addEventListener('keydown', onSearchKeydown);
  results.addEventListener('keydown', onResultsKeydown);
  retryButton.addEventListener('click', onRetry);
  retryRecoveryButton.addEventListener('click', onRetryRecovery);
  checkRecoveryButton.addEventListener('click', onCheckRecovery);
  openRecoverySessionButton.addEventListener('click', onOpenRecoverySession);
  releaseRecoveryConfirm.addEventListener('change', onReleaseRecoveryConfirm);
  releaseRecoveryButton.addEventListener('click', onReleaseRecovery);

  // Show the persisted host recovery record independently of the current issue route or directory.
  const renderRecovery = (recovery: WorktreeRecoveryView): void => {
    const visible = recovery.phase !== 'clear';
    const recoveryKey = `${recovery.phase}:${recovery.attemptId ?? ''}:${recovery.originLabel ?? ''}:${recovery.directory ?? ''}`;
    recoveryBanner.hidden = !visible;
    if (!visible) {
      // Clear destructive confirmation when no recovery record is present.
      releaseRecoveryConfirm.checked = false;
      renderedRecoveryKey = null;

      // Move focus back to stable project context when releasing removes the recovery banner.
      if (recoveryActionFocus) {
        root.querySelector<HTMLElement>('#association-value')?.focus();
        recoveryActionFocus = null;
      }
      return;
    }

    // Reset destructive confirmation when the record or its outcome changes.
    if (recoveryKey !== renderedRecoveryKey) {
      releaseRecoveryConfirm.checked = false;
      renderedRecoveryKey = recoveryKey;
    }

    recoveryBanner.classList.toggle('recovery-error', recovery.phase === 'read-error' || recovery.phase === 'invalid');
    recoveryBanner.setAttribute('aria-busy', String(recovery.busy || recovery.phase === 'loading'));
    recoveryPhase.textContent = ({
      loading: 'Loading',
      clear: '',
      'read-error': 'Read failed',
      invalid: 'Needs attention',
      unresolved: 'Outcome unknown',
      created: 'Created',
      retained: 'Record retained',
    })[recovery.phase];
    const recoveryIsError = recovery.phase === 'read-error' || recovery.phase === 'invalid';
    recoveryMessage.setAttribute('role', recoveryIsError ? 'alert' : 'status');
    recoveryMessage.setAttribute('aria-live', recoveryIsError ? 'assertive' : 'polite');
    recoveryMessage.textContent = recovery.message;
    recoveryOrigin.textContent = recovery.originLabel ?? '';
    recoveryOriginRow.hidden = !recovery.originLabel;
    recoveryDirectory.textContent = recovery.directory ?? '';
    recoveryDirectoryRow.hidden = !recovery.directory;

    // Explain retained records without claiming that a missing snapshot proves no worktree exists.
    recoveryGuidance.textContent = recovery.phase === 'retained'
      ? 'This recovery record remains attached to its originating repository and issue. Use OpenChamber’s native worktree controls to inspect or manage the directory.'
      : '';
    recoveryGuidance.hidden = !recoveryGuidance.textContent;
    retryRecoveryButton.hidden = recovery.phase !== 'read-error';
    checkRecoveryButton.hidden = recovery.phase !== 'unresolved' || !recovery.canCheck;
    openRecoverySessionButton.hidden = recovery.phase !== 'created' || !recovery.canOpenSession;
    releaseRecovery.hidden = !recovery.canRelease;
    retryRecoveryButton.disabled = recovery.busy;
    checkRecoveryButton.disabled = recovery.busy;
    openRecoverySessionButton.disabled = recovery.busy;
    releaseRecoveryConfirm.disabled = recovery.busy;
    releaseRecoveryButton.disabled = recovery.busy || !releaseRecoveryConfirm.checked;

    // Return focus to the same recovery action, or its stable message when the action disappears.
    if (recoveryActionFocus) {
      const focusTarget = ({ retry: retryRecoveryButton, check: checkRecoveryButton, open: openRecoverySessionButton, release: recoveryMessage, message: recoveryMessage })[recoveryActionFocus];
      (focusTarget.hidden ? recoveryMessage : focusTarget).focus();
      recoveryActionFocus = null;
    }
  };

  return {
    render(state) {
      current = state;

      // Show Setup only when association is missing or the user is actively replacing it.
      if (state.association && state.association.id !== renderedAssociationId) changingProject = false;
      if (!state.association) changingProject = false;
      renderedAssociationId = state.association?.id ?? null;
      const needsSetup = !state.association || changingProject;
      setupView.hidden = !needsSetup;
      workspaceView.hidden = needsSetup;
      panelHeader.hidden = true;
      setupScope.textContent = state.isUnknown
        ? `Session-only directory · ${state.repository ?? 'Unregistered directory'}`
        : `Local repository · ${state.repository ?? 'Not verified'}`;
      setupHeading.textContent = state.association ? 'Choose a different GitLab project'
        : state.canSearch ? 'Choose its GitLab project' : 'Connect GitLab to continue';
      setupPurpose.textContent = state.canSearch
        ? state.isUnknown
          ? 'Choose the project whose issues should be available for this panel session.'
          : 'The selected project supplies issues for this repository and its registered worktrees.'
        : 'Connect the configured GitLab account before choosing a project for this repository.';

      // Keep connection details available outside both Setup and the daily workspace.
      account.textContent = state.account ?? 'Not connected';
      directory.textContent = state.directory ?? 'Unknown';
      projectPicker.hidden = Boolean(state.error) || !needsSetup;
      status.textContent = state.status || (state.searching ? 'Searching projects…' : state.busy ? 'Working…' : '');
      status.hidden = !status.textContent || Boolean(state.searchBlocker);
      workspace.render({ ...state, changingProject });

      // Keep blocked-state guidance by its unavailable control and show progress before long results.
      const searchHadFocus = !state.canSearch && document.activeElement === searchInput;
      searchInput.disabled = !state.canSearch;
      searchInput.setAttribute('aria-describedby', state.canSearch ? 'search-hint' : 'search-blocker');
      searchBlocker.textContent = state.searchBlocker ?? '';
      searchBlocker.hidden = !state.searchBlocker;
      searchForm.hidden = !state.canSearch;
      sectionHeading.hidden = !state.canSearch;
      if (state.canSearch) {
        projectPicker.setAttribute('aria-labelledby', 'project-heading');
        projectPicker.removeAttribute('aria-label');
      } else {
        projectPicker.removeAttribute('aria-labelledby');
        projectPicker.setAttribute('aria-label', 'Project prerequisite');
      }
      if (searchHadFocus) searchBlocker.focus();
      searchHint.hidden = !state.canSearch;
      searchingIndicator.hidden = !state.searching;
      results.hidden = Boolean(state.searchBlocker);
      if (actionFocusPending && state.busy) {
        status.focus();
        actionFocusPending = false;
      }

      // Preserve normal result navigation while moving focus to stable feedback after a selection.
      const activeId = document.activeElement instanceof HTMLElement && results.contains(document.activeElement)
        ? document.activeElement.dataset.projectId : null;
      results.replaceChildren();
      if (!state.searchBlocker && !state.projects.length && !query.trim() && !state.searching && !state.error) {
        const empty = document.createElement('p');
        empty.className = 'empty-results';
        empty.textContent = 'Search to find a GitLab project.';
        results.append(empty);
      } else {
        for (const project of state.projects) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'project-row';
          button.dataset.projectId = String(project.id);
          button.setAttribute('aria-pressed', String(project.id === state.selectedId));
          button.disabled = !state.canSave || state.busy;
          const path = document.createElement('span');
          path.className = 'project-path';
          path.textContent = project.path;
          const action = document.createElement('span');
          action.className = 'project-action';
          action.textContent = project.id === state.selectedId ? 'Selected' : state.isUnknown ? 'Use for this session' : 'Choose';
          button.append(path, action);
          button.addEventListener('click', () => {
            if (current?.canSave && !current.busy) {
              actionFocusPending = document.activeElement === button;
              actions.save(project.id);
            }
          });
          results.append(button);
        }
      }
      if (activeId) results.querySelector<HTMLButtonElement>(`[data-project-id="${activeId}"]`)?.focus();
      errorBox.hidden = !state.error;
      errorText.textContent = state.error ?? '';
      retryButton.disabled = state.busy;
      renderRecovery(state.recovery);
    },
    destroy() {
      // Release event handlers before removing the panel.
      searchInput.removeEventListener('input', onInput);
      searchInput.removeEventListener('keydown', onSearchKeydown);
      results.removeEventListener('keydown', onResultsKeydown);
      retryButton.removeEventListener('click', onRetry);
      retryRecoveryButton.removeEventListener('click', onRetryRecovery);
      checkRecoveryButton.removeEventListener('click', onCheckRecovery);
      openRecoverySessionButton.removeEventListener('click', onOpenRecoverySession);
      releaseRecoveryConfirm.removeEventListener('change', onReleaseRecoveryConfirm);
      releaseRecoveryButton.removeEventListener('click', onReleaseRecovery);
      workspace.destroy();
      root.replaceChildren();
      current = null;
    },
  };
}
