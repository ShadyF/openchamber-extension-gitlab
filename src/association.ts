import type { GuestProjectsSnapshot, GuestWorktreesSnapshot, GuestProject, HostClient, JsonValue } from '@openchamber/sdk';
import type { GitLabProject } from './gitlab.js';

export type DirectoryResolution =
  | { kind: 'registered'; project: GuestProject }
  | { kind: 'unknown' }
  | { kind: 'unresolved'; reason: 'no-directory' | 'incomplete' | 'ambiguous' | 'pending' };

export type AssociationScope = {
  projectId: string;
  accountId: number;
  variant: string;
};

export type SavedAssociation = {
  id: number;
  path: string;
};

export type AssociationStorage = Pick<HostClient['storage'], 'get' | 'set' | 'delete'>;

export type PreparedAssociation = {
  key: string;
  value: JsonValue;
};

type JsonRecord = Record<string, JsonValue>;

// Resolve only exact paths from complete, ready snapshots; never normalize or guess a directory.
export function resolveDirectory(
  directory: string | null,
  projectsSnapshot: GuestProjectsSnapshot,
  worktreeSnapshots: GuestWorktreesSnapshot[],
): DirectoryResolution {
  if (!directory) return { kind: 'unresolved', reason: 'no-directory' };
  if (projectsSnapshot.state !== 'ready') return { kind: 'unresolved', reason: 'incomplete' };

  // Validate registered local repository identities before matching any paths.
  const projectIds = new Set<string>();
  for (const project of projectsSnapshot.projects) {
    if (typeof project.id !== 'string' || !project.id || typeof project.name !== 'string' || !project.name || typeof project.directory !== 'string' || !project.directory || projectIds.has(project.id)) {
      return { kind: 'unresolved', reason: 'incomplete' };
    }
    projectIds.add(project.id);
  }

  // Require exactly one complete worktree snapshot for each registered repository.
  if (worktreeSnapshots.length !== projectIds.size) return { kind: 'unresolved', reason: 'incomplete' };

  // Index only ready snapshots with valid records and known project IDs.
  const worktreesByProject = new Map<string, GuestWorktreesSnapshot>();
  for (const snapshot of worktreeSnapshots) {
    if (snapshot.kind !== 'worktrees' || typeof snapshot.projectId !== 'string' || !projectIds.has(snapshot.projectId) || worktreesByProject.has(snapshot.projectId) || snapshot.state !== 'ready' || !Array.isArray(snapshot.worktrees)) {
      return { kind: 'unresolved', reason: 'incomplete' };
    }

    // Reject malformed worktree records so bad snapshots cannot turn into session-only matches.
    for (const worktree of snapshot.worktrees) {
      if (typeof worktree.directory !== 'string' || typeof worktree.status !== 'string' || !['ready', 'pending', 'invalid', 'missing'].includes(worktree.status)) {
        return { kind: 'unresolved', reason: 'incomplete' };
      }
    }

    worktreesByProject.set(snapshot.projectId, snapshot);
  }

  // Refuse missing snapshots before examining exact directory matches.
  if (worktreesByProject.size !== projectIds.size) return { kind: 'unresolved', reason: 'incomplete' };

  // Compare the requested directory literally against repository roots and worktree paths.
  const matches: GuestProject[] = [];
  let pendingMatch = false;
  for (const project of projectsSnapshot.projects) {
    const snapshot = worktreesByProject.get(project.id);
    if (!snapshot) return { kind: 'unresolved', reason: 'incomplete' };

    if (project.directory === directory) matches.push(project);
    for (const worktree of snapshot.worktrees) {
      if (worktree.directory !== directory) continue;
      if (worktree.status === 'ready') matches.push(project);
      else pendingMatch = true;
    }
  }

  // Pending or duplicate matches are never treated as an unknown directory.
  if (pendingMatch) return { kind: 'unresolved', reason: 'pending' };
  if (matches.length > 1) return { kind: 'unresolved', reason: 'ambiguous' };
  if (matches.length === 1) return { kind: 'registered', project: matches[0]! };
  return { kind: 'unknown' };
}

// Hash all three scope fields into a bounded key that cannot reveal project names or server URLs.
export async function associationStorageKey(scope: AssociationScope): Promise<string> {
  const encodedScope = new TextEncoder().encode(JSON.stringify([scope.projectId, scope.accountId, scope.variant]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encodedScope);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `gitlab-association:v1:${hash}`;
}

// Read only records whose embedded scope still matches the requested registered project, account, and instance.
export async function readAssociation(storage: AssociationStorage, scope: AssociationScope): Promise<SavedAssociation | null> {
  const key = await associationStorageKey(scope);
  const value = await storage.get(key);
  if (!isJsonRecord(value) || value.version !== 1 || value.projectId !== scope.projectId || value.accountId !== scope.accountId || value.variant !== scope.variant) {
    return null;
  }

  // Validate the saved GitLab identifier and path before returning it to the controller.
  const project = value.project;
  if (!isJsonRecord(project) || typeof project.id !== 'number' || !Number.isSafeInteger(project.id) || project.id <= 0 || typeof project.path !== 'string' || !project.path) {
    return null;
  }

  return { id: project.id, path: project.path };
}

// Prepare the scoped storage key and payload before the final account identity check.
export async function prepareAssociation(scope: AssociationScope, project: GitLabProject): Promise<PreparedAssociation> {
  const key = await associationStorageKey(scope);
  const value: JsonValue = {
    version: 1,
    projectId: scope.projectId,
    accountId: scope.accountId,
    variant: scope.variant,
    project: { id: project.id, path: project.path },
  };
  return { key, value };
}

// Start persistence only while the controller's verified context is still current.
export async function writePreparedAssociation(
  storage: AssociationStorage,
  prepared: PreparedAssociation,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!isCurrent()) return false;
  await storage.set(prepared.key, prepared.value);
  return true;
}

// Persist only the project identity under the complete OpenChamber, GitLab account, and instance scope.
export async function writeAssociation(storage: AssociationStorage, scope: AssociationScope, project: GitLabProject): Promise<void> {
  await writePreparedAssociation(storage, await prepareAssociation(scope, project));
}

// Delete only the association for the current full scope.
export async function deleteAssociation(storage: AssociationStorage, scope: AssociationScope): Promise<void> {
  await storage.delete(await associationStorageKey(scope));
}

// Narrow the host's JSON value before reading persisted association fields.
function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
