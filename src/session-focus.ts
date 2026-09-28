import type { GuestSessionsSnapshot, JsonValue } from '@openchamber/sdk';
import { discoverRelatedMergeRequest, type RelatedMergeRequestDiscoveryResult } from './related-merge-request.js';
import { GitLabApiError, GITLAB_VARIANT_ID, type GitLabIssue, type GitLabMergeRequest } from './gitlab.js';
import { classifySessionMergeRequestItem, type SessionMergeRequestIdentity } from './session-mr-link.js';

export type SessionFocusScope = Readonly<{
  revision: number;
  sessionId: string;
  directory: string;
  localProjectId: string;
  accountId: number;
  variant: string;
  projectId: number;
}>;

export type SessionFocusSnapshot =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'checking'; scope: SessionFocusScope }>
  | Readonly<{ kind: 'explicit-unavailable'; scope: SessionFocusScope; reason: 'invalid' | 'unavailable' }>
  | Readonly<{
    kind: 'verified-issue';
    scope: SessionFocusScope;
    issue: GitLabIssue;
    relatedCheck: 'none' | 'ambiguous' | 'outside-project' | 'incomplete' | 'unavailable' | 'explicit-invalid' | 'explicit-unavailable';
  }>
  | Readonly<{
    kind: 'verified-MR';
    scope: SessionFocusScope;
    mergeRequest: GitLabMergeRequest;
    provenance: 'explicit-session' | 'related-issue';
    issue: GitLabIssue | null;
  }>;

export type CreateSessionFocusOptions = {
  listSessions: (localProjectId: string) => Promise<GuestSessionsSnapshot>;
  getIssue: (projectId: number, iid: number) => Promise<GitLabIssue>;
  getMergeRequest: (projectId: number, iid: number) => Promise<GitLabMergeRequest>;
  listRelatedPage: (issueProjectId: number, issueIid: number, page: number) => Promise<GitLabMergeRequest[]>;
  onChange: (snapshot: SessionFocusSnapshot) => void;
  onAuthenticationFailure: () => void;
};

type IssueIdentity = {
  v: 1;
  variant: string;
  accountId: number;
  projectId: number;
  iid: number;
  issueId: number;
  webUrl: string;
};

type RelevantItemResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; identity: SessionMergeRequestIdentity };

type IssueItemResult = { identity: IssueIdentity; id: string } | null;

// Keep extension-owned identity data separate from provider display content.
function isStableId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// Accept only the strict issue item shape written by this extension.
function isIssueIdentity(value: JsonValue | undefined): value is IssueIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, JsonValue>;
  return identity.v === 1
    && typeof identity.variant === 'string'
    && isStableId(identity.accountId)
    && isStableId(identity.projectId)
    && isStableId(identity.iid)
    && isStableId(identity.issueId)
    && typeof identity.webUrl === 'string'
    && identity.webUrl.startsWith('https://');
}

// Ignore titles and activity so routine session updates do not restart verification.
function snapshotKey(snapshot: GuestSessionsSnapshot): string {
  return JSON.stringify({
    projectId: snapshot.projectId,
    state: snapshot.state,
    coverage: snapshot.coverage,
    sessions: snapshot.sessions.map((session) => ({
      id: session.id,
      projectId: session.projectId,
      directory: session.directory,
      items: session.items,
    })),
  });
}

// Compare scope fields instead of object identity because callers may rebuild the value.
function sameScope(left: SessionFocusScope | null, right: SessionFocusScope | null): boolean {
  return left === right || Boolean(left && right
    && left.revision === right.revision
    && left.sessionId === right.sessionId
    && left.directory === right.directory
    && left.localProjectId === right.localProjectId
    && left.accountId === right.accountId
    && left.variant === right.variant
    && left.projectId === right.projectId);
}

// Convert the bounded discovery result to the public issue fallback status.
function relatedOutcome(result: RelatedMergeRequestDiscoveryResult): 'none' | 'ambiguous' | 'outside-project' | 'incomplete' | 'unavailable' {
  if (result.kind === 'related' || result.kind === 'cancelled') return 'unavailable';
  return result.kind;
}

// Classify only current authentication failures; resource-local failures remain local.
function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof GitLabApiError && error.code === 'disconnected';
}

// Create one in-memory authority for focused session issue and merge-request links.
export function createSessionFocus(options: CreateSessionFocusOptions) {
  let scope: SessionFocusScope | null = null;
  let current: SessionFocusSnapshot = { kind: 'none' };
  let generation = 0;
  let lastSnapshotKey: string | null = null;
  let pendingSessionsRead: { scope: SessionFocusScope; generation: number; promise: Promise<GuestSessionsSnapshot> } | null = null;
  let destroyed = false;

  // Publish immutable state only while the captured scope and request generation remain current.
  const publish = (next: SessionFocusSnapshot): void => {
    if (destroyed) return;
    current = next;
    options.onChange(next);
  };

  // Check every captured identity dimension before accepting asynchronous results.
  const isCurrent = (captured: SessionFocusScope, requestGeneration: number): boolean => !destroyed
    && generation === requestGeneration
    && sameScope(scope, captured);

  // Read one exact session and revoke any previous focus before starting provider requests.
  const inspectSnapshot = async (sessions: GuestSessionsSnapshot, captured: SessionFocusScope, requestGeneration: number): Promise<void> => {
    if (!isCurrent(captured, requestGeneration)) return;

    // Require complete ready data and explicit ready coverage for the focused directory.
    if (sessions.kind !== 'sessions' || sessions.state !== 'ready' || sessions.projectId !== captured.localProjectId
      || !sessions.coverage.some((coverage) => coverage.directory === captured.directory && coverage.state === 'ready')) {
      publish({ kind: 'none' });
      return;
    }

    // Duplicate session records are not proof of one focused session.
    const matches = sessions.sessions.filter((session) => session.id === captured.sessionId);
    if (matches.length !== 1 || matches[0].projectId !== captured.localProjectId || matches[0].directory !== captured.directory) {
      publish({ kind: 'none' });
      return;
    }

    const session = matches[0];
    const expectation = { accountId: captured.accountId, variant: captured.variant, projectId: captured.projectId };
    const explicitItems = session.items.filter((item) => item.id.startsWith(`${GITLAB_VARIANT_ID}:merge_request`));
    let explicit: RelevantItemResult = { kind: 'absent' };

    // Any extension merge-request item blocks inferred discovery unless exactly one is valid.
    if (explicitItems.length > 0) {
      if (explicitItems.length !== 1) explicit = { kind: 'invalid' };
      else {
        const classification = classifySessionMergeRequestItem(explicitItems[0], expectation);
        explicit = classification.kind === 'valid' ? { kind: 'valid', identity: classification.identity } : { kind: 'invalid' };
      }
    }

    // Verify an independently attached issue even when an explicit MR item is malformed.
    const issuePrefix = `${GITLAB_VARIANT_ID}:issue:${captured.accountId}:`;
    const issueItems = session.items.filter((item) => item.id.startsWith(issuePrefix));
    let issueItem: IssueItemResult = null;
    if (issueItems.length === 1 && isIssueIdentity(issueItems[0].data)) {
      const identity = issueItems[0].data;
      const expectedId = `${issuePrefix}${identity.projectId}:${identity.iid}`;
      if (issueItems[0].id === expectedId && identity.accountId === captured.accountId
        && identity.variant === captured.variant && identity.projectId === captured.projectId) {
        issueItem = { identity, id: issueItems[0].id };
      }
    }

    // Fetch the independent issue and explicit MR together without allowing either to authorize the other.
    const issueRequest = issueItem
      ? options.getIssue(issueItem.identity.projectId, issueItem.identity.iid).then((issue) => ({ issue, error: null as unknown }))
        .catch((error: unknown) => ({ issue: null, error }))
      : Promise.resolve({ issue: null, error: null as unknown });
    const mrRequest = explicit.kind === 'valid'
      ? options.getMergeRequest(explicit.identity.projectId, explicit.identity.iid).then((mergeRequest) => ({ mergeRequest, error: null as unknown }))
        .catch((error: unknown) => ({ mergeRequest: null, error }))
      : Promise.resolve({ mergeRequest: null, error: null as unknown });
    const [issueResult, mrResult] = await Promise.all([issueRequest, mrRequest]);
    if (!isCurrent(captured, requestGeneration)) return;

    // Stop this verification after current-scope authentication loss, even if the callback leaves scope unchanged.
    if (isAuthenticationFailure(issueResult.error) || isAuthenticationFailure(mrResult.error)) {
      options.onAuthenticationFailure();
      return;
    }

    // Keep issue fallback only when the fresh provider identity still matches the durable item.
    const verifiedIssue = issueItem && issueResult.issue
      && issueResult.issue.id === issueItem.identity.issueId
      && issueResult.issue.iid === issueItem.identity.iid
      && issueResult.issue.projectId === issueItem.identity.projectId
      && issueResult.issue.webUrl === issueItem.identity.webUrl
      ? issueResult.issue
      : null;

    // A valid explicit item wins only after fresh stable identity checks; closed MRs remain valid.
    if (explicit.kind === 'valid' && mrResult.mergeRequest
      && mrResult.mergeRequest.id === explicit.identity.mergeRequestId
      && mrResult.mergeRequest.iid === explicit.identity.iid
      && mrResult.mergeRequest.projectId === explicit.identity.projectId
      && mrResult.mergeRequest.webUrl === explicit.identity.webUrl) {
      publish({ kind: 'verified-MR', scope: captured, mergeRequest: mrResult.mergeRequest, provenance: 'explicit-session', issue: verifiedIssue });
      return;
    }

    // Preserve why explicit-link verification failed, without exposing provider details or inferring another MR.
    if (explicit.kind !== 'absent') {
      const reason = explicit.kind === 'invalid' ? 'invalid' : 'unavailable';
      if (verifiedIssue) {
        publish({
          kind: 'verified-issue',
          scope: captured,
          issue: verifiedIssue,
          relatedCheck: reason === 'invalid' ? 'explicit-invalid' : 'explicit-unavailable',
        });
      } else publish({ kind: 'explicit-unavailable', scope: captured, reason });
      return;
    }

    // Related discovery can begin only after an independently attached issue is freshly verified.
    if (!verifiedIssue || !issueItem) {
      publish({ kind: 'none' });
      return;
    }

    try {
      const discovered = await discoverRelatedMergeRequest({
        issueProjectId: issueItem.identity.projectId,
        issueIid: issueItem.identity.iid,
        targetProjectId: captured.projectId,
        listPage: options.listRelatedPage,
        getDetail: options.getMergeRequest,
        isCurrent: () => isCurrent(captured, requestGeneration),
      });
      if (!isCurrent(captured, requestGeneration) || discovered.kind === 'cancelled') return;
      if (discovered.kind === 'related') {
        publish({ kind: 'verified-MR', scope: captured, mergeRequest: discovered.mergeRequest, provenance: 'related-issue', issue: verifiedIssue });
        return;
      }
      publish({ kind: 'verified-issue', scope: captured, issue: verifiedIssue, relatedCheck: relatedOutcome(discovered) });
    } catch (error) {
      if (!isCurrent(captured, requestGeneration)) return;
      if (isAuthenticationFailure(error)) {
        options.onAuthenticationFailure();
        return;
      }
      publish({ kind: 'verified-issue', scope: captured, issue: verifiedIssue, relatedCheck: 'unavailable' });
    }
  };

  // Start a snapshot lookup only once for unchanged ready coverage and item identities.
  const inspect = async (provided?: GuestSessionsSnapshot): Promise<void> => {
    const captured = scope;
    if (!captured || destroyed) return;
    let sessions = provided;

    // A delivered snapshot supersedes only the pending session read, not active provider verification.
    if (sessions && pendingSessionsRead) {
      pendingSessionsRead = null;
    }

    const requestGeneration = generation;
    try {
      if (!sessions) {
        let pending = pendingSessionsRead;
        if (!pending || pending.generation !== requestGeneration || !sameScope(pending.scope, captured)) {
          pending = {
            scope: captured,
            generation: requestGeneration,
            promise: Promise.resolve().then(() => options.listSessions(captured.localProjectId)),
          };
          pendingSessionsRead = pending;
        }
        try {
          sessions = await pending.promise;
        } catch (error) {
          if (!isCurrent(captured, requestGeneration) || pendingSessionsRead !== pending) return;
          pendingSessionsRead = null;
          // Let an identical later snapshot retry after this current read failed.
          lastSnapshotKey = null;
          generation += 1;
          if (isAuthenticationFailure(error)) {
            options.onAuthenticationFailure();
            return;
          }
          publish({ kind: 'none' });
          return;
        }
        if (pendingSessionsRead !== pending) return;
        pendingSessionsRead = null;
      }
    } catch (error) {
      if (!isCurrent(captured, requestGeneration)) return;
      if (isAuthenticationFailure(error)) {
        options.onAuthenticationFailure();
        return;
      }
      publish({ kind: 'none' });
      return;
    }
    if (!isCurrent(captured, requestGeneration) || sessions.projectId !== captured.localProjectId) return;

    const key = snapshotKey(sessions);
    if (key === lastSnapshotKey) return;
    lastSnapshotKey = key;
    const nextGeneration = ++generation;
    publish({ kind: 'checking', scope: captured });
    await inspectSnapshot(sessions, captured, nextGeneration);
  };

  // Replace the immutable identity boundary and invalidate every prior lookup immediately.
  const setScope = (next: SessionFocusScope | null): void => {
    if (destroyed || sameScope(scope, next)) return;
    generation += 1;
    lastSnapshotKey = null;
    pendingSessionsRead = null;
    scope = next ? Object.freeze({ ...next }) : null;
    if (!scope) publish({ kind: 'none' });
    else publish({ kind: 'checking', scope });
  };

  // Force a new provider read even when the session snapshot has not changed.
  const refresh = async (): Promise<void> => {
    if (!scope || destroyed) return;
    generation += 1;
    lastSnapshotKey = null;
    pendingSessionsRead = null;
    publish({ kind: 'checking', scope });
    await inspect();
  };

  // Stop future publications and clear the focused link when the owner is removed.
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    generation += 1;
    scope = null;
    current = { kind: 'none' };
    lastSnapshotKey = null;
    pendingSessionsRead = null;
  };

  return {
    setScope,
    inspect,
    refresh,
    snapshot: (): SessionFocusSnapshot => current,
    destroy,
  };
}
