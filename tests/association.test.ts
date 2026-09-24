import { describe, expect, it } from 'bun:test';
import type { GuestProjectsSnapshot, GuestWorktreesSnapshot, HostClient } from '@openchamber/sdk';
import {
  associationStorageKey,
  deleteAssociation,
  readAssociation,
  resolveDirectory,
  writeAssociation,
  type AssociationScope,
} from '../src/association.js';
import { GITLAB_VARIANT_ID } from '../src/gitlab.js';

const projectSnapshot: GuestProjectsSnapshot = {
  kind: 'projects',
  state: 'ready',
  projects: [{ id: 'workspace-1', name: 'OpenChamber', directory: '/repos/openchamber' }],
};

const readyWorktrees: GuestWorktreesSnapshot = {
  kind: 'worktrees',
  projectId: 'workspace-1',
  state: 'ready',
  worktrees: [{ directory: '/repos/openchamber/.worktrees/fix', name: 'fix', branch: 'fix', status: 'ready' }],
};

// Keep storage calls in an isolated in-memory host namespace for each test.
function memoryStorage(): HostClient['storage'] {
  const values = new Map<string, unknown>();
  return {
    async get(key) { return values.get(key) as Awaited<ReturnType<HostClient['storage']['get']>>; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async keys() { return [...values.keys()].sort(); },
  };
}

// Verify exact workspace matching and privacy-preserving storage boundaries.
describe('association resolution and storage', () => {
  // A root directory and its ready worktree must share one registered project ID.
  it('resolves exact repository and registered worktree paths to the same OpenChamber project', () => {
    expect(resolveDirectory('/repos/openchamber', projectSnapshot, [readyWorktrees])).toEqual({
      kind: 'registered',
      project: projectSnapshot.projects[0],
    });
    expect(resolveDirectory('/repos/openchamber/.worktrees/fix', projectSnapshot, [readyWorktrees])).toEqual({
      kind: 'registered',
      project: projectSnapshot.projects[0],
    });
  });

  // An unknown path is safe only after every authoritative snapshot is ready.
  it('allows unknown directories only after all snapshots are ready', () => {
    expect(resolveDirectory('/tmp/loose-session', projectSnapshot, [readyWorktrees])).toEqual({ kind: 'unknown' });
    expect(resolveDirectory('/tmp/loose-session', { ...projectSnapshot, state: 'loading' }, [readyWorktrees])).toEqual({ kind: 'unresolved', reason: 'incomplete' });
    expect(resolveDirectory('/tmp/loose-session', projectSnapshot, [])).toEqual({ kind: 'unresolved', reason: 'incomplete' });
    expect(resolveDirectory(null, projectSnapshot, [readyWorktrees])).toEqual({ kind: 'unresolved', reason: 'no-directory' });
  });

  // Ambiguous registrations and non-ready worktrees must never be treated as unknown.
  it('fails closed for ambiguous and non-ready worktree matches', () => {
    const duplicateProject: GuestProjectsSnapshot = {
      ...projectSnapshot,
      projects: [...projectSnapshot.projects, { id: 'workspace-2', name: 'Other', directory: '/repos/openchamber' }],
    };
    const otherWorktrees: GuestWorktreesSnapshot = { ...readyWorktrees, projectId: 'workspace-2', worktrees: [] };
    const pending: GuestWorktreesSnapshot = {
      ...readyWorktrees,
      worktrees: [{ directory: '/repos/openchamber/.worktrees/fix', name: 'fix', branch: 'fix', status: 'pending' }],
    };

    expect(resolveDirectory('/repos/openchamber', duplicateProject, [readyWorktrees, otherWorktrees])).toEqual({ kind: 'unresolved', reason: 'ambiguous' });
    expect(resolveDirectory('/repos/openchamber/.worktrees/fix', projectSnapshot, [pending])).toEqual({ kind: 'unresolved', reason: 'pending' });
    expect(resolveDirectory('/repos/openchamber', projectSnapshot, [{ ...readyWorktrees, state: 'error' }])).toEqual({ kind: 'unresolved', reason: 'incomplete' });
  });

  // Verify project, numeric account, and fixed variant produce bounded, non-readable storage keys.
  it('scopes storage keys by registered project, numeric account, and variant', async () => {
    const first: AssociationScope = { projectId: 'workspace-1', accountId: 73, variant: GITLAB_VARIANT_ID };
    const keys = await Promise.all([
      associationStorageKey(first),
      associationStorageKey({ ...first, projectId: 'workspace-2' }),
      associationStorageKey({ ...first, accountId: 74 }),
      associationStorageKey({ ...first, variant: 'another-extension-variant' }),
    ]);

    expect(new Set(keys).size).toBe(4);
    expect(keys[0]!.length).toBeLessThanOrEqual(128);
    expect(keys[0]).not.toContain('workspace-1');
    expect(keys[0]).not.toContain(GITLAB_VARIANT_ID);
  });

  // Confirm reads, writes, and removes stay within the full account and instance scope.
  it('round-trips and removes only the full registered scope', async () => {
    const storage = memoryStorage();
    const first: AssociationScope = { projectId: 'workspace-1', accountId: 73, variant: GITLAB_VARIANT_ID };
    const otherAccount = { ...first, accountId: 74 };

    await writeAssociation(storage, first, { id: 812, path: 'platform/infra/deploy' });
    await expect(readAssociation(storage, first)).resolves.toEqual({ id: 812, path: 'platform/infra/deploy' });
    await expect(readAssociation(storage, otherAccount)).resolves.toBeNull();
    await deleteAssociation(storage, otherAccount);
    await expect(readAssociation(storage, first)).resolves.toEqual({ id: 812, path: 'platform/infra/deploy' });
    await deleteAssociation(storage, first);
    await expect(readAssociation(storage, first)).resolves.toBeNull();
  });
});
