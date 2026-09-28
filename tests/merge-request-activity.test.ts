import { describe, expect, it } from 'bun:test';
import { GitLabApiError, type GitLabDiscussion, type GitLabJob, type GitLabPipeline } from '../src/gitlab.js';
import { createMergeRequestActivity, type MergeRequestActivityScope } from '../src/merge-request-activity.js';

// Build verified identities with controllable provenance and activation epochs.
function scope(revision = 1, overrides: Partial<MergeRequestActivityScope> = {}): MergeRequestActivityScope {
  return {
    accountId: 73, variant: 'gitlab-self-managed', directory: '/work/project', localProjectId: 'local-project',
    targetProjectId: 812, mergeRequestId: 9012, iid: 12,
    webUrl: 'https://gitlab.example/project/-/merge_requests/12', origin: 'browse', revision, ...overrides,
  };
}

// Keep returned rows representative of the API's normalized, plain-data types.
function pipeline(id: number, projectId: number | null = 812): GitLabPipeline {
  return { id, projectId, status: 'success', ref: 'main', sha: 'abc', source: 'push', createdAt: null, updatedAt: null, startedAt: null, finishedAt: null, webUrl: null };
}
function job(id: number): GitLabJob {
  return { id, name: `job-${id}`, status: 'success', stage: 'test', createdAt: null, startedAt: null, finishedAt: null, webUrl: null };
}
function discussion(id: string, body = 'Note'): GitLabDiscussion {
  return { id, notes: [{ id: Number(id), body, author: null, createdAt: null, updatedAt: null, system: false, resolvable: false, resolved: false, resolvedBy: null, resolvedAt: null }] };
}

// Control request completion order to check cancellation without timing assumptions.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

// Create a state machine with harmless defaults so each test overrides one concern.
function activity(overrides: Partial<Parameters<typeof createMergeRequestActivity>[0]> = {}) {
  return createMergeRequestActivity({
    listMergeRequestPipelines: async () => [], listPipelineJobs: async () => [], listMergeRequestDiscussions: async () => [], onChange() {}, ...overrides,
  });
}

describe('merge request activity state', () => {
  // Keep all sections lazy and coalesce repeated first-page calls.
  it('loads lazily and coalesces identical first-page requests', async () => {
    let pipelineCalls = 0;
    let discussionCalls = 0;
    const pending = deferred<GitLabPipeline[]>();
    const state = activity({
      listMergeRequestPipelines: () => { pipelineCalls += 1; return pending.promise; },
      listMergeRequestDiscussions: async () => { discussionCalls += 1; return []; },
    });
    state.setScope(scope());
    expect(pipelineCalls + discussionCalls).toBe(0);
    const first = state.loadPipelines();
    const second = state.loadPipelines();
    await Promise.resolve();
    expect(pipelineCalls).toBe(1);
    pending.resolve([pipeline(1)]);
    await Promise.all([first, second]);
    await state.loadDiscussions();
    expect(discussionCalls).toBe(1);
  });

  // Clear data across scope changes even when A's identity returns after B.
  it('rejects stale responses through A to B to A and compares all identity fields', async () => {
    const pending = deferred<GitLabPipeline[]>();
    const state = activity({ listMergeRequestPipelines: () => pending.promise });
    state.setScope(scope(1));
    const request = state.loadPipelines();
    state.setScope(scope(2));
    state.setScope(scope(3));
    pending.resolve([pipeline(1)]);
    await request;
    expect(state.snapshot().pipelines.rows).toEqual([]);
    await state.loadPipelines();
    expect(state.snapshot().pipelines.rows).toEqual([pipeline(1)]);
    for (const changed of [
      scope(3, { accountId: 74 }), scope(3, { directory: '/other' }),
      scope(3, { origin: 'explicit-session', sessionId: 's-1' }),
    ]) {
      state.setScope(changed);
      expect(state.snapshot().pipelines.rows).toEqual([]);
      state.setScope(scope(3));
    }
  });

  // Preserve separate section states when one resource fails or is unavailable.
  it('keeps failures independent and hides old rows after a local 403', async () => {
    let fail = false;
    const state = activity({
      listMergeRequestPipelines: async () => [pipeline(1)],
      listMergeRequestDiscussions: async () => { if (fail) throw new GitLabApiError('forbidden', 'merge-requests'); return [discussion('1')]; },
    });
    state.setScope(scope());
    await state.loadPipelines();
    await state.loadDiscussions();
    fail = true;
    await state.refreshDiscussions();
    expect(state.snapshot().discussions).toMatchObject({ status: 'unavailable', rows: [], committedPage: 0 });
    expect(state.snapshot().pipelines.rows).toEqual([pipeline(1)]);
  });

  // Keep a failed append on its original page so a retry cannot skip provider rows.
  it('retries transient append failures on the same page and retains existing rows', async () => {
    const pages: number[] = [];
    const state = activity({ listMergeRequestPipelines: async (_project, _iid, page) => {
      pages.push(page);
      if (page === 1) return Array.from({ length: 20 }, (_, index) => pipeline(index + 1));
      if (pages.filter((item) => item === 2).length === 1) throw new Error('private response body');
      return [pipeline(21)];
    } });
    state.setScope(scope());
    await state.loadPipelines();
    await state.loadMorePipelines();
    expect(state.snapshot().pipelines).toMatchObject({ status: 'error', committedPage: 1, rows: expect.any(Array), error: 'Could not load this activity. Try again.' });
    await state.loadMorePipelines();
    expect(pages).toEqual([1, 2, 2]);
    expect(state.snapshot().pipelines).toMatchObject({ committedPage: 2, rows: expect.arrayContaining([pipeline(21)]) });
    expect(state.snapshot().pipelines.error).toBeNull();
  });

  // Distinguish a full bounded cap from an exhausted or empty page.
  it('marks a full tenth page truncated but does not mark an empty page truncated', async () => {
    const state = activity({ listMergeRequestPipelines: async (_project, _iid, page) => Array.from({ length: page === 10 ? 20 : 20 }, (_, index) => pipeline(page * 100 + index)) });
    state.setScope(scope());
    await state.loadPipelines();
    for (let page = 2; page <= 10; page += 1) await state.loadMorePipelines();
    expect(state.snapshot().pipelines).toMatchObject({ committedPage: 10, hasMore: false, truncated: true });
    await state.loadMorePipelines();
    expect(state.snapshot().pipelines.committedPage).toBe(10);

    const empty = activity({ listMergeRequestPipelines: async () => [] });
    empty.setScope(scope());
    await empty.loadPipelines();
    expect(empty.snapshot().pipelines).toMatchObject({ committedPage: 1, rows: [], hasMore: false, truncated: false });
  });

  // A pipeline refresh must revoke selected jobs before its replacement rows arrive.
  it('clears selected pipeline jobs immediately when pipelines refresh', async () => {
    const refreshedPipelines = deferred<GitLabPipeline[]>();
    const refreshedJobs = deferred<GitLabJob[]>();
    let pipelineCalls = 0;
    const state = activity({
      listMergeRequestPipelines: async () => (++pipelineCalls === 1 ? [pipeline(1)] : refreshedPipelines.promise),
      listPipelineJobs: async () => refreshedJobs.promise,
    });
    state.setScope(scope());
    await state.loadPipelines();
    state.selectPipeline(1);
    const jobsRequest = state.loadMoreJobs();
    refreshedJobs.resolve([job(1)]);
    await jobsRequest;
    expect(state.snapshot().jobs.rows).toEqual([job(1)]);

    const refreshing = state.refreshPipelines();
    expect(state.snapshot()).toMatchObject({ selectedPipelineId: null, jobs: { rows: [], status: 'idle' } });
    refreshedPipelines.resolve([pipeline(2)]);
    await refreshing;
    expect(state.snapshot().selectedPipelineId).toBeNull();
  });

  // A resource-local pipeline failure must invalidate jobs already in flight.
  it('clears selection and ignores in-flight jobs when refreshed pipelines become unavailable', async () => {
    const oldJobs = deferred<GitLabJob[]>();
    const jobsDispatch = deferred<void>();
    let pipelineCalls = 0;
    const state = activity({
      listMergeRequestPipelines: async () => {
        pipelineCalls += 1;
        if (pipelineCalls === 1) return [pipeline(1)];
        throw new GitLabApiError('not-found', 'merge-requests');
      },
      listPipelineJobs: async () => { jobsDispatch.resolve(); return oldJobs.promise; },
    });
    state.setScope(scope());
    await state.loadPipelines();
    state.selectPipeline(1);
    const jobsRequest = state.loadMoreJobs();
    await jobsDispatch.promise;
    const refreshing = state.refreshPipelines();
    await refreshing;
    oldJobs.resolve([job(1)]);
    await jobsRequest;
    expect(state.snapshot()).toMatchObject({
      selectedPipelineId: null,
      pipelines: { status: 'unavailable', rows: [] },
      jobs: { status: 'idle', rows: [] },
    });
  });

  // Pipeline page failures revoke the selected job authority after append dispatch.
  it('revokes jobs on pipeline append unavailability and ignores late success or auth failure', async () => {
    for (const lateResult of ['success', 'disconnected'] as const) {
      const oldJobs = deferred<GitLabJob[]>();
      const jobsDispatch = deferred<void>();
      const pageTwoDispatch = deferred<void>();
      let authFailures = 0;
      let pipelineCalls = 0;
      const state = activity({
        listMergeRequestPipelines: async (_project, _iid, page) => {
          pipelineCalls += 1;
          if (page === 1) return Array.from({ length: 20 }, (_, index) => pipeline(index + 1));
          pageTwoDispatch.resolve();
          throw new GitLabApiError('forbidden', 'merge-requests');
        },
        listPipelineJobs: async () => { jobsDispatch.resolve(); return oldJobs.promise; },
        onAuthenticationFailure() { authFailures += 1; },
      });
      state.setScope(scope());
      await state.loadPipelines();
      state.selectPipeline(1);
      const pendingJobs = state.loadMoreJobs();
      await jobsDispatch.promise;
      const append = state.loadMorePipelines();
      await pageTwoDispatch.promise;
      await append;
      expect(state.snapshot()).toMatchObject({
        selectedPipelineId: null,
        pipelines: { status: 'unavailable', committedPage: 0, rows: [] },
        jobs: { status: 'idle', rows: [] },
      });
      expect(state.snapshot().discussions.status).toBe('idle');

      if (lateResult === 'success') oldJobs.resolve([job(1)]);
      else oldJobs.reject(new GitLabApiError('disconnected', 'merge-requests'));
      await pendingJobs;
      expect(state.snapshot().jobs.rows).toEqual([]);
      expect(authFailures).toBe(0);
      expect(pipelineCalls).toBe(2);
    }
  });

  // Conflicting pipeline owners make every accumulated pipeline row untrusted.
  it('rejects a repeated pipeline ID with a different known owner', async () => {
    const state = activity({ listMergeRequestPipelines: async (_project, _iid, page) => page === 1
      ? Array.from({ length: 20 }, (_, index) => pipeline(index + 1))
      : [pipeline(1, 944)] });
    state.setScope(scope());
    await state.loadPipelines();
    state.selectPipeline(1);
    await state.loadMorePipelines();
    expect(state.snapshot()).toMatchObject({
      selectedPipelineId: null,
      pipelines: { status: 'error', committedPage: 1, rows: [], error: 'Activity data was inconsistent. Refresh to try again.' },
      jobs: { status: 'idle', rows: [] },
    });
  });

  // A note repeated in another discussion makes the accumulated discussion view untrusted.
  it('rejects a note ID repeated under a different discussion ID across pages', async () => {
    const state = activity({ listMergeRequestDiscussions: async (_project, _iid, page) => page === 1
      ? Array.from({ length: 20 }, (_, index) => discussion(String(index + 1)))
      : [{ id: 'other-thread', notes: [discussion('1').notes[0]!] }] });
    state.setScope(scope());
    await state.loadDiscussions();
    await state.loadMoreDiscussions();
    expect(state.snapshot().discussions).toMatchObject({
      status: 'error', committedPage: 1, rows: [], error: 'Activity data was inconsistent. Refresh to try again.',
    });
  });

  // Allow ordinary duplicate overlap when its owner or thread identity agrees.
  it('accepts same-owner pipeline and same-thread note overlaps', async () => {
    const state = activity({
      listMergeRequestPipelines: async (_project, _iid, page) => page === 1
        ? Array.from({ length: 20 }, (_, index) => pipeline(index + 1))
        : [pipeline(1, 812)],
      listMergeRequestDiscussions: async (_project, _iid, page) => page === 1
        ? Array.from({ length: 20 }, (_, index) => discussion(String(index + 1)))
        : [discussion('1', 'Updated note')],
    });
    state.setScope(scope());
    await state.loadPipelines();
    await state.loadMorePipelines();
    await state.loadDiscussions();
    await state.loadMoreDiscussions();
    expect(state.snapshot().pipelines).toMatchObject({ status: 'ready', committedPage: 2, rows: expect.any(Array) });
    expect(state.snapshot().pipelines.rows).toHaveLength(20);
    expect(state.snapshot().discussions).toMatchObject({ status: 'ready', committedPage: 2 });
    expect(state.snapshot().discussions.rows).toHaveLength(20);
  });

  // Coalesce both ordinary and notification-reentrant initial jobs loads after dispatch.
  it('coalesces first-page jobs loads during dispatch and reentrant loading notification', async () => {
    const pending = deferred<GitLabJob[]>();
    const jobsDispatch = deferred<void>();
    let calls = 0;
    let nested: Promise<void> | null = null;
    let reentered = false;
    let state: ReturnType<typeof activity>;
    state = activity({
      listMergeRequestPipelines: async () => [pipeline(1)],
      listPipelineJobs: async () => { calls += 1; jobsDispatch.resolve(); return pending.promise; },
      onChange(snapshot) {
        if (snapshot.jobs.status === 'loading' && !reentered) {
          reentered = true;
          nested = state.loadMoreJobs();
        }
      },
    });
    state.setScope(scope());
    await state.loadPipelines();
    state.selectPipeline(1);
    const first = state.loadMoreJobs();
    await jobsDispatch.promise;
    const second = state.loadMoreJobs();
    expect(calls).toBe(1);
    pending.resolve([job(1)]);
    await Promise.all([first, second, nested]);
    expect(calls).toBe(1);
    expect(state.snapshot().jobs.rows).toEqual([job(1)]);
  });

  // An explicit jobs refresh must supersede an already dispatched initial request.
  it('lets explicit jobs refresh supersede an older dispatched first-page response', async () => {
    const oldJobs = deferred<GitLabJob[]>();
    const freshJobs = deferred<GitLabJob[]>();
    const firstDispatch = deferred<void>();
    const freshDispatch = deferred<void>();
    let calls = 0;
    const state = activity({
      listMergeRequestPipelines: async () => [pipeline(1)],
      listPipelineJobs: async () => {
        calls += 1;
        if (calls === 1) { firstDispatch.resolve(); return oldJobs.promise; }
        freshDispatch.resolve();
        return freshJobs.promise;
      },
    });
    state.setScope(scope());
    await state.loadPipelines();
    state.selectPipeline(1);
    const oldRequest = state.loadMoreJobs();
    await firstDispatch.promise;
    const refreshing = state.refreshJobs();
    await freshDispatch.promise;
    freshJobs.resolve([job(2)]);
    await refreshing;
    oldJobs.resolve([job(1)]);
    await oldRequest;
    expect(calls).toBe(2);
    expect(state.snapshot().jobs.rows).toEqual([job(2)]);
  });

  // Related issue provenance is valid only when tied to the verified session.
  it('rejects related-issue scope without a nonempty session ID', () => {
    const state = activity();
    state.setScope(scope(1, { origin: 'related-issue', issueId: 500, issueIid: 4 }));
    expect(state.snapshot().scope).toBeNull();
  });

  // Keep a reentrant section request from launching twice during its loading publication.
  it('coalesces reentrant first-page loads and skips requests for a replaced scope', async () => {
    let calls = 0;
    let nested: Promise<void> | null = null;
    let reentered = false;
    let state: ReturnType<typeof activity>;
    state = activity({
      listMergeRequestPipelines: async () => { calls += 1; return [pipeline(1)]; },
      onChange(snapshot) {
        if (snapshot.pipelines.status === 'loading' && !reentered) {
          reentered = true;
          nested = state.loadPipelines();
        }
      },
    });
    state.setScope(scope());
    const first = state.loadPipelines();
    await Promise.all([first, nested]);
    expect(calls).toBe(1);

    let staleCalls = 0;
    let changed = false;
    state = activity({
      listMergeRequestPipelines: async () => { staleCalls += 1; return []; },
      onChange(snapshot) {
        if (snapshot.pipelines.status === 'loading' && !changed) {
          changed = true;
          state.setScope(scope(2));
        }
      },
    });
    state.setScope(scope());
    await state.loadPipelines();
    expect(staleCalls).toBe(0);
  });

  // Preserve the owner warning if jobs are refreshed without a safe project ID.
  it('keeps missing pipeline-owner feedback on jobs refresh', async () => {
    let jobCalls = 0;
    const state = activity({
      listMergeRequestPipelines: async () => [pipeline(1, null)],
      listPipelineJobs: async () => { jobCalls += 1; return []; },
    });
    state.setScope(scope());
    await state.loadPipelines();
    state.selectPipeline(1);
    await state.refreshJobs();
    expect(state.snapshot().jobs).toMatchObject({ status: 'unavailable', error: 'Pipeline owner is unknown; jobs cannot be loaded safely.' });
    expect(jobCalls).toBe(0);
  });

  // Only current authentication loss invokes the owner callback, with no later publish.
  it('ignores stale 401 and stops publication after current authentication failure', async () => {
    const stale = deferred<GitLabDiscussion[]>();
    const staleState = activity({ listMergeRequestDiscussions: () => stale.promise, onAuthenticationFailure() { throw new Error('stale auth callback'); } });
    staleState.setScope(scope());
    const staleRequest = staleState.loadDiscussions();
    await Promise.resolve();
    staleState.setScope(scope(2));
    stale.reject(new GitLabApiError('disconnected', 'merge-requests'));
    await staleRequest;

    let callbacks = 0;
    let changes = 0;
    let callbackChanges = -1;
    const current = activity({
      listMergeRequestDiscussions: async () => { throw new GitLabApiError('disconnected', 'merge-requests'); },
      onAuthenticationFailure() { callbacks += 1; current.setScope(null); callbackChanges = changes; },
      onChange() { changes += 1; },
    });
    current.setScope(scope());
    const request = current.loadDiscussions();
    const before = changes;
    await request;
    expect(callbacks).toBe(1);
    expect(changes).toBe(callbackChanges);
    expect(changes).toBe(before + 2);
  });

  // Use the fork pipeline's owner, never the merge request target, for job paths.
  it('loads fork pipeline jobs from the returned owner and never guesses missing owners', async () => {
    const jobProjects: number[] = [];
    const state = activity({
      listMergeRequestPipelines: async () => [pipeline(1, 944), pipeline(2, null)],
      listPipelineJobs: async (projectId) => { jobProjects.push(projectId); return [job(1)]; },
    });
    state.setScope(scope());
    await state.loadPipelines();
    state.selectPipeline(1);
    await state.loadMoreJobs();
    expect(jobProjects).toEqual([944]);
    state.selectPipeline(2);
    expect(state.snapshot().jobs).toMatchObject({ status: 'unavailable', error: 'Pipeline owner is unknown; jobs cannot be loaded safely.' });
    await state.loadMoreJobs();
    expect(jobProjects).toEqual([944]);
  });

  // Ignore older job responses after a different pipeline becomes selected.
  it('invalidates jobs when the selected pipeline changes', async () => {
    const pending = deferred<GitLabJob[]>();
    const state = activity({
      listMergeRequestPipelines: async () => [pipeline(1, 944), pipeline(2, 955)],
      listPipelineJobs: (_project, id) => id === 1 ? pending.promise : Promise.resolve([job(2)]),
    });
    state.setScope(scope());
    await state.loadPipelines();
    state.selectPipeline(1);
    const old = state.loadMoreJobs();
    state.selectPipeline(2);
    await state.loadMoreJobs();
    pending.resolve([job(1)]);
    await old;
    expect(state.snapshot().jobs.rows).toEqual([job(2)]);
  });

  // Refresh starts a new generation, so older first-page success cannot replace it.
  it('lets refresh supersede an older success and stops updates after destroy', async () => {
    const old = deferred<GitLabDiscussion[]>();
    const fresh = deferred<GitLabDiscussion[]>();
    let calls = 0;
    const state = activity({ listMergeRequestDiscussions: () => (++calls === 1 ? old.promise : fresh.promise) });
    state.setScope(scope());
    const first = state.loadDiscussions();
    await Promise.resolve();
    const refresh = state.refreshDiscussions();
    fresh.resolve([discussion('2')]);
    await refresh;
    old.resolve([discussion('1')]);
    await first;
    expect(state.snapshot().discussions.rows).toEqual([discussion('2')]);
    state.destroy();
    const previous = state.snapshot();
    state.setScope(null);
    expect(state.snapshot()).toEqual(previous);
  });

  // Preserve untrusted provider notes only as inert strings in plain snapshot data.
  it('keeps provider note text as plain data without interpreting markup', async () => {
    const body = '<img src=x onerror=alert(1)>';
    const state = activity({ listMergeRequestDiscussions: async () => [discussion('1', body)] });
    state.setScope(scope());
    await state.loadDiscussions();
    expect(state.snapshot().discussions.rows[0]?.notes[0]?.body).toBe(body);
    expect(Object.isFrozen(state.snapshot().discussions.rows[0]?.notes[0])).toBe(true);
  });
});
