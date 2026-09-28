import { describe, expect, it } from 'bun:test';
import type { GuestSessionsSnapshot, JsonValue } from '@openchamber/sdk';
import { GitLabApiError, GITLAB_VARIANT_ID, type GitLabIssue, type GitLabMergeRequest } from '../src/gitlab.js';
import { createSessionFocus, type CreateSessionFocusOptions, type SessionFocusScope } from '../src/session-focus.js';
import { formatSessionMergeRequestItem, type SessionMergeRequestIdentity } from '../src/session-mr-link.js';

const scope: SessionFocusScope = {
  revision: 1,
  sessionId: 'session-1',
  directory: '/workspace/project',
  localProjectId: 'local-project-1',
  accountId: 73,
  variant: GITLAB_VARIANT_ID,
  projectId: 812,
};

const issue: GitLabIssue = {
  id: 1801,
  iid: 31,
  projectId: 812,
  title: 'Repair deployment',
  description: '',
  state: 'closed',
  webUrl: 'https://gitlab.example.com/platform/infra/-/issues/31',
  updatedAt: '2026-09-01T00:00:00Z',
};

const mergeRequest: GitLabMergeRequest = {
  id: 1901,
  iid: 39,
  projectId: 812,
  targetProjectId: 812,
  sourceProjectId: 812,
  title: 'Repair deployment',
  description: '',
  state: 'closed',
  webUrl: 'https://gitlab.example.com/platform/infra/-/merge_requests/39',
  updatedAt: '2026-09-02T00:00:00Z',
  sourceBranch: 'fix/deploy',
  targetBranch: 'main',
};

const mrIdentity: SessionMergeRequestIdentity = {
  v: 1,
  variant: GITLAB_VARIANT_ID,
  accountId: scope.accountId,
  projectId: scope.projectId,
  iid: mergeRequest.iid,
  mergeRequestId: mergeRequest.id,
  webUrl: mergeRequest.webUrl,
};

// Keep provider links in the same versioned shape as the durable session convention.
function issueItem(projectId = issue.projectId, iid = issue.iid, dataOverrides: Record<string, unknown> = {}) {
  return {
    id: `${GITLAB_VARIANT_ID}:issue:${scope.accountId}:${projectId}:${iid}`,
    data: {
      v: 1,
      variant: GITLAB_VARIANT_ID,
      accountId: scope.accountId,
      projectId,
      iid,
      issueId: issue.id,
      webUrl: issue.webUrl,
      ...dataOverrides,
    } as JsonValue,
  };
}

// Build complete workspace evidence and allow individual coverage or item changes.
function sessionsSnapshot(overrides: Partial<GuestSessionsSnapshot> = {}): GuestSessionsSnapshot {
  return {
    kind: 'sessions',
    projectId: scope.localProjectId,
    state: 'ready',
    coverage: [{ directory: scope.directory, state: 'ready' }],
    sessions: [{
      id: scope.sessionId,
      title: 'Session title',
      projectId: scope.localProjectId,
      directory: scope.directory,
      parentId: null,
      createdAt: 1,
      updatedAt: 2,
      archivedAt: null,
      worktree: null,
      activity: 'idle',
      outcome: null,
      items: [],
    }],
    ...overrides,
  };
}

// Supply deterministic host callbacks and expose their call counts to each behavior test.
function harness(overrides: Partial<CreateSessionFocusOptions> = {}) {
  const calls = { sessions: 0, issue: 0, mergeRequest: 0, related: 0, authentication: 0 };
  const options: CreateSessionFocusOptions = {
    listSessions: async () => { calls.sessions += 1; return sessionsSnapshot(); },
    getIssue: async () => { calls.issue += 1; return issue; },
    getMergeRequest: async () => { calls.mergeRequest += 1; return mergeRequest; },
    listRelatedPage: async () => { calls.related += 1; return []; },
    onChange: () => {},
    onAuthenticationFailure: () => { calls.authentication += 1; },
    ...overrides,
  };
  const focus = createSessionFocus(options);
  focus.setScope(scope);
  return { focus, calls };
}

// Build one deferred request so tests can complete old work after its scope is invalidated.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('focused session links', () => {
  // Explicit session attachment is authoritative after fresh identity validation, including closed MRs.
  it('shows an explicitly attached closed merge request', async () => {
    const { focus, calls } = harness();
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...sessionsSnapshot().sessions[0], items: [formatSessionMergeRequestItem(mrIdentity)] }] }));

    expect(focus.snapshot()).toMatchObject({ kind: 'verified-MR', provenance: 'explicit-session', mergeRequest: { state: 'closed' } });
    expect(calls.mergeRequest).toBe(1);
    expect(calls.related).toBe(0);
  });

  // Invalid or duplicated explicit items block inference while a separate valid issue can remain visible.
  it('does not infer related MRs from malformed or duplicate explicit items', async () => {
    const { focus, calls } = harness({
      listRelatedPage: async () => { calls.related += 1; return []; },
    });
    const linked = sessionsSnapshot().sessions[0];
    const badItem = { id: `${GITLAB_VARIANT_ID}:merge_request:bad`, data: {} as JsonValue };
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem(), badItem] }] }));
    expect(focus.snapshot()).toMatchObject({ kind: 'verified-issue', issue: { iid: issue.iid }, relatedCheck: 'explicit-invalid' });

    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem(), formatSessionMergeRequestItem(mrIdentity), formatSessionMergeRequestItem(mrIdentity)] }] }));

    expect(focus.snapshot()).toMatchObject({ kind: 'verified-issue', issue: { iid: issue.iid }, relatedCheck: 'explicit-invalid' });
    expect(calls.mergeRequest).toBe(0);
    expect(calls.related).toBe(0);
  });

  // Require the metadata account to match the account encoded in the current session item ID.
  it('rejects current-account issue IDs with metadata for another account before provider reads', async () => {
    const { focus, calls } = harness();
    const linked = sessionsSnapshot().sessions[0];
    const mismatched = issueItem(issue.projectId, issue.iid, { accountId: scope.accountId + 1 });
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [mismatched] }] }));

    expect(focus.snapshot()).toEqual({ kind: 'none' });
    expect(calls.issue).toBe(0);
    expect(calls.mergeRequest).toBe(0);
    expect(calls.related).toBe(0);
  });

  // Keep an unchanged provider verification alive when a duplicate session read is superseded.
  it('does not cancel provider verification when an identical snapshot arrives during a session read', async () => {
    const pendingIssue = deferred<GitLabIssue>();
    const pendingSessions = deferred<GuestSessionsSnapshot>();
    const calls = { sessions: 0, issue: 0, related: 0 };
    const focus = createSessionFocus({
      listSessions: async () => { calls.sessions += 1; return pendingSessions.promise; },
      getIssue: async () => { calls.issue += 1; return pendingIssue.promise; },
      getMergeRequest: async () => mergeRequest,
      listRelatedPage: async () => { calls.related += 1; return []; },
      onChange: () => {},
      onAuthenticationFailure: () => {},
    });
    focus.setScope(scope);
    const linked = sessionsSnapshot().sessions[0];
    const snapshot = sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] });

    const first = focus.inspect(snapshot);
    const second = focus.inspect();
    const third = focus.inspect(snapshot);
    pendingIssue.resolve(issue);
    await first;
    pendingSessions.resolve(snapshot);
    await Promise.all([second, third]);

    expect(focus.snapshot()).toMatchObject({ kind: 'verified-issue', issue: { iid: issue.iid } });
    expect(calls).toEqual({ sessions: 1, issue: 1, related: 1 });
  });

  // Clear failed snapshot evidence so a later identical delivered snapshot can recover focus.
  it('recovers from a failed current session read when the identical ready snapshot is delivered', async () => {
    const linked = sessionsSnapshot().sessions[0];
    let failRead = false;
    const { focus, calls } = harness({
      listSessions: async () => {
        calls.sessions += 1;
        if (failRead) throw new Error('temporary session read failure');
        return sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] });
      },
    });
    const snapshot = sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] });
    await focus.inspect(snapshot);
    failRead = true;
    await focus.inspect();
    expect(focus.snapshot()).toEqual({ kind: 'none' });

    failRead = false;
    await focus.inspect(snapshot);

    expect(focus.snapshot()).toMatchObject({ kind: 'verified-issue', issue: { iid: issue.iid } });
    expect(calls.issue).toBe(2);
  });

  // Keep an inaccessible explicit link visible as a safe neutral state until the user refreshes.
  it('reports explicit MR access denial and focuses after an explicit refresh succeeds', async () => {
    const linked = sessionsSnapshot().sessions[0];
    let denied = true;
    const { focus, calls } = harness({
      listSessions: async () => {
        calls.sessions += 1;
        return sessionsSnapshot({ sessions: [{ ...linked, items: [formatSessionMergeRequestItem(mrIdentity)] }] });
      },
      getMergeRequest: async () => {
        calls.mergeRequest += 1;
        if (denied) throw new GitLabApiError('forbidden', 'merge-requests');
        return mergeRequest;
      },
    });
    const snapshot = sessionsSnapshot({ sessions: [{ ...linked, items: [formatSessionMergeRequestItem(mrIdentity)] }] });
    await focus.inspect(snapshot);

    expect(focus.snapshot()).toMatchObject({ kind: 'explicit-unavailable', reason: 'unavailable' });
    expect(calls.mergeRequest).toBe(1);
    expect(calls.related).toBe(0);

    denied = false;
    await focus.refresh();

    expect(focus.snapshot()).toMatchObject({ kind: 'verified-MR', provenance: 'explicit-session' });
    expect(calls.mergeRequest).toBe(2);
    expect(calls.related).toBe(0);
  });

  // Do not expose an explicit link that GitLab reports as missing.
  it('keeps an explicit MR 404 in a neutral unavailable state without discovery', async () => {
    const linked = sessionsSnapshot().sessions[0];
    const { focus, calls } = harness({
      getMergeRequest: async () => {
        calls.mergeRequest += 1;
        throw new GitLabApiError('not-found', 'merge-requests');
      },
    });
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [formatSessionMergeRequestItem(mrIdentity)] }] }));

    expect(focus.snapshot()).toMatchObject({ kind: 'explicit-unavailable', scope, reason: 'unavailable' });
    expect(calls.mergeRequest).toBe(1);
    expect(calls.related).toBe(0);
    expect(calls.authentication).toBe(0);
  });

  // Keep the independent issue visible with an explicit-link warning after an access denial.
  it('preserves explicit unavailability when a separate issue is verified', async () => {
    const linked = sessionsSnapshot().sessions[0];
    const { focus, calls } = harness({
      getMergeRequest: async () => {
        calls.mergeRequest += 1;
        throw new GitLabApiError('forbidden', 'merge-requests');
      },
    });
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem(), formatSessionMergeRequestItem(mrIdentity)] }] }));

    expect(focus.snapshot()).toMatchObject({ kind: 'verified-issue', issue: { iid: issue.iid }, relatedCheck: 'explicit-unavailable' });
    expect(calls.issue).toBe(1);
    expect(calls.related).toBe(0);
  });

  // Related discovery starts only after the attached issue has passed a fresh identity check.
  it('shows a related MR only after verifying its attached issue', async () => {
    const { focus, calls } = harness({
      listRelatedPage: async (_projectId, _iid, page) => {
        calls.related += 1;
        return page === 1 ? [{ ...mergeRequest, state: 'opened' }] : [];
      },
      getMergeRequest: async () => ({ ...mergeRequest, state: 'opened' }),
    });
    const linked = sessionsSnapshot().sessions[0];
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] }));

    expect(focus.snapshot()).toMatchObject({ kind: 'verified-MR', provenance: 'related-issue', issue: { iid: issue.iid } });
    expect(calls.issue).toBe(1);
    expect(calls.related).toBe(2);
  });

  // Losing ready directory coverage immediately removes the previous verified focus.
  it('revokes focus when ready directory coverage is lost', async () => {
    const { focus } = harness();
    const linked = sessionsSnapshot().sessions[0];
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] }));
    expect(focus.snapshot().kind).toBe('verified-issue');

    await focus.inspect(sessionsSnapshot({ coverage: [{ directory: scope.directory, state: 'loading' }] }));
    expect(focus.snapshot()).toEqual({ kind: 'none' });
  });

  // More than one record with the focused ID cannot establish a unique session.
  it('rejects duplicate session records', async () => {
    const { focus } = harness();
    const linked = sessionsSnapshot().sessions[0];
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }, linked] }));

    expect(focus.snapshot()).toEqual({ kind: 'none' });
  });

  // Title and activity updates for the same ready evidence do not restart provider verification.
  it('coalesces same-ID updates that do not change coverage or items', async () => {
    const linked = sessionsSnapshot().sessions[0];
    const { focus, calls } = harness();
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] }));
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, title: 'New title', activity: 'running', items: [issueItem()] }] }));

    expect(calls.issue).toBe(1);
    expect(calls.related).toBe(1);
  });

  // Explicit refresh bypasses snapshot coalescing and revalidates provider state.
  it('re-fetches the focused issue on explicit refresh', async () => {
    const linked = sessionsSnapshot().sessions[0];
    const { focus, calls } = harness({
      listSessions: async () => {
        calls.sessions += 1;
        return sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] });
      },
    });
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] }));
    await focus.refresh();

    expect(calls.sessions).toBe(1);
    expect(calls.issue).toBe(2);
  });

  // A response from the first A scope cannot publish after the focus changes A -> B -> A.
  it('rejects stale success across A to B to A scope changes', async () => {
    const pending = deferred<GitLabMergeRequest>();
    const { focus } = harness({ getMergeRequest: async () => pending.promise });
    const linked = sessionsSnapshot().sessions[0];
    const inspect = focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [formatSessionMergeRequestItem(mrIdentity)] }] }));
    focus.setScope({ ...scope, revision: 2, sessionId: 'session-B' });
    focus.setScope({ ...scope, revision: 3 });
    pending.resolve(mergeRequest);
    await inspect;

    expect(focus.snapshot()).toMatchObject({ kind: 'checking', scope: { revision: 3 } });
  });

  // A stale authentication failure must not disconnect the current account or notify its owner.
  it('ignores an old-scope 401 and does not notify authentication failure', async () => {
    const pending = deferred<GitLabMergeRequest>();
    const { focus, calls } = harness({ getMergeRequest: async () => pending.promise });
    const linked = sessionsSnapshot().sessions[0];
    const inspect = focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [formatSessionMergeRequestItem(mrIdentity)] }] }));
    focus.setScope({ ...scope, revision: 2, sessionId: 'session-B' });
    pending.reject(new GitLabApiError('disconnected', 'merge-requests'));
    await inspect;

    expect(calls.authentication).toBe(0);
    expect(focus.snapshot()).toMatchObject({ kind: 'checking', scope: { revision: 2 } });
  });

  // Destroy prevents pending work from publishing or calling authentication handlers.
  it('does not publish or report authentication failures after destroy', async () => {
    const pending = deferred<GitLabMergeRequest>();
    let changes = 0;
    const { focus, calls } = harness({ getMergeRequest: async () => pending.promise, onChange: () => { changes += 1; } });
    const linked = sessionsSnapshot().sessions[0];
    const inspect = focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [formatSessionMergeRequestItem(mrIdentity)] }] }));
    focus.destroy();
    pending.reject(new GitLabApiError('disconnected', 'merge-requests'));
    await inspect;

    expect(calls.authentication).toBe(0);
    expect(changes).toBe(2);
    expect(focus.snapshot()).toEqual({ kind: 'none' });
  });

  // Authentication handling may synchronously revoke the scope, so no sibling success may publish afterward.
  it('does not publish a successful explicit MR when the issue request reports authentication loss', async () => {
    let focus: ReturnType<typeof createSessionFocus>;
    let authenticationNotified = false;
    const changes: string[] = [];
    focus = createSessionFocus({
      listSessions: async () => sessionsSnapshot(),
      getIssue: async () => { throw new GitLabApiError('disconnected', 'issues'); },
      getMergeRequest: async () => mergeRequest,
      listRelatedPage: async () => [],
      onChange: (snapshot) => changes.push(`${authenticationNotified ? 'after-auth:' : ''}${snapshot.kind}`),
      onAuthenticationFailure: () => {
        authenticationNotified = true;
        focus.setScope(null);
      },
    });
    focus.setScope(scope);
    const linked = sessionsSnapshot().sessions[0];
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem(), formatSessionMergeRequestItem(mrIdentity)] }] }));

    expect(focus.snapshot()).toEqual({ kind: 'none' });
    expect(changes.filter((change) => change.startsWith('after-auth:'))).toEqual(['after-auth:none']);
  });

  // Related discovery authentication loss must stop the scan and must not republish the verified issue.
  it('does not publish the issue after a related-page authentication failure', async () => {
    let focus: ReturnType<typeof createSessionFocus>;
    let authenticationNotified = false;
    let pageCalls = 0;
    const changes: string[] = [];
    focus = createSessionFocus({
      listSessions: async () => sessionsSnapshot(),
      getIssue: async () => issue,
      getMergeRequest: async () => mergeRequest,
      listRelatedPage: async () => {
        pageCalls += 1;
        throw new GitLabApiError('disconnected', 'merge-requests');
      },
      onChange: (snapshot) => changes.push(`${authenticationNotified ? 'after-auth:' : ''}${snapshot.kind}`),
      onAuthenticationFailure: () => {
        authenticationNotified = true;
        focus.setScope(null);
      },
    });
    focus.setScope(scope);
    const linked = sessionsSnapshot().sessions[0];
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] }));

    expect(focus.snapshot()).toEqual({ kind: 'none' });
    expect(pageCalls).toBe(1);
    expect(changes.filter((change) => change.startsWith('after-auth:'))).toEqual(['after-auth:none']);
  });

  // Duplicate startup and subscription inspections share one session snapshot request and one verification.
  it('coalesces concurrent session snapshot reads for the same scope', async () => {
    const pending = deferred<GuestSessionsSnapshot>();
    const calls = { sessions: 0, issues: 0 };
    const focus = createSessionFocus({
      listSessions: async () => { calls.sessions += 1; return pending.promise; },
      getIssue: async () => { calls.issues += 1; return issue; },
      getMergeRequest: async () => mergeRequest,
      listRelatedPage: async () => [],
      onChange: () => {},
      onAuthenticationFailure: () => {},
    });
    focus.setScope(scope);
    const linked = sessionsSnapshot().sessions[0];
    const snapshot = sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] });
    const first = focus.inspect();
    const second = focus.inspect();
    pending.resolve(snapshot);
    await Promise.all([first, second]);

    expect(calls.sessions).toBe(1);
    expect(calls.issues).toBe(1);
  });

  // A stale snapshot failure cannot notify authentication loss or clear the new scope.
  it('ignores a stale session-read failure after a scope change', async () => {
    const pending = deferred<GuestSessionsSnapshot>();
    let authenticationFailures = 0;
    const focus = createSessionFocus({
      listSessions: async () => pending.promise,
      getIssue: async () => issue,
      getMergeRequest: async () => mergeRequest,
      listRelatedPage: async () => [],
      onChange: () => {},
      onAuthenticationFailure: () => { authenticationFailures += 1; },
    });
    focus.setScope(scope);
    const inspect = focus.inspect();
    focus.setScope({ ...scope, revision: 2, sessionId: 'session-B' });
    pending.reject(new GitLabApiError('disconnected', 'account'));
    await inspect;

    expect(authenticationFailures).toBe(0);
    expect(focus.snapshot()).toMatchObject({ kind: 'checking', scope: { revision: 2 } });
  });

  // A newer delivered snapshot supersedes an unresolved startup read before its result can publish.
  it('ignores an older session-read result after a provided snapshot', async () => {
    const pending = deferred<GuestSessionsSnapshot>();
    let issueCalls = 0;
    const focus = createSessionFocus({
      listSessions: async () => pending.promise,
      getIssue: async () => { issueCalls += 1; return issue; },
      getMergeRequest: async () => mergeRequest,
      listRelatedPage: async () => [],
      onChange: () => {},
      onAuthenticationFailure: () => {},
    });
    focus.setScope(scope);
    const oldRead = focus.inspect();
    const linked = sessionsSnapshot().sessions[0];
    await focus.inspect(sessionsSnapshot({ sessions: [{ ...linked, items: [issueItem()] }] }));
    pending.resolve(sessionsSnapshot());
    await oldRead;

    expect(focus.snapshot()).toMatchObject({ kind: 'verified-issue', issue: { iid: issue.iid } });
    expect(issueCalls).toBe(1);
  });
});
