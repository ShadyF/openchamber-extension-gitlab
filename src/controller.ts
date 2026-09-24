import type { GuestConnection, HostClient, HostReadyContext } from '@openchamber/sdk';
import { createPanel, type PanelState } from './panel.js';
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
import { getCurrentUser, getProjectById, GitLabApiError, gitLabErrorMessage, searchVisibleProjects, type GitLabProject, type GitLabUser } from './gitlab.js';

export type GitLabPanelHost = Pick<HostClient, 'request' | 'storage' | 'listProjects' | 'listWorktrees' | 'onReady' | 'onDirectory' | 'onConnection'>;

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
  let status = 'Waiting for OpenChamber context.';
  let error: string | null = null;
  let destroyed = false;

  // Render a fresh state snapshot while keeping the panel instance and its input alive.
  const render = () => {
    const isUnknown = directoryResolution.kind === 'unknown';
    const canUseDirectory = directoryResolution.kind === 'registered' || isUnknown;
    const state: PanelState = {
      account: account?.username ?? null,
      directory: context.directory,
      repository: directoryResolution.kind === 'registered' ? directoryResolution.project.name : null,
      association,
      projects: projects.map((project) => ({ ...project })),
      selectedId,
      busy,
      searching,
      status,
      error,
      canSave: contextReady && Boolean(account) && Boolean(context.connection?.connected) && canUseDirectory && projects.length > 0 && !busy,
      canRemove: contextReady && Boolean(account) && Boolean(context.connection?.connected) && canUseDirectory && Boolean(association) && !busy,
      isUnknown,
    };
    panel.render(state);
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

  // Disable writes when the workspace registry changes during a save or remove action.
  const failClosedForDirectoryChange = (resolution: DirectoryResolution): void => {
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
    if (!connection?.connected) {
      contextReady = false;
      account = null;
      directoryResolution = current.directory
        ? { kind: 'unresolved', reason: 'incomplete' }
        : { kind: 'unresolved', reason: 'no-directory' };
      association = null;
      projects = [];
      selectedId = null;
      status = 'Connect GitLab in Settings → Integrations before using this panel.';
      render();
      return;
    }

    // Start a fresh verification cycle without exposing stale account or association state.
    contextReady = false;
    account = null;
    association = null;
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
      account = null;
      contextReady = false;
      status = associationError ?? 'GitLab disconnected during project verification. Reconnect in Settings → Integrations.';
      render();
      return;
    }

    // Render verified state only after every applicable host and GitLab check completes.
    contextReady = true;
    status = mustReselect
      ? 'GitLab account changed. Search and reselect a project before using an association.'
      : directoryStatus(directoryResolution);
    render();
  };

  // Replace verified context after the host bridge reports a different numeric account or variant.
  const reloadAfterIdentityChange = (verifiedUser: GitLabUser): void => {
    identityRequiringReselect = getAccountIdentity(verifiedUser);
    contextGeneration += 1;
    searchGeneration += 1;
    actionGeneration += 1;
    contextReady = false;
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
    contextReady = false;
    searching = false;
    busy = false;
    projects = [];
    selectedId = null;
    error = null;
    association = null;
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
      status = directoryStatus(directoryResolution);
      render();
      return;
    }
    if (!contextReady || !account || !context.connection?.connected || !canUseDirectory(directoryResolution)) {
      searching = false;
      status = 'Verify the GitLab account and OpenChamber directory before searching.';
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
      if (isDisconnectedError(requestError)) account = null;
    } finally {
      if (!destroyed && generation === searchGeneration && activeContext === contextGeneration) {
        searching = false;
        render();
      }
    }
  };

  // Re-fetch the selected project before storing it, and keep unknown directories in session memory only.
  const save = async (projectId: number): Promise<void> => {
    const candidate = projects.find((project) => project.id === projectId);
    if (!candidate || !canUseDirectory(directoryResolution) || !contextReady || !account || !context.connection?.connected || busy) return;

    const generation = ++actionGeneration;
    const activeContext = contextGeneration;
    const activeAccount = account;
    const activeResolution = directoryResolution;
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
      association = verifiedProject;
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
        render();
      }
    }
  };

  // Disable actions when identity verification or a storage delete has an uncertain result.
  const failClosedForRemove = (requestError: unknown, storageFailure = false): void => {
    contextReady = false;
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
      selectedId = null;
      status = activeResolution.kind === 'unknown' ? 'Cleared the session-only choice.' : directoryStatus(activeResolution);
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

  // Retry re-verifies both host context and snapshots instead of reusing potentially stale state.
  const retry = (): void => {
    contextGeneration += 1;
    searchGeneration += 1;
    actionGeneration += 1;
    searching = false;
    busy = false;
    error = null;
    void refreshContext(contextGeneration, account);
  };

  // Register host lifecycle listeners before waiting for the first ready snapshot.
  const panel = createPanel(root, { search: (query) => void search(query), save: (id) => void save(id), remove: () => void remove(), retry });
  const unsubscribeReady = host.onReady((ready: HostReadyContext) => updateContext(ready.directory, ready.connection));
  const unsubscribeDirectory = host.onDirectory((directory) => updateContext(directory, context.connection));
  const unsubscribeConnection = host.onConnection((connection) => updateContext(context.directory, connection, true));

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

      // Release host subscriptions and panel event handlers together.
      unsubscribeReady();
      unsubscribeDirectory();
      unsubscribeConnection();
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
