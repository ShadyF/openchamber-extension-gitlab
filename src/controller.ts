import type { GuestConnection, GuestSessionsSnapshot, HostClient, HostReadyContext, SessionSnapshot } from '@openchamber/sdk';
import { createPanel, type PanelState, type WorktreeRecoveryView } from './panel.js';
import {
  associationStorageKey,
  prepareAssociation,
  readAssociation,
  resolveDirectory,
  writePreparedAssociation,
  type AssociationScope,
  type DirectoryResolution,
  type SavedAssociation,
} from './association.js';
import { getCurrentUser, getProjectById, getProjectIssue, getProjectMergeRequest, GitLabApiError, gitLabErrorMessage, GITLAB_VARIANT_ID, listMergeRequestDiscussions, listMergeRequestPipelines, listPipelineJobs, listProjectIssues, listProjectMergeRequests, listRelatedMergeRequestsPage, searchVisibleProjects, type GitLabIssue, type GitLabMergeRequest, type GitLabProject, type GitLabUser } from './gitlab.js';
import { createMergeRequestBrowser } from './merge-request-browser.js';
import { createMergeRequestActivity, type MergeRequestActivityScope } from './merge-request-activity.js';
import { createSessionFocus, type SessionFocusSnapshot } from './session-focus.js';
import {
  armRecovery,
  checkRecovery,
  readRecovery,
  releaseRecovery,
  writeRecoveryOutcome,
  type RecoveryOutcome,
  type RecoveryReadResult,
  type RecoveryRecord,
  type RecoveryReleaseTarget,
} from './worktree-recovery.js';

export type GitLabPanelHost = Pick<HostClient, 'request' | 'storage' | 'listProjects' | 'listWorktrees' | 'onReady' | 'onDirectory' | 'onConnection' | 'startSession' | 'onSession' | 'listSessions' | 'onSessions' | 'openSession'>;

type SessionChoice = {
  directory: string;
  accountId: number;
  variant: string;
  project: SavedAssociation;
};

type Context = {
  directory: string | null;
  connection: GuestConnection | null;
};

type AccountIdentity = Pick<GitLabUser, 'id' | 'variant'>;

// Mount the real panel and keep all provider, workspace, and persistence work behind host APIs.
export function mountGitLabPanel(host: GitLabPanelHost, root: HTMLElement): { destroy(): void } {
  let context: Context = { directory: null, connection: null };
  let contextGeneration = 0;
  let searchGeneration = 0;
  let actionGeneration = 0;
  let issueListGeneration = 0;
  let automaticAuthRetryAttempted = false;
  let issueDetailGeneration = 0;
  let worktreeGeneration = 0;
  let account: GitLabUser | null = null;
  let lastVerifiedIdentity: AccountIdentity | null = null;
  let directoryResolution: DirectoryResolution = { kind: 'unresolved', reason: 'no-directory' };
  let contextReady = false;
  let association: SavedAssociation | null = null;
  let sessionChoice: SessionChoice | null = null;
  let identityRequiringReselect: AccountIdentity | null = null;
  let projects: GitLabProject[] = [];
  let selectedId: number | null = null;
  let busy = false;
  let searching = false;
  let status = '';
  let error: string | null = null;
  let destroyed = false;
  let hostReady = false;
  let issues: GitLabIssue[] = [];
  let issuesPage = 0;
  let issueRoute: PanelState['issueRoute'] = { kind: 'list' };
  let workType: PanelState['workType'] = 'issues';
  let mergeRequestScopeRevision = 0;
  let mergeRequestActivityRevision = 0;
  let mergeRequestActivityRevisionKey: string | null = null;
  let rendering = false;
  let sessionFocusRevision = 0;
  let sessionFocusWasActive = false;
  let currentIssue: GitLabIssue | null = null;
  let issuesLoading = false;
  let issuesLoadingMore = false;
  let issuesHasMore = false;
  let issueLoading = false;
  let issuesError: string | null = null;
  let issueError: string | null = null;
  let canStartWorktree = false;
  let startingWorktree = false;
  let worktreeOperationLocked = false;
  let worktreeOperationId = 0;
  let worktreeRequestDispatched = false;
  let worktreeStatus = '';
  let worktreeError: string | null = null;
  let currentSession: SessionSnapshot | null = null;
  let sessionGeneration = 0;
  let sessionSubscriptionGeneration = 0;
  let sessionUnsubscribe: (() => void) | null = null;
  let sessionSubscriptionProject: string | null = null;
  let recoveryLoadState: 'loading' | 'loaded' | 'read-error' = 'loading';
  let recoveryRecord: RecoveryRecord | null = null;
  let recoveryInvalid = false;
  let recoveryBusy = false;
  let recoveryKnownOutcome: { attemptId: string; outcome: Exclude<RecoveryOutcome, { kind: 'unresolved' }> } | null = null;
  let recoveryMessageOverride: string | null = null;
  let recoveryGeneration = 0;
  let recoveryActionGeneration = 0;
  let recoveryReadStarted = false;
  let recoveryInitiatingContext: { attemptId: string; contextGeneration: number; sessionId: string | null } | null = null;

  // Keep merge-request reads behind the host adapter and invalidate them with every scope change.
  const mergeRequestBrowser = createMergeRequestBrowser({
    listProjectMergeRequests: (projectId, page, query) => listProjectMergeRequests(host, projectId, page, query),
    getProjectMergeRequest: (projectId, iid) => getProjectMergeRequest(host, projectId, iid),
    onChange: () => render(),
    onAuthenticationFailure: () => handleMergeRequestAuthenticationFailure(),
  });

  // Keep activity reads on the same authenticated host boundary as MR browsing.
  const mergeRequestActivity = createMergeRequestActivity({
    listMergeRequestPipelines: (projectId, iid, page) => listMergeRequestPipelines(host, projectId, iid, page),
    listPipelineJobs: (projectId, pipelineId, page) => listPipelineJobs(host, projectId, pipelineId, page),
    listMergeRequestDiscussions: (projectId, iid, page) => listMergeRequestDiscussions(host, projectId, iid, page),
    onChange: () => {
      // Scope changes publish synchronously during render; the current render already includes that snapshot.
      if (!rendering) render();
    },
    onAuthenticationFailure: () => handleMergeRequestAuthenticationFailure(),
  });

  // Keep session focus verification behind the same authenticated host boundary as issue browsing.
  const sessionFocus = createSessionFocus({
    listSessions: (projectId) => host.listSessions(projectId),
    getIssue: (projectId, iid) => getProjectIssue(host, projectId, iid),
    getMergeRequest: (projectId, iid) => getProjectMergeRequest(host, projectId, iid),
    listRelatedPage: (projectId, iid, page) => listRelatedMergeRequestsPage(host, projectId, iid, page),
    onChange: (snapshot) => {
      const wasActive = sessionFocusWasActive;
      sessionFocusWasActive = snapshot.kind !== 'none';
      if ((snapshot.kind === 'checking' && !wasActive) || (snapshot.kind === 'none' && wasActive)) {
        clearBrowseDetailsForFocusTransition();
      }
      render();
    },
    onAuthenticationFailure: () => handleMergeRequestAuthenticationFailure(),
  });

  // Keep the global recovery lock independent from issue-route and directory state.
  const getRecoveryView = (): WorktreeRecoveryView => {
    const phase: WorktreeRecoveryView['phase'] = recoveryLoadState === 'loading'
      ? 'loading'
      : recoveryLoadState === 'read-error'
        ? 'read-error'
        : recoveryInvalid
          ? 'invalid'
          : recoveryRecord?.outcome.kind ?? 'clear';
    const outcome = recoveryRecord?.outcome;
    const message = phase === 'loading'
      ? 'Checking for a saved worktree recovery record…'
      : phase === 'read-error'
        ? 'The worktree recovery record could not be read. Retry the read before starting another worktree.'
        : phase === 'invalid'
          ? 'The saved recovery record is malformed or unsupported. It was preserved and must be reviewed before release.'
          : phase === 'unresolved'
            ? recoveryMessageOverride ?? (recoveryKnownOutcome
              ? 'OpenChamber returned a result, but it could not be saved. Check again to retry saving it; do not create another worktree.'
              : 'The request may still be running or may have completed. Check its outcome; no automatic retry will be made.')
          : phase === 'created'
              ? recoveryMessageOverride ?? (outcome?.kind === 'created' && !outcome.linked
                ? 'The session was created, but OpenChamber did not confirm the issue link. No duplicate worktree was created.'
                : outcome?.kind === 'created' && outcome.sent === 'unknown'
                  ? 'A matching session was found. Whether an agent turn started is unknown.'
                  : outcome?.kind === 'created' && outcome.sent !== 'skipped'
                    ? 'The worktree and session were created. Open the session to continue.'
                    : 'The worktree and session were created without starting an agent turn.')
          : phase === 'retained'
                ? recoveryMessageOverride ?? (outcome?.kind === 'retained' && outcome.failure === 'bootstrap-failed'
                  ? 'OpenChamber retained the worktree, but setup did not finish and no session was created.'
                  : 'OpenChamber retained the worktree, but could not create its session.')
                : '';

    return {
      attemptId: recoveryRecord?.attemptId ?? null,
      phase,
      message,
      originLabel: recoveryRecord
        ? `${recoveryRecord.origin.directory} · GitLab issue #${recoveryRecord.origin.iid}`
        : null,
      directory: outcome?.kind === 'created' || outcome?.kind === 'retained' ? outcome.directory : null,
      busy: recoveryBusy || startingWorktree || worktreeOperationLocked,
      canCheck: phase === 'unresolved' && !recoveryBusy && !startingWorktree && !worktreeOperationLocked,
      canOpenSession: phase === 'created' && !recoveryBusy && !startingWorktree && !worktreeOperationLocked,
      canRelease: (phase === 'invalid' || phase === 'unresolved' || phase === 'created' || phase === 'retained')
        && !recoveryBusy && !startingWorktree && !worktreeOperationLocked,
    };
  };

  // Render a fresh state snapshot while keeping the panel instance and its input alive.
  const render = () => {
    if (rendering) return;
    rendering = true;
    try {
      const focused = sessionFocus.snapshot();
      const browserSnapshot = mergeRequestBrowser.snapshot();
      const workspaceRoute = getWorkspaceRoute();
      const mergeRequestView = deriveMergeRequestView(workspaceRoute, focused, browserSnapshot);
      mergeRequestActivity.setScope(mergeRequestView.scope);
      const isUnknown = directoryResolution.kind === 'unknown';
      const canUseDirectory = directoryResolution.kind === 'registered' || isUnknown;
      const canSearch = contextReady && Boolean(account) && Boolean(context.connection?.connected) && canUseDirectory;
      canStartWorktree = getRecoveryView().phase === 'clear' && canBrowseIssues() && directoryResolution.kind === 'registered'
        && issueRoute.kind === 'detail' && issueRoute.origin === 'browse' && currentIssue !== null
        && !startingWorktree && !worktreeOperationLocked;

      // Distinguish an unchecked repository from one that is known to be absent or unregistered.
      const repositoryState: PanelState['repositoryState'] = !hostReady
        ? 'checking'
        : !context.directory
          ? 'none'
          : directoryResolution.kind === 'registered'
            ? 'registered'
            : directoryResolution.kind === 'unknown'
              ? 'unknown'
              : context.connection?.connected && !contextReady && !error
                ? 'checking'
                : 'unverified';

      // Give the search field the specific prerequisite that currently prevents its use.
      const searchBlocker = !hostReady
        ? 'Waiting for OpenChamber context…'
        : !context.connection?.connected
          ? 'Connect GitLab in Settings → Integrations to search projects.'
          : !contextReady
            ? error ?? 'Verifying the GitLab connection and local repository…'
            : !account
              ? 'Reconnect GitLab in Settings → Integrations to search projects.'
              : !canUseDirectory
                ? directoryStatus(directoryResolution)
                : null;
      const state: PanelState = {
        account: account?.username ?? null,
        directory: context.directory,
        repository: directoryResolution.kind === 'registered' ? directoryResolution.project.name : null,
        repositoryState,
        association,
        projects: projects.map((project) => ({ ...project })),
        selectedId,
        busy,
        searching,
        status,
        error,
        canSearch,
        searchBlocker,
        canSave: canSearch && projects.length > 0 && !busy,
        canRemove: contextReady && Boolean(account) && Boolean(context.connection?.connected) && canUseDirectory && Boolean(association) && !busy,
        isUnknown,
        workType,
        workspaceRoute,
        sessionFocus: focused,
        issues,
        issueRoute,
        issue: focused.kind === 'verified-issue' ? focused.issue
          : focused.kind === 'verified-MR' ? focused.issue : currentIssue,
        issuesLoading,
        issuesLoadingMore,
        issuesHasMore,
        issueLoading,
        issuesError,
        issueError,
        mergeRequestBrowser: browserSnapshot,
        mergeRequestOverview: mergeRequestView.overview,
        mergeRequestActivity: mergeRequestActivity.snapshot(),
        canStartWorktree,
        startingWorktree,
        worktreeStatus,
        worktreeError,
        recovery: getRecoveryView(),
      };
      panel.render(state);
    } finally {
      rendering = false;
    }
  };

  // Hydrate the global recovery lock separately from GitLab and directory verification.
  const refreshRecoveryRead = async (): Promise<void> => {
    const generation = ++recoveryGeneration;
    recoveryLoadState = 'loading';
    recoveryRecord = null;
    recoveryInvalid = false;
    recoveryKnownOutcome = null;
    recoveryMessageOverride = null;
    render();

    try {
      const result = await readRecovery(host.storage);
      if (destroyed || generation !== recoveryGeneration) return;
      applyRecoveryRead(result);
    } catch {
      if (destroyed || generation !== recoveryGeneration) return;
      recoveryLoadState = 'read-error';
      recoveryRecord = null;
      recoveryInvalid = false;
    }
    render();
  };

  // Publish only an acknowledged valid or absent recovery slot; invalid data remains untouched.
  const applyRecoveryRead = (result: RecoveryReadResult): void => {
    recoveryLoadState = 'loaded';
    recoveryRecord = result.kind === 'valid' ? result.record : null;
    recoveryInvalid = result.kind === 'invalid';
    recoveryKnownOutcome = null;
    recoveryMessageOverride = null;
  };

  // Keep the status explicit when the OpenChamber workspace cannot be resolved safely.
  const directoryStatus = (resolution: DirectoryResolution): string => {
    switch (resolution.kind) {
      case 'registered':
        return `Ready to associate ${resolution.project.name}.`;
      case 'unknown':
        return 'This directory is not registered in OpenChamber. A project choice will apply to this session only.';
      case 'unresolved':
        if (resolution.reason === 'no-directory') return 'Open a local repository or worktree to choose an association.';
        if (resolution.reason === 'ambiguous') return 'This directory matches more than one registered OpenChamber project. Association is disabled.';
        if (resolution.reason === 'pending') return 'This directory belongs to a worktree that is not ready. Wait for it to finish or retry.';
        return 'OpenChamber has not provided complete project and worktree information. Retry before saving.';
    }
  };

  // Clear issue views and invalidate every request tied to the old association or session.
  const clearIssueState = (): void => {
    issueListGeneration += 1;
    issueDetailGeneration += 1;
    worktreeGeneration += 1;
    issues = [];
    issuesPage = 0;
    issueRoute = { kind: 'list' };
    currentIssue = null;
    issuesLoading = false;
    issuesLoadingMore = false;
    issuesHasMore = false;
    issueLoading = false;
    issuesError = null;
    issueError = null;
    canStartWorktree = false;
    startingWorktree = false;
    worktreeRequestDispatched = false;
    worktreeStatus = '';
    worktreeError = null;
    // Invalidate session verification before another context can start provider requests.
    sessionFocusRevision += 1;
    sessionFocus.setScope(null);
  };

  // Clear only browse details when a focused session takes over or loses its link.
  const clearBrowseDetailsForFocusTransition = (): void => {
    issueDetailGeneration += 1;
    if (issueRoute.kind === 'detail') {
      issueRoute = { kind: 'list' };
      currentIssue = null;
      issueLoading = false;
      issueError = null;
    }
    mergeRequestBrowser.clearDetail();
    canStartWorktree = false;
  };

  // Keep issue browsing available only after the account and association are verified.
  const canBrowseIssues = (): boolean => Boolean(contextReady && account && context.connection?.connected && association && canUseDirectory(directoryResolution));

  // Bind session focus only to a connected account, active session, and registered local repository.
  const syncSessionFocusScope = (): void => {
    const localProjectId = directoryResolution.kind === 'registered' ? directoryResolution.project.id : null;
    if (!canBrowseIssues() || !account || !association || !currentSession || !context.directory || !localProjectId) {
      sessionFocus.setScope(null);
      return;
    }

    sessionFocus.setScope({
      revision: sessionFocusRevision,
      sessionId: currentSession.id,
      directory: context.directory,
      localProjectId,
      accountId: account.id,
      variant: account.variant,
      projectId: association.id,
    });
  };

  // Give verified session links priority while keeping browse routes independent.
  const getWorkspaceRoute = (): PanelState['workspaceRoute'] => {
    const focused = sessionFocus.snapshot();
    if (focused.kind === 'verified-issue') {
      return { kind: 'issue-detail', iid: focused.issue.iid, origin: 'session' };
    }
    if (focused.kind === 'verified-MR' && focused.provenance === 'explicit-session') {
      return { kind: 'merge-request-detail', iid: focused.mergeRequest.iid, origin: 'explicit-session', sessionId: focused.scope.sessionId };
    }
    if (focused.kind === 'verified-MR' && focused.issue) {
      return {
        kind: 'merge-request-detail',
        iid: focused.mergeRequest.iid,
        origin: 'related-issue',
        sessionId: focused.scope.sessionId,
        issueIid: focused.issue.iid,
      };
    }
    if (workType === 'merge-requests') {
      const selectedIid = mergeRequestBrowser.snapshot().selectedIid;
      return selectedIid === null
        ? { kind: 'merge-requests-list' }
        : { kind: 'merge-request-detail', iid: selectedIid, origin: 'browse' };
    }
    return issueRoute.kind === 'detail'
      ? { kind: 'issue-detail', iid: issueRoute.iid, origin: issueRoute.origin }
      : { kind: 'issues-list' };
  };

  // Invalidate prior merge-request responses whenever verification begins, even for identical IDs.
  const clearMergeRequestScope = (): void => {
    mergeRequestScopeRevision += 1;
    mergeRequestBrowser.setScope(null);
  };

  // Revoke all in-memory account data and invalidate requests before another verification cycle.
  const invalidateAccountScope = (): void => {
    contextReady = false;
    clearIssueState();
    account = null;
    association = null;
    clearMergeRequestScope();
  };

  // Bind browser requests only to the currently eligible account, association, and local directory.
  const syncMergeRequestScope = (): void => {
    if (!canBrowseIssues() || !account || !association || !context.directory) {
      mergeRequestBrowser.setScope(null);
      return;
    }

    mergeRequestBrowser.setScope({
      revision: mergeRequestScopeRevision,
      directory: context.directory,
      localProjectId: directoryResolution.kind === 'registered' ? directoryResolution.project.id : null,
      accountId: account.id,
      variant: account.variant,
      projectId: association.id,
    });
    if (workType === 'merge-requests') void mergeRequestBrowser.ensureList();
  };

  // Reject actions from an old view unless the browser still belongs to the verified project.
  const canUseMergeRequestBrowser = (route: PanelState['workspaceRoute']['kind']): boolean => {
    if (!canBrowseIssues() || sessionFocus.snapshot().kind !== 'none'
      || getWorkspaceRoute().kind !== route || !account || !association || !context.directory) return false;
    const scope = mergeRequestBrowser.snapshot().scope;
    return Boolean(scope && scope.revision === mergeRequestScopeRevision
      && scope.directory === context.directory
      && scope.localProjectId === (directoryResolution.kind === 'registered' ? directoryResolution.project.id : null)
      && scope.accountId === account.id && scope.variant === account.variant && scope.projectId === association.id);
  };

  // Derive the visible overview and its data authority from the same verified route evidence.
  const deriveMergeRequestView = (
    route: PanelState['workspaceRoute'],
    focused: SessionFocusSnapshot,
    browser: ReturnType<typeof mergeRequestBrowser.snapshot>,
  ): { overview: GitLabMergeRequest | null; scope: MergeRequestActivityScope | null } => {
    const unavailable = (): { overview: GitLabMergeRequest | null; scope: MergeRequestActivityScope | null } => {
      mergeRequestActivityRevisionKey = null;
      return { overview: null, scope: null };
    };
    const positiveId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
    const localProjectId = directoryResolution.kind === 'registered' ? directoryResolution.project.id : null;
    if (!contextReady || !context.connection?.connected || !account || !association || !context.directory
      || !canUseDirectory(directoryResolution) || !positiveId(association.id)) return unavailable();

    let overview: GitLabMergeRequest | null = null;
    let origin: MergeRequestActivityScope['origin'];
    let sessionId: string | undefined;
    let issueId: number | undefined;
    let issueIid: number | undefined;
    let sourceRevision: number;

    if (route.kind !== 'merge-request-detail') return unavailable();

    if (route.origin === 'browse') {
      const browserScope = browser.scope;
      if (focused.kind !== 'none' || browser.selectedIid !== route.iid || !browserScope
        || browserScope.directory !== context.directory || browserScope.localProjectId !== localProjectId
        || browserScope.accountId !== account.id || browserScope.variant !== account.variant
        || browserScope.projectId !== association.id || browser.detailLoading || browser.detailError) return unavailable();
      overview = browser.detail;
      origin = 'browse';
      sourceRevision = browserScope.revision;
    } else {
      if (focused.kind !== 'verified-MR' || !currentSession || focused.scope.sessionId !== currentSession.id
        || focused.scope.sessionId !== route.sessionId || focused.scope.revision !== sessionFocusRevision
        || focused.scope.directory !== context.directory || focused.scope.localProjectId !== localProjectId
        || localProjectId === null || focused.scope.accountId !== account.id
        || focused.scope.variant !== account.variant || focused.scope.projectId !== association.id) return unavailable();
      if (route.origin === 'explicit-session') {
        if (focused.provenance !== 'explicit-session') return unavailable();
        origin = 'explicit-session';
      } else {
        if (focused.provenance !== 'related-issue' || !focused.issue
          || focused.issue.projectId !== association.id || focused.issue.iid !== route.issueIid
          || !positiveId(focused.issue.id) || !positiveId(focused.issue.iid)) return unavailable();
        origin = 'related-issue';
        issueId = focused.issue.id;
        issueIid = focused.issue.iid;
      }
      overview = focused.mergeRequest;
      sessionId = focused.scope.sessionId;
      sourceRevision = focused.scope.revision;
    }

    if (!overview || !positiveId(route.iid) || !positiveId(overview.id) || !positiveId(overview.iid)
      || overview.iid !== route.iid || overview.projectId !== association.id
      || overview.targetProjectId !== overview.projectId || !overview.webUrl.startsWith('https://')) return unavailable();

    // Advance the activity revision whenever route identity or its source authority changes.
    const identity = {
      accountId: account.id,
      variant: account.variant,
      directory: context.directory,
      localProjectId,
      targetProjectId: overview.targetProjectId,
      mergeRequestId: overview.id,
      iid: overview.iid,
      webUrl: overview.webUrl,
      origin,
      sessionId,
      issueId,
      issueIid,
      sourceRevision,
    };
    const revisionKey = JSON.stringify(identity);
    if (mergeRequestActivityRevisionKey !== revisionKey) {
      mergeRequestActivityRevision += 1;
      mergeRequestActivityRevision = Math.max(mergeRequestActivityRevision, sourceRevision);
      mergeRequestActivityRevisionKey = revisionKey;
    }
    const scope: MergeRequestActivityScope = Object.freeze({
      accountId: account.id,
      variant: account.variant,
      directory: context.directory,
      localProjectId,
      targetProjectId: overview.targetProjectId,
      mergeRequestId: overview.id,
      iid: overview.iid,
      webUrl: overview.webUrl,
      origin,
      ...(sessionId ? { sessionId } : {}),
      ...(issueId !== undefined ? { issueId, issueIid } : {}),
      revision: mergeRequestActivityRevision,
    });
    return { overview, scope };
  };

  // Validate every activity callback against the currently visible route and its published scope.
  const withCurrentMergeRequestActivity = (action: (scope: MergeRequestActivityScope) => void): void => {
    const current = deriveMergeRequestView(getWorkspaceRoute(), sessionFocus.snapshot(), mergeRequestBrowser.snapshot()).scope;
    const active = mergeRequestActivity.snapshot().scope;
    if (!current || !active || JSON.stringify(current) !== JSON.stringify(active)) return;
    action(active);
  };

  // Subscribe only to the registered local project that owns the verified GitLab association.
  const syncSessionSubscription = (projectId: string | null): void => {
    if (sessionSubscriptionProject === projectId) return;
    sessionSubscriptionProject = projectId;
    sessionGeneration += 1;
    sessionSubscriptionGeneration += 1;
    sessionUnsubscribe?.();
    sessionUnsubscribe = null;
    if (!projectId) return;

    const generation = sessionSubscriptionGeneration;
    void host.onSessions(projectId, (snapshot) => {
      if (destroyed || generation !== sessionSubscriptionGeneration || snapshot.projectId !== projectId) return;
      void sessionFocus.inspect(snapshot);
    }).then((unsubscribe) => {
      if (destroyed || generation !== sessionSubscriptionGeneration) unsubscribe();
      else sessionUnsubscribe = unsubscribe;
    }).catch(() => {
      // A missing session subscription cannot establish a trusted issue link.
    });
  };

  // Disable writes when the workspace registry changes during a save or remove action.
  const failClosedForDirectoryChange = (resolution: DirectoryResolution): void => {
    contextReady = false;
    clearIssueState();
    clearMergeRequestScope();
    syncSessionSubscription(null);
    directoryResolution = resolution;
    contextReady = false;
    association = null;
    error = 'OpenChamber project or worktree snapshots changed. Retry before saving or removing an association.';
    status = error;
    render();
  };

  // Resolve the current directory only after every registered project has a ready worktree snapshot.
  const loadDirectoryResolution = async (directory: string | null): Promise<DirectoryResolution> => {
    if (!directory) return { kind: 'unresolved', reason: 'no-directory' };

    try {
      const projectSnapshot = await host.listProjects();
      if (projectSnapshot.state !== 'ready') return { kind: 'unresolved', reason: 'incomplete' };
      const snapshots = await Promise.all(projectSnapshot.projects.map((project) => host.listWorktrees(project.id)));
      return resolveDirectory(directory, projectSnapshot, snapshots);
    } catch {
      return { kind: 'unresolved', reason: 'incomplete' };
    }
  };

  // Load and verify account and workspace state together, then read only the matching persisted scope.
  const refreshContext = async (generation: number, previousAccount: GitLabUser | null = null, verifiedAccount?: GitLabUser): Promise<void> => {
    const current = context;
    const connection = current.connection;
    invalidateAccountScope();
    if (!connection?.connected) {
      directoryResolution = current.directory
        ? { kind: 'unresolved', reason: 'incomplete' }
        : { kind: 'unresolved', reason: 'no-directory' };
      projects = [];
      selectedId = null;
      status = '';
      render();
      return;
    }

    // Start a fresh verification cycle without exposing stale account or association state.
    projects = [];
    selectedId = null;
    error = null;
    status = 'Verifying the GitLab connection and OpenChamber directory…';
    render();

    // Avoid blocking account verification on a directory that may not be open yet.
    const [userResult, resolution] = await Promise.allSettled([
      verifiedAccount ? Promise.resolve(verifiedAccount) : getCurrentUser(host),
      loadDirectoryResolution(current.directory),
    ]);
    if (destroyed || generation !== contextGeneration) return;

    if (resolution.status === 'fulfilled') directoryResolution = resolution.value;
    else directoryResolution = { kind: 'unresolved', reason: 'incomplete' };

    if (userResult.status === 'rejected') {
      account = null;
      contextReady = false;
      error = gitLabErrorMessage(userResult.reason);
      status = error;
      render();
      return;
    }

    // Detect identity changes before reading storage so old mappings cannot activate for a new account.
    const verifiedUser = userResult.value;
    const previousIdentity = lastVerifiedIdentity ?? (previousAccount ? getAccountIdentity(previousAccount) : null);
    if (previousIdentity && !sameAccountIdentity(previousIdentity, verifiedUser)) {
      identityRequiringReselect = getAccountIdentity(verifiedUser);
    }
    lastVerifiedIdentity = getAccountIdentity(verifiedUser);

    // Require a new selection before this account can reuse a saved mapping.
    const mustReselect = identityRequiringReselect !== null && sameAccountIdentity(identityRequiringReselect, verifiedUser);

    // Restore only scoped mappings that still resolve through GitLab's read-only project API.
    const scope = getAssociationScope(directoryResolution, verifiedUser);
    let loadedAssociation: SavedAssociation | null = null;
    let associationError: string | null = null;
    let authenticationFailure = false;

    if (scope && !mustReselect) {
      let savedAssociation: SavedAssociation | null = null;
      try {
        savedAssociation = await readAssociation(host.storage, scope);
      } catch {
        associationError = 'The saved association could not be read. Retry before changing it.';
      }

      if (savedAssociation && !destroyed && generation === contextGeneration) {
        try {
          loadedAssociation = await getProjectById(host, savedAssociation.id);
        } catch (accessError) {
          associationError = gitLabErrorMessage(accessError);
          authenticationFailure = isDisconnectedError(accessError);
        }
      }
    } else if (directoryResolution.kind === 'unknown' && !mustReselect && sessionChoice
      && sessionChoice.directory === current.directory
      && sessionChoice.accountId === verifiedUser.id
      && sessionChoice.variant === verifiedUser.variant) {
      try {
        loadedAssociation = await getProjectById(host, sessionChoice.project.id);
      } catch (accessError) {
        associationError = gitLabErrorMessage(accessError);
        authenticationFailure = isDisconnectedError(accessError);
      }
    }

    // Publish verified state only after identity and association checks finish.
    if (destroyed || generation !== contextGeneration) return;
    account = verifiedUser;
    association = loadedAssociation;
    error = associationError;
    if (sessionChoice && (sessionChoice.directory !== current.directory || sessionChoice.accountId !== verifiedUser.id || sessionChoice.variant !== verifiedUser.variant)) {
      sessionChoice = null;
    }
    if (directoryResolution.kind === 'unknown' && sessionChoice && loadedAssociation) sessionChoice.project = loadedAssociation;

    if (authenticationFailure) {
      syncSessionSubscription(null);
      account = null;
      contextReady = false;
      status = associationError ?? 'GitLab disconnected during project verification. Reconnect in Settings → Integrations.';
      render();
      return;
    }

    // Render verified state only after every applicable host and GitLab check completes.
    contextReady = true;
    syncMergeRequestScope();
    syncSessionFocusScope();
    syncSessionSubscription(directoryResolution.kind === 'registered' && association ? directoryResolution.project.id : null);
    // Start the issue list as soon as a saved association is verified.
    if (association) void loadIssues();
    if (currentSession) void sessionFocus.inspect();
    status = mustReselect
      ? 'GitLab account changed. Search and reselect a project before using an association.'
      : '';
    render();
  };

  // Replace verified context after the host bridge reports a different numeric account or variant.
  const reloadAfterIdentityChange = (verifiedUser: GitLabUser): void => {
    identityRequiringReselect = getAccountIdentity(verifiedUser);
    contextGeneration += 1;
    searchGeneration += 1;
    actionGeneration += 1;
    contextReady = false;
    clearIssueState();
    clearMergeRequestScope();
    syncSessionSubscription(null);
    account = null;
    association = null;
    projects = [];
    selectedId = null;
    searching = false;
    busy = false;
    error = null;
    directoryResolution = context.directory
      ? { kind: 'unresolved', reason: 'incomplete' }
      : { kind: 'unresolved', reason: 'no-directory' };
    status = 'GitLab account changed. Verifying the new account before requiring a fresh project selection.';
    render();
    void refreshContext(contextGeneration, null, verifiedUser);
  };

  // Apply lifecycle changes once and invalidate every pending request tied to the old context.
  const updateContext = (directory: string | null, connection: GuestConnection | null, reverifyConnection = false): void => {
    const sameDirectory = context.directory === directory;
    const sameConnection = context.connection?.connected === connection?.connected && context.connection?.account === connection?.account;
    if (sameDirectory && sameConnection && !reverifyConnection) return;

    const previousAccount = account;
    context = { directory, connection };
    contextGeneration += 1;
    searchGeneration += 1;
    actionGeneration += 1;
    clearIssueState();
    syncSessionSubscription(null);
    contextReady = false;
    searching = false;
    busy = false;
    projects = [];
    selectedId = null;
    error = null;
    association = null;
    clearMergeRequestScope();
    directoryResolution = directory
      ? { kind: 'unresolved', reason: 'incomplete' }
      : { kind: 'unresolved', reason: 'no-directory' };
    if (!sameDirectory) sessionChoice = null;
    void refreshContext(contextGeneration, previousAccount);
  };

  // Search only after both the connected account and local-directory scope are verified.
  const search = async (query: string): Promise<void> => {
    const generation = ++searchGeneration;
    const activeContext = contextGeneration;
    projects = [];
    selectedId = null;
    error = null;
    if (!query.trim()) {
      searching = false;
      status = '';
      render();
      return;
    }
    if (!contextReady || !account || !context.connection?.connected || !canUseDirectory(directoryResolution)) {
      searching = false;
      status = '';
      render();
      return;
    }

    searching = true;
    status = 'Searching visible GitLab projects…';
    render();

    try {
      const found = await searchVisibleProjects(host, query);
      if (destroyed || generation !== searchGeneration || activeContext !== contextGeneration) return;
      projects = found;
      selectedId = association?.id ?? null;
      status = found.length ? `Found ${found.length} visible GitLab project${found.length === 1 ? '' : 's'}.` : 'No visible projects matched that search.';
    } catch (requestError) {
      if (destroyed || generation !== searchGeneration || activeContext !== contextGeneration) return;
      error = gitLabErrorMessage(requestError);
      status = error;
      if (isDisconnectedError(requestError)) handleMergeRequestAuthenticationFailure();
    } finally {
      if (!destroyed && generation === searchGeneration && activeContext === contextGeneration) {
        searching = false;
        render();
      }
    }
  };

  // Load the first verified issue page only while the connected account has an association.
  const loadIssues = async (): Promise<void> => {
    if (!canBrowseIssues() || !association) return;
    const generation = ++issueListGeneration;
    const activeContext = contextGeneration;
    const activeAssociation = association;
    issues = [];
    issuesPage = 0;
    issuesHasMore = false;
    issuesLoading = true;
    issuesLoadingMore = false;
    issuesError = null;
    issueRoute = { kind: 'list' };
    currentIssue = null;
    render();

    try {
      const page = await listProjectIssues(host, activeAssociation.id);
      if (destroyed || generation !== issueListGeneration || activeContext !== contextGeneration
        || association?.id !== activeAssociation.id) return;
      issues = page;
      issuesPage = 1;
      issuesHasMore = page.length === 20;
    } catch (requestError) {
      if (destroyed || generation !== issueListGeneration || activeContext !== contextGeneration) return;
      issuesError = gitLabErrorMessage(requestError);
      if (isDisconnectedError(requestError)) handleMergeRequestAuthenticationFailure();
    } finally {
      if (!destroyed && generation === issueListGeneration && activeContext === contextGeneration) {
        issuesLoading = false;
        render();
      }
    }
  };

  // Append one bounded page and deduplicate identities before exposing its rows.
  const loadMoreIssues = async (): Promise<void> => {
    if (!canBrowseIssues() || sessionFocus.snapshot().kind !== 'none'
      || !association || !issuesHasMore || issuesLoading || issuesLoadingMore) return;
    const generation = ++issueListGeneration;
    const activeContext = contextGeneration;
    const activeAssociation = association;
    const pageNumber = issuesPage + 1;
    issuesLoadingMore = true;
    issuesError = null;
    render();

    try {
      const page = await listProjectIssues(host, activeAssociation.id, pageNumber);
      if (destroyed || generation !== issueListGeneration || activeContext !== contextGeneration
        || association?.id !== activeAssociation.id) return;
      const ids = new Set(issues.map((issue) => issue.id));
      const iids = new Set(issues.map((issue) => issue.iid));
      issues = [...issues, ...page.filter((issue) => !ids.has(issue.id) && !iids.has(issue.iid))];
      issuesPage = pageNumber;
      issuesHasMore = page.length === 20;
    } catch (requestError) {
      if (destroyed || generation !== issueListGeneration || activeContext !== contextGeneration) return;
      issuesError = gitLabErrorMessage(requestError);
      if (isDisconnectedError(requestError)) handleMergeRequestAuthenticationFailure();
    } finally {
      if (!destroyed && generation === issueListGeneration && activeContext === contextGeneration) {
        issuesLoadingMore = false;
        render();
      }
    }
  };

  // Fetch a fresh detail record before switching from the issue list to its detail route.
  const selectIssue = async (iid: number): Promise<void> => {
    if (!canBrowseIssues() || sessionFocus.snapshot().kind !== 'none' || !association || !issues.some((issue) => issue.iid === iid)) return;
    workType = 'issues';
    mergeRequestBrowser.clearDetail();
    const generation = ++issueDetailGeneration;
    const activeContext = contextGeneration;
    const activeAssociation = association;
    const activeSessionGeneration = sessionGeneration;
    issueRoute = { kind: 'detail', iid, origin: 'browse' };
    currentIssue = null;
    issueLoading = true;
    issueError = null;
    worktreeError = null;
    render();

    try {
      const freshIssue = await getProjectIssue(host, activeAssociation.id, iid);
      if (destroyed || generation !== issueDetailGeneration || activeContext !== contextGeneration
        || activeSessionGeneration !== sessionGeneration || association?.id !== activeAssociation.id) return;
      currentIssue = freshIssue;
    } catch (requestError) {
      if (destroyed || generation !== issueDetailGeneration || activeContext !== contextGeneration) return;
      issueError = gitLabErrorMessage(requestError);
      if (isDisconnectedError(requestError)) handleMergeRequestAuthenticationFailure();
    } finally {
      if (!destroyed && generation === issueDetailGeneration && activeContext === contextGeneration) {
        issueLoading = false;
        render();
      }
    }
  };

  // Return from detail to the retained list without reusing stale detail data.
  const backToIssues = (): void => {
    if (sessionFocus.snapshot().kind !== 'none') return;
    workType = 'issues';
    issueDetailGeneration += 1;
    issueRoute = { kind: 'list' };
    currentIssue = null;
    issueLoading = false;
    issueError = null;
    worktreeError = null;
    render();
  };

  // Reverify a cleared account before retrying a detail read.
  const retryIssue = (iid: number): void => {
    if (sessionFocus.snapshot().kind !== 'none') return;
    if (!account) {
      retry();
      return;
    }
    if (!issues.some((issue) => issue.iid === iid)) return;
    if (issueRoute.kind !== 'detail' || issueRoute.iid !== iid) issueRoute = { kind: 'detail', iid, origin: 'browse' };
    const placeholder = issues.find((issue) => issue.iid === iid);
    if (placeholder) currentIssue = placeholder;
    void selectIssue(iid);
  };

  // Keep the selected work type separate from issue-session focus and retain each list between switches.
  const selectWorkType = (type: PanelState['workType']): void => {
    if (!canBrowseIssues() || sessionFocus.snapshot().kind !== 'none') return;
    if (workType === type) {
      if (type === 'merge-requests') void mergeRequestBrowser.ensureList();
      return;
    }

    workType = type;
    if (type === 'merge-requests') void mergeRequestBrowser.ensureList();
    else mergeRequestBrowser.clearDetail();
    render();
  };

  // Search only within the active, verified project-scoped merge-request browser.
  const searchMergeRequests = (query: string): void => {
    if (canUseMergeRequestBrowser('merge-requests-list')) void mergeRequestBrowser.search(query);
  };

  // Refresh the first merge-request page without dropping its submitted query.
  const refreshMergeRequests = (): void => {
    if (!account) {
      retry();
      return;
    }
    if (canUseMergeRequestBrowser('merge-requests-list')) void mergeRequestBrowser.refresh();
  };

  // Append only the next page committed by the merge-request browser.
  const loadMoreMergeRequests = (): void => {
    if (canUseMergeRequestBrowser('merge-requests-list')) void mergeRequestBrowser.loadMore();
  };

  // Enter detail immediately so the workspace shows loading before the host request completes.
  const selectMergeRequest = (iid: number): void => {
    if (!canUseMergeRequestBrowser('merge-requests-list') || !mergeRequestBrowser.snapshot().rows.some((row) => row.iid === iid)) return;
    workType = 'merge-requests';
    void mergeRequestBrowser.loadDetail(iid);
  };

  // Return to the retained query and rows without navigating away from merge requests.
  const backToMergeRequests = (): void => {
    const route = getWorkspaceRoute();
    if (!canBrowseIssues() || route.kind !== 'merge-request-detail' || route.origin !== 'browse') return;
    workType = 'merge-requests';
    mergeRequestBrowser.back();
  };

  // Refresh session evidence without touching the retained issue or merge-request list state.
  const refreshSessionFocus = (): void => {
    syncSessionFocusScope();
    void sessionFocus.refresh();
  };

  // Retry the selected detail, or reselect its still-visible row after a safe auth reset.
  const retryMergeRequest = (iid: number): void => {
    if (sessionFocus.snapshot().kind !== 'none') return;
    if (!account) {
      retry();
      return;
    }
    if (mergeRequestBrowser.snapshot().selectedIid === iid) void mergeRequestBrowser.retryDetail();
    else selectMergeRequest(iid);
  };

  // Load pipeline pages only after the active detail action passes the current scope check.
  const loadMergeRequestPipelines = (): void => withCurrentMergeRequestActivity(() => void mergeRequestActivity.loadPipelines());
  const loadMoreMergeRequestPipelines = (): void => withCurrentMergeRequestActivity(() => void mergeRequestActivity.loadMorePipelines());
  const refreshMergeRequestPipelines = (): void => withCurrentMergeRequestActivity(() => void mergeRequestActivity.refreshPipelines());

  // Load discussion pages only after the active detail action passes the current scope check.
  const loadMergeRequestDiscussions = (): void => withCurrentMergeRequestActivity(() => void mergeRequestActivity.loadDiscussions());
  const loadMoreMergeRequestDiscussions = (): void => withCurrentMergeRequestActivity(() => void mergeRequestActivity.loadMoreDiscussions());
  const refreshMergeRequestDiscussions = (): void => withCurrentMergeRequestActivity(() => void mergeRequestActivity.refreshDiscussions());

  // Request jobs only for a fetched pipeline with a safe provider-reported owner.
  const selectMergeRequestPipeline = (pipelineId: number | null): void => withCurrentMergeRequestActivity(() => {
    mergeRequestActivity.selectPipeline(pipelineId);
    const selected = mergeRequestActivity.snapshot();
    const pipeline = selected.pipelines.rows.find((row) => row.id === pipelineId);
    if (pipelineId !== null && selected.selectedPipelineId === pipelineId
      && pipeline?.projectId && Number.isSafeInteger(pipeline.projectId) && pipeline.projectId > 0) {
      void mergeRequestActivity.loadMoreJobs();
    }
  });

  // Keep job pagination and refresh tied to the currently selected safe pipeline owner.
  const loadMoreMergeRequestJobs = (): void => withCurrentMergeRequestActivity(() => {
    const snapshot = mergeRequestActivity.snapshot();
    const pipeline = snapshot.pipelines.rows.find((row) => row.id === snapshot.selectedPipelineId);
    if (pipeline?.projectId && Number.isSafeInteger(pipeline.projectId) && pipeline.projectId > 0) {
      void mergeRequestActivity.loadMoreJobs();
    }
  });
  const refreshMergeRequestJobs = (): void => withCurrentMergeRequestActivity(() => {
    const snapshot = mergeRequestActivity.snapshot();
    const pipeline = snapshot.pipelines.rows.find((row) => row.id === snapshot.selectedPipelineId);
    if (pipeline?.projectId && Number.isSafeInteger(pipeline.projectId) && pipeline.projectId > 0) {
      void mergeRequestActivity.refreshJobs();
    }
  });

  // Validate one selected issue, account, and registered workspace before creating a worktree session.
  const startIssueWorktree = async (iid: number): Promise<void> => {
    if (worktreeOperationLocked || startingWorktree || issueRoute.kind !== 'detail' || issueRoute.iid !== iid || !currentIssue
      || recoveryLoadState !== 'loaded' || getRecoveryView().phase !== 'clear'
      || sessionFocus.snapshot().kind !== 'none'
      || !canBrowseIssues() || !association || !account || directoryResolution.kind !== 'registered') return;
    const activeIssue = currentIssue;
    const activeAccount = account;
    const activeAssociation = association;
    const activeResolution = directoryResolution;
    const activeDirectory = context.directory;
    const generation = ++worktreeGeneration;
    const activeContext = contextGeneration;
    const activeSessionId = currentSession?.id ?? null;
    const operationId = ++worktreeOperationId;
    worktreeOperationLocked = true;
    startingWorktree = true;
    worktreeError = null;
    worktreeStatus = 'Checking the GitLab issue and registered repository…';
    render();

    let requestDispatched = false;
    try {
      const firstResolution = await loadDirectoryResolution(context.directory);
      if (!isCurrentWorktreeAction(generation, activeContext)) return;
      if (firstResolution.kind !== 'registered' || !sameDirectoryResolution(activeResolution, firstResolution)) {
        failClosedForDirectoryChange(firstResolution);
        return;
      }

      const [latestUser, latestProject, latestIssue] = await Promise.all([
        getCurrentUser(host),
        getProjectById(host, activeAssociation.id),
        getProjectIssue(host, activeAssociation.id, iid),
      ]);
      if (!isCurrentWorktreeAction(generation, activeContext)) return;
      if (!sameAccountIdentity(activeAccount, latestUser)) {
        reloadAfterIdentityChange(latestUser);
        return;
      }
      if (activeAssociation.id !== association?.id || latestProject.id !== activeAssociation.id
        || latestIssue.id !== activeIssue.id || latestIssue.iid !== activeIssue.iid
        || latestIssue.webUrl !== activeIssue.webUrl) {
        throw new Error('The GitLab project association or issue changed. Refresh it before starting a worktree.');
      }

      const finalResolution = await loadDirectoryResolution(context.directory);
      if (!isCurrentWorktreeAction(generation, activeContext)) return;
      if (finalResolution.kind !== 'registered' || !sameDirectoryResolution(activeResolution, finalResolution)) {
        failClosedForDirectoryChange(finalResolution);
        return;
      }
      if (!context.connection?.connected || !account || !sameAccountIdentity(activeAccount, account)
        || association?.id !== activeAssociation.id) return;

      // Persist the attempt identity before dispatch so a timeout cannot enable a duplicate.
      const record: RecoveryRecord = {
        version: 1,
        attemptId: globalThis.crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        origin: {
          localProjectId: activeResolution.project.id,
          directory: activeResolution.project.directory,
          accountId: activeAccount.id,
          variant: activeAccount.variant,
          gitlabProjectId: activeAssociation.id,
          iid: latestIssue.iid,
          issueId: latestIssue.id,
          webUrl: latestIssue.webUrl,
        },
        outcome: { kind: 'unresolved' },
      };
      await armRecovery(host.storage, record);
      if (destroyed) return;
      recoveryBusy = true;
      recoveryRecord = record;
      recoveryInvalid = false;
      recoveryLoadState = 'loaded';
      recoveryKnownOutcome = null;
      recoveryMessageOverride = null;
      recoveryInitiatingContext = { attemptId: record.attemptId, contextGeneration: activeContext, sessionId: activeSessionId };
      render();

      // Do not dispatch if context changed while the recovery write was in flight.
      if (!isCurrentWorktreeAction(generation, activeContext)
        || recoveryRecord?.attemptId !== record.attemptId
        || !context.connection?.connected || !account || !sameAccountIdentity(activeAccount, account)
        || association?.id !== activeAssociation.id) {
        recoveryMessageOverride = 'The attempt was recorded, but the OpenChamber context changed before dispatch. Check its outcome before releasing it.';
        startingWorktree = false;
        render();
        return;
      }

      worktreeStatus = 'Creating a worktree and new OpenChamber session…';
      render();
      worktreeRequestDispatched = true;
      requestDispatched = true;
      const result = await host.startSession({
        providerId: GITLAB_VARIANT_ID,
        id: `${GITLAB_VARIANT_ID}:issue:${activeAccount.id}:${activeAssociation.id}:${latestIssue.iid}`,
        title: latestIssue.title,
        url: latestIssue.webUrl,
        kind: 'issue',
        data: {
          v: 1,
          variant: activeAccount.variant,
          accountId: activeAccount.id,
          projectId: activeAssociation.id,
          iid: latestIssue.iid,
          issueId: latestIssue.id,
          webUrl: latestIssue.webUrl,
          recoveryAttemptId: record.attemptId,
        },
        projectId: activeResolution.project.id,
        worktree: true,
        navigation: 'preserve',
      });
      if (destroyed) return;

      // Record the host's authoritative result before any navigation attempt.
      const outcome: Exclude<RecoveryOutcome, { kind: 'unresolved' }> | null = result.sessionId === null
        ? { kind: 'retained', directory: result.directory, failure: result.failure }
        : typeof result.directory === 'string' && result.directory.length > 0
          ? { kind: 'created', sessionId: result.sessionId, directory: result.directory, linked: result.linked === true, sent: result.sent }
          : null;
      if (!outcome) {
        recoveryMessageOverride = 'OpenChamber returned a session without its worktree directory. The attempt remains unresolved; check its outcome before releasing it.';
        return;
      }

      let durableRecord: RecoveryRecord | null = null;
      try {
        durableRecord = await writeRecoveryOutcome(host.storage, record.attemptId, outcome);
      } catch {
        if (destroyed) return;
        recoveryKnownOutcome = { attemptId: record.attemptId, outcome };
        recoveryMessageOverride = null;
      }
      if (destroyed) return;
      if (durableRecord) {
        recoveryRecord = durableRecord;
        recoveryKnownOutcome = null;
        recoveryMessageOverride = null;
        recoveryBusy = false;
      }
      render();

      // Open only a durably recorded, linked, no-turn result in its unchanged initiating context.
      const initiating = recoveryInitiatingContext;
      if (durableRecord?.outcome.kind === 'created' && durableRecord.outcome.linked && durableRecord.outcome.sent === 'skipped'
        && initiating?.attemptId === record.attemptId && initiating.contextGeneration === contextGeneration
        && initiating.sessionId === (currentSession?.id ?? null) && context.directory === activeDirectory
        && context.connection?.connected && account && sameAccountIdentity(activeAccount, account)
        && association?.id === activeAssociation.id) {
        await openSessionForRecovery(durableRecord, true);
      }
    } catch (requestError) {
      if (destroyed) return;
      if (requestDispatched) {
        // A rejected or timed-out host request may still have created the worktree.
        recoveryMessageOverride = 'OpenChamber did not confirm the result. The attempt remains unresolved; check its outcome and do not retry creation.';
      } else if (isCurrentWorktreeAction(generation, activeContext) && isDisconnectedError(requestError)) {
        // Revoke the denied account before any worktree attempt can be retried.
        handleMergeRequestAuthenticationFailure();
      } else if (isCurrentWorktreeAction(generation, activeContext)) {
        worktreeError = gitLabErrorMessage(requestError);
        worktreeStatus = '';
      }
      if (!requestDispatched && recoveryLoadState === 'loaded' && !recoveryRecord && !recoveryInvalid) void refreshRecoveryRead();
    } finally {
      if (!destroyed && operationId === worktreeOperationId) {
        worktreeOperationLocked = false;
        recoveryBusy = false;
        startingWorktree = false;
        worktreeRequestDispatched = false;
        render();
      }
    }
  };

  // Open only a session already recorded as created; this path never starts another worktree.
  const openSessionForRecovery = async (record: RecoveryRecord, automatic = false): Promise<void> => {
    if (destroyed || record.outcome.kind !== 'created' || recoveryBusy) return;
    recoveryBusy = true;
    render();
    try {
      await host.openSession(record.outcome.sessionId);
      if (destroyed) return;
      recoveryMessageOverride = null;
    } catch {
      if (destroyed) return;
      recoveryMessageOverride = automatic
        ? 'The session was created and saved, but OpenChamber could not open it. Use Open created session to try navigation again.'
        : 'OpenChamber could not open the created session. The recovery record remains; retry opening it without creating another worktree.';
    } finally {
      if (!destroyed) {
        recoveryBusy = false;
        render();
      }
    }
  };

  // Retry a failed recovery read or inspect exact host snapshots without replaying creation.
  const checkWorktreeOutcome = async (): Promise<void> => {
    const record = recoveryRecord;
    if (destroyed || recoveryBusy || record?.outcome.kind !== 'unresolved' || recoveryLoadState !== 'loaded') return;
    const generation = ++recoveryActionGeneration;
    recoveryBusy = true;
    recoveryMessageOverride = null;
    render();

    try {
      // Save a result already returned by startSession before trying snapshot reconciliation.
      const knownOutcome = recoveryKnownOutcome?.attemptId === record.attemptId ? recoveryKnownOutcome.outcome : null;
      if (knownOutcome) {
        const persisted = await writeRecoveryOutcome(host.storage, record.attemptId, knownOutcome);
        if (destroyed || generation !== recoveryActionGeneration) return;
        recoveryRecord = persisted;
        recoveryKnownOutcome = null;
        recoveryMessageOverride = null;
        return;
      }

      const reconciled = await checkRecovery(host, record);
      if (destroyed || generation !== recoveryActionGeneration) return;
      if (reconciled.outcome.kind === 'unresolved') {
        recoveryMessageOverride = 'No single exact created session was confirmed from complete snapshots. The attempt remains locked; check again later or explicitly release it.';
        return;
      }

      // Snapshot evidence becomes authoritative only after its outcome is stored durably.
      try {
        recoveryRecord = await writeRecoveryOutcome(host.storage, record.attemptId, reconciled.outcome);
        recoveryKnownOutcome = null;
        recoveryMessageOverride = null;
      } catch {
        recoveryKnownOutcome = { attemptId: record.attemptId, outcome: reconciled.outcome };
        recoveryMessageOverride = null;
      }
    } catch {
      if (!destroyed && generation === recoveryActionGeneration) {
        recoveryMessageOverride = 'The recovery outcome could not be saved. The attempt remains locked; retry the check before releasing it.';
      }
    } finally {
      if (!destroyed && generation === recoveryActionGeneration) {
        recoveryBusy = false;
        render();
      }
    }
  };

  // Retry navigation for one durably created session without repeating the start request.
  const openCreatedSession = (): void => {
    const record = recoveryRecord;
    if (!destroyed && record?.outcome.kind === 'created' && !recoveryBusy) void openSessionForRecovery(record);
  };

  // Retry the initial global storage read while keeping creation disabled until it succeeds.
  const retryRecoveryRead = (): void => {
    if (!destroyed && recoveryLoadState === 'read-error' && !recoveryBusy) void refreshRecoveryRead();
  };

  // Release only the user-confirmed recovery identity, then verify that its key is actually absent.
  const releaseWorktreeRecovery = async (): Promise<void> => {
    if (destroyed || recoveryBusy || startingWorktree || worktreeOperationLocked) return;
    let target: RecoveryReleaseTarget | null = null;
    if (recoveryInvalid) target = { kind: 'invalid' };
    else if (recoveryLoadState === 'loaded' && recoveryRecord) target = { kind: 'record', attemptId: recoveryRecord.attemptId };
    if (!target) return;

    const generation = ++recoveryActionGeneration;
    recoveryBusy = true;
    recoveryMessageOverride = null;
    render();
    try {
      await releaseRecovery(host.storage, target, () => !destroyed && generation === recoveryActionGeneration);
      if (destroyed || generation !== recoveryActionGeneration) return;
      const result = await readRecovery(host.storage);
      if (destroyed || generation !== recoveryActionGeneration) return;
      if (result.kind === 'empty') {
        applyRecoveryRead(result);
      } else {
        recoveryLoadState = 'loaded';
        recoveryRecord = result.kind === 'valid' ? result.record : null;
        recoveryInvalid = result.kind === 'invalid';
        recoveryMessageOverride = 'The recovery key was not confirmed empty. Review the current record before taking another action.';
      }
    } catch {
      if (!destroyed && generation === recoveryActionGeneration) {
        const knownOutcome = recoveryKnownOutcome;
        try {
          const current = await readRecovery(host.storage);
          if (destroyed || generation !== recoveryActionGeneration) return;
          applyRecoveryRead(current);
          if (current.kind === 'valid' && current.record.outcome.kind === 'unresolved'
            && target.kind === 'record' && current.record.attemptId === target.attemptId) recoveryKnownOutcome = knownOutcome;
          recoveryMessageOverride = 'OpenChamber could not confirm recovery release. Review the current recovery state before continuing.';
        } catch {
          if (destroyed || generation !== recoveryActionGeneration) return;
          recoveryLoadState = 'read-error';
          recoveryRecord = null;
          recoveryInvalid = false;
          recoveryKnownOutcome = knownOutcome;
          recoveryMessageOverride = null;
        }
      }
    } finally {
      if (!destroyed && generation === recoveryActionGeneration) {
        recoveryBusy = false;
        render();
      }
    }
  };

  // Reverify a cleared account after an authorization failure before retrying the list.
  const retryIssues = (): void => {
    if (sessionFocus.snapshot().kind !== 'none') return;
    if (!account) {
      retry();
      return;
    }
    void loadIssues();
  };

  // Ignore action results after the directory, account, session, or controller changes.
  const isCurrentWorktreeAction = (generation: number, activeContext: number): boolean =>
    !destroyed && generation === worktreeGeneration && activeContext === contextGeneration;

  // Re-fetch the selected project before storing it, and keep unknown directories in session memory only.
  const save = async (projectId: number): Promise<void> => {
    const candidate = projects.find((project) => project.id === projectId);
    if (!candidate || !canUseDirectory(directoryResolution) || !contextReady || !account || !context.connection?.connected || busy) return;

    const generation = ++actionGeneration;
    const activeContext = contextGeneration;
    const activeAccount = account;
    const activeResolution = directoryResolution;
    clearMergeRequestScope();
    busy = true;
    error = null;
    status = 'Verifying the selected GitLab project…';
    render();

    try {
      // Recheck snapshots before network work and before persistence to avoid stale directory scope.
      const firstResolution = await loadDirectoryResolution(context.directory);
      if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;
      if (!sameDirectoryResolution(activeResolution, firstResolution)) {
        failClosedForDirectoryChange(firstResolution);
        return;
      }

      // Refresh the selected numeric ID and full namespace before saving.
      const verifiedProject = await getProjectById(host, projectId);
      if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;

      // Confirm the local repository still resolves from complete snapshots.
      const finalResolution = await loadDirectoryResolution(context.directory);
      if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;
      if (!sameDirectoryResolution(activeResolution, finalResolution)) {
        failClosedForDirectoryChange(finalResolution);
        return;
      }

      // Prepare the storage payload before the final identity check.
      const scope = getAssociationScope(activeResolution, activeAccount);
      const prepared = scope ? await prepareAssociation(scope, verifiedProject) : null;
      if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;

      // Confirm the token still resolves to the same numeric GitLab account before persistence.
      const latestUser = await getCurrentUser(host);
      if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;
      if (!sameAccountIdentity(activeAccount, latestUser)) {
        reloadAfterIdentityChange(latestUser);
        return;
      }
      account = latestUser;

      // Keep unknown-directory choices in memory and persist only registered repositories.
      if (activeResolution.kind === 'unknown') {
        sessionChoice = {
          directory: context.directory ?? '',
          accountId: activeAccount.id,
          variant: activeAccount.variant,
          project: verifiedProject,
        };
      } else if (activeResolution.kind === 'registered') {
        if (!prepared) return;
        const written = await writePreparedAssociation(host.storage, prepared, () => !destroyed
          && generation === actionGeneration
          && activeContext === contextGeneration
          && Boolean(context.connection?.connected)
          && account?.id === activeAccount.id
          && account.variant === activeAccount.variant);
        if (!written) return;
        if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;
      } else {
        return;
      }

      // Publish the association only after its save or session-only choice is complete.
      if (identityRequiringReselect && sameAccountIdentity(identityRequiringReselect, activeAccount)) identityRequiringReselect = null;
      clearIssueState();
      association = verifiedProject;
      syncMergeRequestScope();
      syncSessionFocusScope();
      syncSessionSubscription(activeResolution.kind === 'registered' ? activeResolution.project.id : null);
      // Load the first page after either a saved or session-only choice is verified.
      void loadIssues();
      if (currentSession) void sessionFocus.inspect();
      selectedId = verifiedProject.id;
      status = activeResolution.kind === 'unknown'
        ? `Using ${verifiedProject.path} for this session only.`
        : `Saved association with ${verifiedProject.path}.`;
    } catch (requestError) {
      if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;
      error = gitLabErrorMessage(requestError);
      status = error;
      if (isDisconnectedError(requestError)) account = null;
    } finally {
      if (!destroyed && generation === actionGeneration && activeContext === contextGeneration) {
        busy = false;
        syncMergeRequestScope();
        render();
      }
    }
  };

  // Disable actions when identity verification or a storage delete has an uncertain result.
  const failClosedForRemove = (requestError: unknown, storageFailure = false): void => {
    contextReady = false;
    clearIssueState();
    clearMergeRequestScope();
    syncSessionSubscription(null);
    association = null;
    projects = [];
    selectedId = null;
    if (!storageFailure && isDisconnectedError(requestError)) account = null;
    error = storageFailure
      ? 'OpenChamber could not confirm whether the association was removed. Retry to refresh it before taking further action.'
      : requestError instanceof GitLabApiError
        ? gitLabErrorMessage(requestError)
        : 'GitLab account verification failed before removal. Retry before removing the association.';
    status = error;
    render();
  };

  // Remove only the verified registered association, or clear an in-memory session-only choice.
  const remove = async (): Promise<void> => {
    if (!association || !contextReady || !account || !context.connection?.connected || busy) return;
    const generation = ++actionGeneration;
    const activeContext = contextGeneration;
    const activeResolution = directoryResolution;
    const activeAccount = account;
    clearMergeRequestScope();
    busy = true;
    error = null;
    status = 'Removing the current association…';
    render();

    let storageDeleteStarted = false;
    try {
      // Confirm the mapping still belongs to this exact ready workspace before deleting it.
      const currentResolution = await loadDirectoryResolution(context.directory);
      if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;
      if (!sameDirectoryResolution(activeResolution, currentResolution)) {
        failClosedForDirectoryChange(currentResolution);
        return;
      }

      if (activeResolution.kind === 'registered') {
        const scope = getAssociationScope(activeResolution, activeAccount);
        if (!scope) return;

        // Prepare the bounded key before rechecking account identity for the deletion.
        const storageKey = await associationStorageKey(scope);
        if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;

        // Recheck the account before deleting a mapping created under its earlier identity.
        const latestUser = await getCurrentUser(host);
        if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;
        if (!sameAccountIdentity(activeAccount, latestUser)) {
          reloadAfterIdentityChange(latestUser);
          return;
        }
        account = latestUser;

        // Start deletion only while the verified controller context still matches this action.
        if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration
          || !context.connection?.connected || !account || !sameAccountIdentity(activeAccount, account)) return;
        storageDeleteStarted = true;
        await host.storage.delete(storageKey);
      } else if (activeResolution.kind === 'unknown') {
        // Unknown-directory choices have no persistent record to delete.
        sessionChoice = null;
      } else {
        return;
      }

      if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;
      association = null;
      clearIssueState();
      syncSessionSubscription(null);
      selectedId = null;
      status = activeResolution.kind === 'unknown' ? 'Session choice cleared.' : 'Association removed from this local repository and its worktrees.';
    } catch (requestError) {
      if (destroyed || generation !== actionGeneration || activeContext !== contextGeneration) return;
      failClosedForRemove(requestError, storageDeleteStarted);
    } finally {
      if (!destroyed && generation === actionGeneration && activeContext === contextGeneration) {
        busy = false;
        render();
      }
    }
  };

  // Hide every account-scoped record immediately, then verify the host before restoring eligibility.
  function handleMergeRequestAuthenticationFailure(): void {
    if (destroyed) return;
    invalidateAccountScope();
    projects = [];
    selectedId = null;
    syncSessionSubscription(null);
    status = 'GitLab authorization may have expired. Verifying the account before restoring project data.';
    render();
    // Recheck once per failure sequence without reopening the budget on this internal retry.
    if (!automaticAuthRetryAttempted) {
      automaticAuthRetryAttempted = true;
      retry(false);
    }
  }

  // Reverify host context and snapshots, resetting the auth budget only for an explicit user retry.
  const retry = (startNewAuthRetryCycle = true): void => {
    if (startNewAuthRetryCycle) automaticAuthRetryAttempted = false;
    contextGeneration += 1;
    searchGeneration += 1;
    actionGeneration += 1;
    searching = false;
    busy = false;
    error = null;
    void refreshContext(contextGeneration, account);
  };

  // Register host lifecycle listeners before waiting for the first ready snapshot.
  const panel = createPanel(root, {
    search: (query) => void search(query),
    save: (id) => void save(id),
    remove: () => void remove(),
    retry,
    loadIssues: () => {
      // Ignore stale browse controls while session verification owns the workspace.
      if (sessionFocus.snapshot().kind === 'none') void loadIssues();
    },
    loadMoreIssues: () => void loadMoreIssues(),
    selectIssue: (iid) => void selectIssue(iid),
    backToIssues,
    retryIssues,
    retryIssue,
    selectWorkType,
    searchMergeRequests,
    refreshMergeRequests,
    refreshSessionFocus,
    loadMoreMergeRequests,
    selectMergeRequest,
    backToMergeRequests,
    retryMergeRequest,
    loadMergeRequestPipelines,
    loadMoreMergeRequestPipelines,
    refreshMergeRequestPipelines,
    loadMergeRequestDiscussions,
    loadMoreMergeRequestDiscussions,
    refreshMergeRequestDiscussions,
    selectMergeRequestPipeline,
    loadMoreMergeRequestJobs,
    refreshMergeRequestJobs,
    startIssueWorktree: (iid) => void startIssueWorktree(iid),
    retryRecoveryRead,
    checkWorktreeOutcome: () => void checkWorktreeOutcome(),
    openCreatedSession,
    releaseWorktreeRecovery: () => void releaseWorktreeRecovery(),
  });
  const unsubscribeReady = host.onReady((ready: HostReadyContext) => {
    // Publish the first host snapshot even when both its directory and connection are empty.
    hostReady = true;
    if (!recoveryReadStarted) {
      recoveryReadStarted = true;
      void refreshRecoveryRead();
    }
    updateContext(ready.directory, ready.connection, true);
  });
  const unsubscribeDirectory = host.onDirectory((directory) => updateContext(directory, context.connection));
  const unsubscribeConnection = host.onConnection((connection) => updateContext(context.directory, connection, true));
  const unsubscribeSession = host.onSession((session) => {
    const previousSessionId = currentSession?.id ?? null;
    currentSession = session;
    if (previousSessionId !== (session?.id ?? null)) {
      sessionGeneration += 1;
      // Revoke the old focused content before binding verification to the new session.
      sessionFocusRevision += 1;
      // Stop only a pre-dispatch worktree action while keeping its global arm lock.
      if (startingWorktree && !worktreeRequestDispatched) worktreeGeneration += 1;
      sessionFocus.setScope(null);
      clearBrowseDetailsForFocusTransition();
      syncSessionFocusScope();
      render();
    }
    if (session) void sessionFocus.inspect();
  });

  // Keep empty state actionable while listeners wait for their first host snapshot.
  render();

  return {
    destroy() {
      // Ignore repeated teardown requests.
      if (destroyed) return;
      destroyed = true;
      contextGeneration += 1;
      searchGeneration += 1;
      actionGeneration += 1;
      sessionFocus.destroy();
      clearIssueState();
      syncSessionSubscription(null);
      mergeRequestBrowser.destroy();
      mergeRequestActivity.destroy();

      // Release host subscriptions and panel event handlers together.
      unsubscribeReady();
      unsubscribeDirectory();
      unsubscribeConnection();
      unsubscribeSession();
      sessionUnsubscribe?.();
      sessionUnsubscribe = null;
      panel.destroy();
    },
  };
}

// Identify whether a request failure means the protected integration token is no longer usable.
function isDisconnectedError(error: unknown): boolean {
  return error instanceof GitLabApiError && error.code === 'disconnected';
}

// Only registered local repositories receive persistent keys; unknown directories remain session scoped.
function getAssociationScope(resolution: DirectoryResolution, account: GitLabUser | null): AssociationScope | null {
  if (resolution.kind !== 'registered' || !account) return null;
  return { projectId: resolution.project.id, accountId: account.id, variant: account.variant };
}

// Compare verified account identity without trusting the host's display label.
function sameAccountIdentity(first: AccountIdentity, second: AccountIdentity): boolean {
  return first.id === second.id && first.variant === second.variant;
}

// Keep only the numeric account and variant in the reselect guard.
function getAccountIdentity(user: GitLabUser): AccountIdentity {
  return { id: user.id, variant: user.variant };
}

// Keep the eligibility check shared by search and save actions.
function canUseDirectory(resolution: DirectoryResolution): boolean {
  return resolution.kind === 'registered' || resolution.kind === 'unknown';
}

// Require the same registration kind and stable project ID across fresh snapshots.
function sameDirectoryResolution(first: DirectoryResolution, second: DirectoryResolution): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === 'registered' && second.kind === 'registered') return first.project.id === second.project.id;
  return first.kind === 'unknown' && second.kind === 'unknown';
}
