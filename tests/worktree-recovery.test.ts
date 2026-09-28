import { describe, expect, it } from 'bun:test';
import type { GuestProjectsSnapshot, GuestSessionsSnapshot, GuestWorktreesSnapshot, HostClient, JsonValue } from '@openchamber/sdk';
import {
  RECOVERY_KEY,
  armRecovery,
  checkRecovery,
  readRecovery,
  releaseRecovery,
  writeRecoveryOutcome,
  type RecoveryRecord,
  type RecoveryStorage,
} from '../src/worktree-recovery.js';

const record: RecoveryRecord = {
  version: 1,
  attemptId: '123e4567-e89b-42d3-a456-426614174000',
  startedAt: '2026-09-27T12:00:00.000Z',
  origin: {
    localProjectId: 'workspace-1',
    directory: '/repos/openchamber',
    accountId: 73,
    variant: 'gitlab-self-managed',
    gitlabProjectId: 812,
    iid: 19,
    issueId: 991,
    webUrl: 'https://gitlab.example/group/project/-/issues/19',
  },
  outcome: { kind: 'unresolved' },
};

const projects: GuestProjectsSnapshot = {
  kind: 'projects',
  state: 'ready',
  projects: [{ id: 'workspace-1', name: 'OpenChamber', directory: '/repos/openchamber' }],
};

const worktrees: GuestWorktreesSnapshot = {
  kind: 'worktrees',
  projectId: 'workspace-1',
  state: 'ready',
  worktrees: [{ directory: '/repos/openchamber/.worktrees/issue-19', name: 'issue-19', branch: 'issue-19', status: 'ready' }],
};

function matchingSessions(): GuestSessionsSnapshot {
  return {
    kind: 'sessions',
    projectId: 'workspace-1',
    state: 'ready',
    coverage: [{ directory: '/repos/openchamber/.worktrees/issue-19', state: 'ready' }],
    sessions: [{
      id: 'session-1',
      title: 'Issue 19',
      projectId: 'workspace-1',
      directory: '/repos/openchamber/.worktrees/issue-19',
      parentId: null,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      worktree: null,
      activity: 'idle',
      outcome: null,
      items: [{
        id: 'gitlab-self-managed:issue:73:812:19',
        data: {
          v: 1,
          variant: 'gitlab-self-managed',
          accountId: 73,
          projectId: 812,
          iid: 19,
          issueId: 991,
          webUrl: 'https://gitlab.example/group/project/-/issues/19',
          recoveryAttemptId: record.attemptId,
        },
      }],
    }],
  };
}

// Isolate each test in a simple storage namespace that records touched keys.
function memoryStorage(): { storage: RecoveryStorage; values: Map<string, JsonValue>; deleted: string[] } {
  const values = new Map<string, JsonValue>();
  const deleted: string[] = [];
  const storage: HostClient['storage'] = {
    async get(key) { return values.get(key); },
    async set(key, value) { values.set(key, value); },
    async delete(key) { deleted.push(key); values.delete(key); },
    async keys() { return [...values.keys()]; },
  };
  return { storage, values, deleted };
}

// Keep the host fixture limited to authoritative list snapshots used by recovery checks.
function host(sessions = matchingSessions(), projectSnapshot = projects, worktreeSnapshot = worktrees) {
  return {
    async listProjects() { return projectSnapshot; },
    async listWorktrees() { return worktreeSnapshot; },
    async listSessions() { return sessions; },
  };
}

// Exercise the fail-closed one-record persistence and snapshot-reconciliation contract.
describe('worktree recovery', () => {
  // Treat only a missing key as empty and refuse malformed, null, or unsupported records.
  it('distinguishes absent and invalid stored records', async () => {
    const { storage, values } = memoryStorage();
    await expect(readRecovery(storage)).resolves.toEqual({ kind: 'empty' });
    values.set(RECOVERY_KEY, null);
    await expect(readRecovery(storage)).resolves.toEqual({ kind: 'invalid' });
    values.set(RECOVERY_KEY, { ...record, version: 2 } as unknown as JsonValue);
    await expect(readRecovery(storage)).resolves.toEqual({ kind: 'invalid' });
    const unsupported = values.get(RECOVERY_KEY);
    await expect(armRecovery(storage, record)).rejects.toThrow('existing recovery record');
    expect(values.get(RECOVERY_KEY)).toBe(unsupported);
    values.set(RECOVERY_KEY, { ...record, unexpected: true } as unknown as JsonValue);
    await expect(readRecovery(storage)).resolves.toEqual({ kind: 'invalid' });
  });

  // Require a storage acknowledgement before reporting that an attempt is armed.
  it('writes unresolved intent and propagates failed writes', async () => {
    const { storage } = memoryStorage();
    await expect(armRecovery(storage, record)).resolves.toEqual(record);
    await expect(armRecovery(storage, record)).rejects.toThrow('existing recovery record');
    const { storage: emptyStorage } = memoryStorage();
    const failedStorage: RecoveryStorage = {
      ...emptyStorage,
      async set() { throw new Error('storage unavailable'); },
    };
    await expect(armRecovery(failedStorage, record)).rejects.toThrow('storage unavailable');
  });

  // Persist each authoritative result against the same attempt and preserve its original context.
  it('writes created and retained outcomes only to the matching record', async () => {
    const { storage: createdStorage } = memoryStorage();
    await armRecovery(createdStorage, record);
    const created = await writeRecoveryOutcome(createdStorage, record.attemptId, {
      kind: 'created', sessionId: 'session-1', directory: '/repos/openchamber/.worktrees/issue-19', linked: true, sent: 'sent',
    });
    expect(created).toEqual({ ...record, outcome: { kind: 'created', sessionId: 'session-1', directory: '/repos/openchamber/.worktrees/issue-19', linked: true, sent: 'sent' } });
    const { storage: retainedStorage } = memoryStorage();
    await armRecovery(retainedStorage, record);
    const retained = await writeRecoveryOutcome(retainedStorage, record.attemptId, {
      kind: 'retained', directory: '/repos/openchamber/.worktrees/issue-19', failure: 'bootstrap-failed',
    });
    expect(retained.outcome).toEqual({ kind: 'retained', directory: '/repos/openchamber/.worktrees/issue-19', failure: 'bootstrap-failed' });
  });

  // Accept a repeated exact write after storage committed but its acknowledgement was lost.
  it('acknowledges an exact persisted outcome and refuses a conflicting one', async () => {
    const { storage, values } = memoryStorage();
    await armRecovery(storage, record);
    const outcome = { kind: 'created' as const, sessionId: 'session-1', directory: '/repos/openchamber/.worktrees/issue-19', linked: true, sent: 'sent' as const };
    const committingStorage: RecoveryStorage = {
      ...storage,
      async set(key, value) {
        values.set(key, value);
        throw new Error('acknowledgement lost');
      },
    };

    await expect(writeRecoveryOutcome(committingStorage, record.attemptId, outcome)).rejects.toThrow('acknowledgement lost');
    await expect(writeRecoveryOutcome(storage, record.attemptId, outcome)).resolves.toEqual({ ...record, outcome });
    await expect(writeRecoveryOutcome(storage, record.attemptId, { ...outcome, sent: 'failed' })).rejects.toThrow('changed');
    expect(values.get(RECOVERY_KEY)).toEqual({ ...record, outcome });
  });

  // Promote only one exact session match whose issue marker and workspace coverage are ready.
  it('reconciles one exact tagged session without guessing result details', async () => {
    await expect(checkRecovery(host(), record)).resolves.toEqual({
      ...record,
      outcome: { kind: 'created', sessionId: 'session-1', directory: '/repos/openchamber/.worktrees/issue-19', linked: true, sent: 'unknown' },
    });
  });

  // Keep unresolved state when any identity differs or the snapshots cannot prove uniqueness.
  it('leaves mismatched, ambiguous, and incomplete snapshots unresolved', async () => {
    const changedData = matchingSessions();
    changedData.sessions[0]!.items[0]!.data = { ...(changedData.sessions[0]!.items[0]!.data as Record<string, JsonValue>), issueId: 992 };
    const duplicate = matchingSessions();
    duplicate.sessions.push({ ...duplicate.sessions[0]!, id: 'session-2' });
    const incomplete = matchingSessions();
    incomplete.coverage[0]!.state = 'loading';

    await expect(checkRecovery(host(changedData), record)).resolves.toBe(record);
    await expect(checkRecovery(host(duplicate), record)).resolves.toBe(record);
    await expect(checkRecovery(host(incomplete), record)).resolves.toBe(record);
    await expect(checkRecovery(host(matchingSessions(), { ...projects, state: 'loading' }), record)).resolves.toBe(record);
    await expect(checkRecovery(host(matchingSessions(), projects, { ...worktrees, state: 'error' }), record)).resolves.toBe(record);
  });

  // Delete only the fixed recovery key and wait for the storage acknowledgement.
  it('releases only the recovery key after deletion succeeds', async () => {
    const { storage, values, deleted } = memoryStorage();
    values.set(RECOVERY_KEY, record as unknown as JsonValue);
    values.set('other-key', 'preserved');
    await releaseRecovery(storage, { kind: 'record', attemptId: record.attemptId });
    expect(deleted).toEqual([RECOVERY_KEY]);
    expect(values.get('other-key')).toBe('preserved');
    await expect(releaseRecovery(storage, { kind: 'record', attemptId: record.attemptId })).rejects.toThrow('changed');

    const changed = { ...record, attemptId: '223e4567-e89b-42d3-a456-426614174000' };
    values.set(RECOVERY_KEY, changed as unknown as JsonValue);
    await expect(releaseRecovery(storage, { kind: 'record', attemptId: record.attemptId })).rejects.toThrow('changed');
    expect(values.get(RECOVERY_KEY)).toEqual(changed);

    values.set(RECOVERY_KEY, null);
    await releaseRecovery(storage, { kind: 'invalid' });
    expect(deleted).toEqual([RECOVERY_KEY, RECOVERY_KEY]);

    values.set(RECOVERY_KEY, record as unknown as JsonValue);
    let finishRead!: () => void;
    let active = true;
    const delayedStorage: RecoveryStorage = {
      ...storage,
      async get(key) {
        await new Promise<void>((resolve) => { finishRead = resolve; });
        return values.get(key);
      },
    };
    const pendingRelease = releaseRecovery(delayedStorage, { kind: 'record', attemptId: record.attemptId }, () => active);
    active = false;
    finishRead();
    await pendingRelease;
    expect(values.get(RECOVERY_KEY)).toEqual(record);
    expect(deleted).toEqual([RECOVERY_KEY, RECOVERY_KEY]);
  });
});
