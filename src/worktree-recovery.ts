import type {
  GuestProjectsSnapshot,
  GuestSessionsSnapshot,
  GuestWorktreesSnapshot,
  HostClient,
  JsonValue,
  StartSessionSent,
} from '@openchamber/sdk';

export const RECOVERY_KEY = 'gitlab-worktree-recovery:v1';

export type RecoveryOrigin = {
  readonly localProjectId: string;
  readonly directory: string;
  readonly accountId: number;
  readonly variant: string;
  readonly gitlabProjectId: number;
  readonly iid: number;
  readonly issueId: number;
  readonly webUrl: string;
};

export type RecoveryOutcome =
  | { kind: 'unresolved' }
  | { kind: 'created'; sessionId: string; directory: string; linked: boolean; sent: StartSessionSent | 'unknown' }
  | { kind: 'retained'; directory: string; failure: 'bootstrap-failed' | 'session-create-failed' };

export type RecoveryRecord = {
  version: 1;
  attemptId: string;
  startedAt: string;
  readonly origin: RecoveryOrigin;
  outcome: RecoveryOutcome;
};

export type RecoveryReadResult =
  | { kind: 'empty' }
  | { kind: 'valid'; record: RecoveryRecord }
  | { kind: 'invalid' };

export type RecoveryStorage = Pick<HostClient['storage'], 'get' | 'set' | 'delete'>;

export type RecoveryReleaseTarget = { kind: 'record'; attemptId: string } | { kind: 'invalid' };

export type RecoveryHost = Pick<HostClient, 'listProjects' | 'listWorktrees' | 'listSessions'>;

type JsonRecord = Record<string, JsonValue>;

// Read the one recovery slot without treating malformed data as permission to overwrite it.
export async function readRecovery(storage: RecoveryStorage): Promise<RecoveryReadResult> {
  const value = await storage.get(RECOVERY_KEY);
  if (value === undefined) return { kind: 'empty' };
  if (!isRecoveryRecord(value)) return { kind: 'invalid' };

  return { kind: 'valid', record: value };
}

// Persist the unresolved intent before dispatch so a restart cannot hide an uncertain request.
export async function armRecovery(storage: RecoveryStorage, record: RecoveryRecord): Promise<RecoveryRecord> {
  if (!isRecoveryRecord(record) || record.outcome.kind !== 'unresolved') {
    throw new Error('Only a valid unresolved recovery record can be armed.');
  }

  const current = await readRecovery(storage);
  if (current.kind !== 'empty') throw new Error('An existing recovery record must be reviewed before another attempt is armed.');

  await storage.set(RECOVERY_KEY, record as unknown as JsonValue);
  return record;
}

// Update the existing attempt only after confirming its identity and preserve its original context.
export async function writeRecoveryOutcome(storage: RecoveryStorage, attemptId: string, outcome: Exclude<RecoveryOutcome, { kind: 'unresolved' }>): Promise<RecoveryRecord> {
  const current = await readRecovery(storage);
  if (current.kind !== 'valid' || current.record.attemptId !== attemptId) {
    throw new Error('The recovery attempt is missing, invalid, or has changed.');
  }

  // Treat an exact prior write as acknowledged without replacing a conflicting result.
  if (current.record.outcome.kind !== 'unresolved') {
    if (JSON.stringify(current.record.outcome) === JSON.stringify(outcome)) return current.record;
    throw new Error('The recovery attempt is missing, invalid, or has changed.');
  }

  const record: RecoveryRecord = { ...current.record, outcome };
  await storage.set(RECOVERY_KEY, record as unknown as JsonValue);
  return record;
}

// Recheck the user's current record identity before deleting only the recovery key.
export async function releaseRecovery(
  storage: RecoveryStorage,
  target: RecoveryReleaseTarget,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const current = await readRecovery(storage);
  if (!isCurrent()) return;
  const matches = target.kind === 'invalid'
    ? current.kind === 'invalid'
    : current.kind === 'valid' && current.record.attemptId === target.attemptId;
  if (!matches) throw new Error('The recovery record changed before it could be released.');

  await storage.delete(RECOVERY_KEY);
}

// Promote an unresolved attempt only when complete host snapshots prove one exact tagged session.
export async function checkRecovery(host: RecoveryHost, record: RecoveryRecord): Promise<RecoveryRecord> {
  if (record.outcome.kind !== 'unresolved' || !isRecoveryRecord(record)) return record;

  try {
    const projects = await host.listProjects();
    if (!hasRegisteredOrigin(projects, record.origin)) return record;

    const [worktrees, sessions] = await Promise.all([
      host.listWorktrees(record.origin.localProjectId),
      host.listSessions(record.origin.localProjectId),
    ]);
    if (!isReadyWorktreeSnapshot(worktrees, record.origin.localProjectId)
      || !isReadySessionSnapshot(sessions, record.origin.localProjectId)) return record;

    const matches = findExactSessionMatches(sessions, worktrees, record);
    if (matches.length !== 1) return record;

    const session = matches[0]!;
    const item = session.items.find((candidate) => candidate.id === recoveryIssueId(record) && isRecoveryIssueData(candidate.data, record));
    if (!item || !item.data || !isRecoveryIssueData(item.data, record)) return record;

    return {
      ...record,
      outcome: {
        kind: 'created',
        sessionId: session.id,
        directory: session.directory,
        linked: true,
        sent: 'unknown',
      },
    };
  } catch {
    // Host read failures leave the durable attempt unresolved for explicit user review.
    return record;
  }
}

// Require a complete project list and one exact registered repository identity.
function hasRegisteredOrigin(snapshot: GuestProjectsSnapshot, origin: RecoveryOrigin): boolean {
  if (snapshot.kind !== 'projects' || snapshot.state !== 'ready' || !Array.isArray(snapshot.projects)) return false;

  const ids = new Set<string>();
  for (const project of snapshot.projects) {
    if (!project || typeof project.id !== 'string' || !project.id || ids.has(project.id)
      || typeof project.name !== 'string' || !project.name || typeof project.directory !== 'string' || !project.directory) return false;
    ids.add(project.id);
  }

  const matches = snapshot.projects.filter((project) => project.id === origin.localProjectId && project.directory === origin.directory);
  return matches.length === 1;
}

// Accept only a ready worktree snapshot whose directory records are well-formed and unique.
function isReadyWorktreeSnapshot(snapshot: GuestWorktreesSnapshot, projectId: string): boolean {
  if (snapshot.kind !== 'worktrees' || snapshot.projectId !== projectId || snapshot.state !== 'ready' || !Array.isArray(snapshot.worktrees)) return false;

  const directories = new Set<string>();
  for (const worktree of snapshot.worktrees) {
    if (!worktree || typeof worktree.directory !== 'string' || !worktree.directory || directories.has(worktree.directory)
      || typeof worktree.name !== 'string' || typeof worktree.branch !== 'string'
      || !['ready', 'pending', 'invalid', 'missing'].includes(worktree.status)) return false;
    directories.add(worktree.directory);
  }

  return true;
}

// Require a complete session snapshot with valid unique coverage before examining session records.
function isReadySessionSnapshot(snapshot: GuestSessionsSnapshot, projectId: string): boolean {
  if (snapshot.kind !== 'sessions' || snapshot.projectId !== projectId || snapshot.state !== 'ready'
    || !Array.isArray(snapshot.coverage) || !Array.isArray(snapshot.sessions)) return false;

  const directories = new Set<string>();
  for (const coverage of snapshot.coverage) {
    if (!coverage || typeof coverage.directory !== 'string' || !coverage.directory || directories.has(coverage.directory)
      || !['ready', 'loading', 'error'].includes(coverage.state)) return false;
    directories.add(coverage.directory);
  }

  const sessionIds = new Set<string>();
  for (const session of snapshot.sessions) {
    if (!session || typeof session.id !== 'string' || !session.id || sessionIds.has(session.id)
      || typeof session.projectId !== 'string' || typeof session.directory !== 'string' || !session.directory
      || !Array.isArray(session.items)) return false;
    sessionIds.add(session.id);
  }

  return true;
}

// Keep only one session whose tagged issue item and ready worktree agree on its exact directory.
function findExactSessionMatches(
  sessions: GuestSessionsSnapshot,
  worktrees: GuestWorktreesSnapshot,
  record: RecoveryRecord,
): GuestSessionsSnapshot['sessions'] {
  return sessions.sessions.filter((session) => {
    if (session.projectId !== record.origin.localProjectId) return false;
    const sessionCoverage = sessions.coverage.filter((coverage) => coverage.directory === session.directory && coverage.state === 'ready');
    const registeredWorktree = worktrees.worktrees.filter((worktree) => worktree.directory === session.directory && worktree.status === 'ready');
    if (sessionCoverage.length !== 1 || registeredWorktree.length !== 1) return false;

    return session.items.filter((item) => item.id === recoveryIssueId(record) && isRecoveryIssueData(item.data, record)).length === 1;
  });
}

// Reuse the extension's exact attachment identity when checking the recovery marker.
function recoveryIssueId(record: RecoveryRecord): string {
  return `${record.origin.variant}:issue:${record.origin.accountId}:${record.origin.gitlabProjectId}:${record.origin.iid}`;
}

// Match the explicit attempt marker and every origin issue identity field without normalizing values.
function isRecoveryIssueData(value: JsonValue | undefined, record: RecoveryRecord): boolean {
  if (!isJsonRecord(value)) return false;

  return value.recoveryAttemptId === record.attemptId
    && value.v === 1
    && value.variant === record.origin.variant
    && value.accountId === record.origin.accountId
    && value.projectId === record.origin.gitlabProjectId
    && value.iid === record.origin.iid
    && value.issueId === record.origin.issueId
    && value.webUrl === record.origin.webUrl;
}

// Reject unsupported versions, extra persisted fields, and malformed nested values before use.
function isRecoveryRecord(value: JsonValue | undefined): value is JsonRecord & RecoveryRecord {
  if (!isJsonRecord(value) || !hasExactKeys(value, ['version', 'attemptId', 'startedAt', 'origin', 'outcome'])
    || value.version !== 1 || typeof value.attemptId !== 'string' || !UUID_PATTERN.test(value.attemptId)
    || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
    || !isJsonRecord(value.origin) || !isRecoveryOrigin(value.origin) || !isJsonRecord(value.outcome)) return false;

  const outcome = value.outcome;
  if (outcome.kind === 'unresolved') return hasExactKeys(outcome, ['kind']);
  if (outcome.kind === 'created') {
    return hasExactKeys(outcome, ['kind', 'sessionId', 'directory', 'linked', 'sent'])
      && isNonEmptyString(outcome.sessionId) && isNonEmptyString(outcome.directory)
      && typeof outcome.linked === 'boolean'
      && ['sent', 'no-model', 'skipped', 'failed', 'unknown'].includes(String(outcome.sent));
  }
  if (outcome.kind === 'retained') {
    return hasExactKeys(outcome, ['kind', 'directory', 'failure'])
      && isNonEmptyString(outcome.directory)
      && ['bootstrap-failed', 'session-create-failed'].includes(String(outcome.failure));
  }

  return false;
}

// Validate the complete immutable origin shape and numeric identities.
function isRecoveryOrigin(value: JsonRecord): value is JsonRecord & RecoveryOrigin {
  return hasExactKeys(value, ['localProjectId', 'directory', 'accountId', 'variant', 'gitlabProjectId', 'iid', 'issueId', 'webUrl'])
    && isNonEmptyString(value.localProjectId) && isNonEmptyString(value.directory)
    && isPositiveSafeInteger(value.accountId) && isNonEmptyString(value.variant)
    && isPositiveSafeInteger(value.gitlabProjectId) && isPositiveSafeInteger(value.iid)
    && isPositiveSafeInteger(value.issueId) && isNonEmptyString(value.webUrl);
}

// Keep storage values limited to plain JSON objects.
function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Compare object keys exactly so later versions cannot be partially interpreted as v1.
function hasExactKeys(value: JsonRecord, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// Accept only non-empty strings as persisted identifiers and paths.
function isNonEmptyString(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

// Require positive safe integers for all persisted numeric identities.
function isPositiveSafeInteger(value: JsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
