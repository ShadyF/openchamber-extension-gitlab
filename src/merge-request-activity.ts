import { GitLabApiError, type GitLabDiscussion, type GitLabJob, type GitLabPipeline } from './gitlab.js';

export type MergeRequestActivityScope = Readonly<{
  accountId: number;
  variant: string;
  directory: string;
  localProjectId: string | null;
  targetProjectId: number;
  mergeRequestId: number;
  iid: number;
  webUrl: string;
  origin: 'browse' | 'explicit-session' | 'related-issue';
  sessionId?: string;
  issueId?: number;
  issueIid?: number;
  revision: number;
}>;

export type ActivityCollection<T> = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  rows: readonly T[];
  committedPage: number;
  loadingMore: boolean;
  hasMore: boolean;
  truncated: boolean;
  error: string | null;
}>;

export type MergeRequestActivitySnapshot = Readonly<{
  scope: MergeRequestActivityScope | null;
  pipelines: ActivityCollection<GitLabPipeline>;
  discussions: ActivityCollection<GitLabDiscussion>;
  selectedPipelineId: number | null;
  jobs: ActivityCollection<GitLabJob>;
}>;

export type MergeRequestActivityOptions = Readonly<{
  listMergeRequestPipelines: (projectId: number, iid: number, page: number) => Promise<GitLabPipeline[]>;
  listPipelineJobs: (projectId: number, pipelineId: number, page: number) => Promise<GitLabJob[]>;
  listMergeRequestDiscussions: (projectId: number, iid: number, page: number) => Promise<GitLabDiscussion[]>;
  onChange: (snapshot: MergeRequestActivitySnapshot) => void;
  onAuthenticationFailure?: () => void;
}>;

export type MergeRequestActivity = Readonly<{
  setScope: (scope: MergeRequestActivityScope | null) => void;
  snapshot: () => MergeRequestActivitySnapshot;
  loadPipelines: () => Promise<void>;
  loadMorePipelines: () => Promise<void>;
  refreshPipelines: () => Promise<void>;
  loadDiscussions: () => Promise<void>;
  loadMoreDiscussions: () => Promise<void>;
  refreshDiscussions: () => Promise<void>;
  selectPipeline: (pipelineId: number | null) => void;
  loadMoreJobs: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  destroy: () => void;
}>;

type MutableCollection<T> = {
  status: ActivityCollection<T>['status'];
  rows: T[];
  committedPage: number;
  loadingMore: boolean;
  hasMore: boolean;
  truncated: boolean;
  error: string | null;
};

const PAGE_SIZE = 20;
const MAX_PAGES = 10;

// Freeze nested provider records as well as their containing snapshot arrays.
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

// Start each independently loaded section in a clean, idle state.
function emptyCollection<T>(): MutableCollection<T> {
  return { status: 'idle', rows: [], committedPage: 0, loadingMore: false, hasMore: false, truncated: false, error: null };
}

// Accept only verified identities with valid numeric and provenance requirements.
function validScope(scope: MergeRequestActivityScope): boolean {
  const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
  return Number.isSafeInteger(scope.revision) && scope.revision >= 0
    && positive(scope.accountId) && positive(scope.targetProjectId) && positive(scope.mergeRequestId) && positive(scope.iid)
    && Boolean(scope.variant.trim() && scope.directory.trim() && scope.webUrl.trim())
    && (scope.localProjectId === null || Boolean(scope.localProjectId.trim()))
    && (scope.origin === 'browse'
      ? !scope.sessionId && scope.issueId === undefined && scope.issueIid === undefined
      : scope.origin === 'explicit-session'
        ? Boolean(scope.sessionId?.trim()) && scope.issueId === undefined && scope.issueIid === undefined
        : scope.origin === 'related-issue' && Boolean(scope.sessionId?.trim())
          && positive(scope.issueId ?? 0) && positive(scope.issueIid ?? 0));
}

// Compare every authority field so rebuilt objects are stable but provenance changes revoke access.
function sameScope(left: MergeRequestActivityScope | null, right: MergeRequestActivityScope | null): boolean {
  return left === right || Boolean(left && right
    && left.accountId === right.accountId && left.variant === right.variant && left.directory === right.directory
    && left.localProjectId === right.localProjectId && left.targetProjectId === right.targetProjectId
    && left.mergeRequestId === right.mergeRequestId && left.iid === right.iid && left.webUrl === right.webUrl
    && left.origin === right.origin && left.sessionId === right.sessionId && left.issueId === right.issueId
    && left.issueIid === right.issueIid && left.revision === right.revision);
}

// Convert provider failures to section-safe text without exposing response bodies.
function safeError(error: unknown): { kind: 'authentication' | 'unavailable' | 'error'; message: string } {
  if (error instanceof GitLabApiError) {
    if (error.code === 'disconnected') return { kind: 'authentication', message: 'GitLab authentication is unavailable.' };
    if (error.code === 'forbidden' || error.code === 'not-found') {
      return { kind: 'unavailable', message: 'This activity is unavailable or cannot be viewed.' };
    }
  }
  return { kind: 'error', message: 'Could not load this activity. Try again.' };
}

// Create the isolated, read-only activity state for one verified merge request.
export function createMergeRequestActivity(options: MergeRequestActivityOptions): MergeRequestActivity {
  let scope: MergeRequestActivityScope | null = null;
  let pipelines = emptyCollection<GitLabPipeline>();
  let discussions = emptyCollection<GitLabDiscussion>();
  let jobs = emptyCollection<GitLabJob>();
  let selectedPipelineId: number | null = null;
  let destroyed = false;
  let pipelinesGeneration = 0;
  let discussionsGeneration = 0;
  let jobsGeneration = 0;
  let pipelinePending: Promise<void> | null = null;
  let discussionPending: Promise<void> | null = null;
  let jobsPending: Promise<void> | null = null;

  // Return detached frozen data so panel consumers cannot mutate internal state.
  function snapshot(): MergeRequestActivitySnapshot {
    const copy = <T>(collection: MutableCollection<T>): ActivityCollection<T> => Object.freeze({
      ...collection,
      rows: Object.freeze(collection.rows.map((row) => freezeData(structuredClone(row)))),
    });
    return Object.freeze({
      scope: scope ? Object.freeze({ ...scope }) : null,
      pipelines: copy(pipelines), discussions: copy(discussions), jobs: copy(jobs), selectedPipelineId,
    });
  }

  // Publish only while this state machine remains alive.
  function notify(): void {
    if (!destroyed) options.onChange(snapshot());
  }

  // Keep requests valid only for the same full scope and section generation.
  function isCurrent(captured: MergeRequestActivityScope, generation: number, current: number): boolean {
    return !destroyed && generation === current && sameScope(scope, captured);
  }

  // Remove duplicate rows while preserving provider ordering.
  function appendUnique<T>(existing: readonly T[], incoming: readonly T[], keyOf: (row: T) => string | number): T[] {
    const seen = new Set(existing.map(keyOf));
    const result = [...existing];
    for (const row of incoming) {
      const key = keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(row);
    }
    return result;
  }

  // Revoke jobs whenever accumulated pipeline identity is no longer trustworthy.
  function clearSelectedJobs(): void {
    jobsGeneration += 1;
    selectedPipelineId = null;
    jobs = emptyCollection<GitLabJob>();
    jobsPending = null;
  }

  // Detect contradictory cross-page owners or note-thread membership before committing a page.
  function hasRelationshipConflict<T>(section: 'pipelines' | 'discussions' | 'jobs', existing: readonly T[], incoming: readonly T[]): boolean {
    if (section === 'pipelines') {
      const owners = new Map<number, number>();
      for (const row of [...existing, ...incoming] as GitLabPipeline[]) {
        if (row.projectId === null) continue;
        const priorOwner = owners.get(row.id);
        if (priorOwner !== undefined && priorOwner !== row.projectId) return true;
        owners.set(row.id, row.projectId);
      }
    }
    if (section === 'discussions') {
      const threads = new Map<number, string>();
      for (const row of [...existing, ...incoming] as GitLabDiscussion[]) {
        for (const note of row.notes) {
          const priorThread = threads.get(note.id);
          if (priorThread !== undefined && priorThread !== row.id) return true;
          threads.set(note.id, row.id);
        }
      }
    }
    return false;
  }

  // Load one bounded page and commit only a response that still owns this section.
  async function load<T>(section: 'pipelines' | 'discussions' | 'jobs', mode: 'first' | 'append', fetchPage: (page: number) => Promise<T[]>, keyOf: (row: T) => string | number): Promise<void> {
    const captured = scope;
    const collection = (section === 'pipelines' ? pipelines : section === 'discussions' ? discussions : jobs) as MutableCollection<T>;
    if (!captured || destroyed) return;
    if (mode === 'append' && (collection.loadingMore || !collection.hasMore || collection.committedPage >= MAX_PAGES)) return;
    const generation = section === 'pipelines' ? ++pipelinesGeneration : section === 'discussions' ? ++discussionsGeneration : ++jobsGeneration;
    const page = mode === 'append' ? collection.committedPage + 1 : 1;
    if (mode === 'first') {
      collection.rows = [];
      collection.committedPage = 0;
      collection.hasMore = false;
      collection.truncated = false;
      collection.error = null;
      collection.status = 'loading';
      collection.loadingMore = false;
    } else {
      collection.loadingMore = true;
      collection.error = null;
    }

    // Revoke selected jobs as soon as pipeline rows are replaced, before yielding to callers.
    if (section === 'pipelines' && mode === 'first') clearSelectedJobs();

    // Yield once so the caller can publish the pending promise before reentrant listeners run.
    await Promise.resolve();
    const generationBeforeNotify = section === 'pipelines' ? pipelinesGeneration : section === 'discussions' ? discussionsGeneration : jobsGeneration;
    if (!isCurrent(captured, generation, generationBeforeNotify)) return;
    notify();
    const currentGeneration = section === 'pipelines' ? pipelinesGeneration : section === 'discussions' ? discussionsGeneration : jobsGeneration;
    if (!isCurrent(captured, generation, currentGeneration)) return;
    try {
      const result = await fetchPage(page);
      const responseGeneration = section === 'pipelines' ? pipelinesGeneration : section === 'discussions' ? discussionsGeneration : jobsGeneration;
      if (!isCurrent(captured, generation, responseGeneration)) return;
      if (!Array.isArray(result)) throw new Error('Malformed activity response');
      if (mode === 'append' && hasRelationshipConflict(section, collection.rows, result)) {
        collection.rows = [];
        collection.status = 'error';
        collection.error = 'Activity data was inconsistent. Refresh to try again.';
        collection.hasMore = false;
        collection.truncated = false;
        if (section === 'pipelines') clearSelectedJobs();
      } else {
        collection.rows = mode === 'append' ? appendUnique(collection.rows, result, keyOf) : [...result];
        collection.committedPage = page;
        collection.status = 'ready';
        collection.hasMore = result.length === PAGE_SIZE && page < MAX_PAGES;
        collection.truncated = result.length === PAGE_SIZE && page === MAX_PAGES;
        collection.error = null;
      }
    } catch (error) {
      const responseGeneration = section === 'pipelines' ? pipelinesGeneration : section === 'discussions' ? discussionsGeneration : jobsGeneration;
      if (!isCurrent(captured, generation, responseGeneration)) return;
      const failure = safeError(error);
      if (failure.kind === 'authentication') {
        pipelinesGeneration += 1;
        discussionsGeneration += 1;
        jobsGeneration += 1;
        options.onAuthenticationFailure?.();
        return;
      }
      collection.error = failure.message;
      collection.status = failure.kind;
      if (failure.kind === 'unavailable') {
        collection.rows = [];
        collection.committedPage = 0;
        collection.hasMore = false;
        collection.truncated = false;
        if (section === 'pipelines') clearSelectedJobs();
      }
    } finally {
      const responseGeneration = section === 'pipelines' ? pipelinesGeneration : section === 'discussions' ? discussionsGeneration : jobsGeneration;
      if (isCurrent(captured, generation, responseGeneration)) {
        collection.loadingMore = false;
        if (collection.status === 'loading') collection.status = 'ready';
        notify();
      }
    }
  }

  // Request pipelines only when the caller explicitly opens this section.
  function loadPipelines(): Promise<void> {
    if (pipelines.status === 'loading' && pipelinePending) return pipelinePending;
    if (pipelines.committedPage > 0) return Promise.resolve();
    const captured = scope;
    if (!captured) return Promise.resolve();
    pipelinePending = load('pipelines', 'first', (page) => options.listMergeRequestPipelines(captured.targetProjectId, captured.iid, page), (row) => row.id);
    return pipelinePending;
  }

  // Append the next pipeline page without changing the committed page on failure.
  async function loadMorePipelines(): Promise<void> {
    if (pipelinePending && pipelines.loadingMore) return pipelinePending;
    const captured = scope;
    if (!captured) return;
    pipelinePending = load('pipelines', 'append', (page) => options.listMergeRequestPipelines(captured.targetProjectId, captured.iid, page), (row) => row.id);
    return pipelinePending;
  }

  // Replace old pipeline rows immediately when the user requests a fresh view.
  async function refreshPipelines(): Promise<void> {
    const captured = scope;
    if (!captured) return;
    pipelinePending = load('pipelines', 'first', (page) => options.listMergeRequestPipelines(captured.targetProjectId, captured.iid, page), (row) => row.id);
    return pipelinePending;
  }

  // Request discussions lazily for the verified merge request.
  function loadDiscussions(): Promise<void> {
    if (discussions.status === 'loading' && discussionPending) return discussionPending;
    if (discussions.committedPage > 0) return Promise.resolve();
    const captured = scope;
    if (!captured) return Promise.resolve();
    discussionPending = load('discussions', 'first', (page) => options.listMergeRequestDiscussions(captured.targetProjectId, captured.iid, page), (row) => row.id);
    return discussionPending;
  }

  // Append discussion pages while preserving already committed notes on failure.
  async function loadMoreDiscussions(): Promise<void> {
    if (discussionPending && discussions.loadingMore) return discussionPending;
    const captured = scope;
    if (!captured) return;
    discussionPending = load('discussions', 'append', (page) => options.listMergeRequestDiscussions(captured.targetProjectId, captured.iid, page), (row) => row.id);
    return discussionPending;
  }

  // Refresh discussions independently from pipeline and job state.
  async function refreshDiscussions(): Promise<void> {
    const captured = scope;
    if (!captured) return;
    discussionPending = load('discussions', 'first', (page) => options.listMergeRequestDiscussions(captured.targetProjectId, captured.iid, page), (row) => row.id);
    return discussionPending;
  }

  // Request jobs only for a fetched pipeline and its own reported project owner.
  function selectPipeline(pipelineId: number | null): void {
    if (destroyed || selectedPipelineId === pipelineId) return;
    jobsGeneration += 1;
    selectedPipelineId = pipelineId;
    jobs = emptyCollection<GitLabJob>();
    if (pipelineId !== null) {
      const selected = pipelines.rows.find((pipeline) => pipeline.id === pipelineId);
      if (selected && (!Number.isSafeInteger(selected.projectId) || (selected.projectId ?? 0) <= 0)) {
        jobs.status = 'unavailable';
        jobs.error = 'Pipeline owner is unknown; jobs cannot be loaded safely.';
      }
    }
    jobsPending = null;
    notify();
  }

  // Load the selected pipeline's next jobs page using only its validated owner.
  async function loadMoreJobs(): Promise<void> {
    if (jobsPending && (jobs.loadingMore || jobs.status === 'loading')) return jobsPending;
    const captured = scope;
    if (!captured || selectedPipelineId === null) return;
    const selected = pipelines.rows.find((pipeline) => pipeline.id === selectedPipelineId);
    if (!selected || !selected.projectId || !Number.isSafeInteger(selected.projectId)) return;
    jobsPending = load('jobs', jobs.committedPage ? 'append' : 'first', (page) => options.listPipelineJobs(selected.projectId!, selected.id, page), (row) => row.id);
    return jobsPending;
  }

  // Refresh only jobs for the selected pipeline, discarding stale job rows first.
  async function refreshJobs(): Promise<void> {
    if (selectedPipelineId === null) return;
    jobsGeneration += 1;
    jobs = emptyCollection<GitLabJob>();
    const selected = pipelines.rows.find((pipeline) => pipeline.id === selectedPipelineId);
    if (selected && (!Number.isSafeInteger(selected.projectId) || (selected.projectId ?? 0) <= 0)) {
      jobs.status = 'unavailable';
      jobs.error = 'Pipeline owner is unknown; jobs cannot be loaded safely.';
      jobsPending = null;
      notify();
      return;
    }
    notify();
    await loadMoreJobs();
  }

  // Clear every section as soon as the verified detail identity changes.
  function setScope(next: MergeRequestActivityScope | null): void {
    if (destroyed) return;
    if (next && !validScope(next)) next = null;
    if (sameScope(scope, next)) return;
    pipelinesGeneration += 1;
    discussionsGeneration += 1;
    jobsGeneration += 1;
    scope = next ? Object.freeze({ ...next }) : null;
    pipelines = emptyCollection();
    discussions = emptyCollection();
    jobs = emptyCollection();
    selectedPipelineId = null;
    pipelinePending = null;
    discussionPending = null;
    jobsPending = null;
    notify();
  }

  // Stop pending requests and prevent all later state publications.
  function destroy(): void {
    destroyed = true;
    pipelinesGeneration += 1;
    discussionsGeneration += 1;
    jobsGeneration += 1;
    scope = null;
    pipelinePending = null;
    discussionPending = null;
    jobsPending = null;
  }

  return { setScope, snapshot, loadPipelines, loadMorePipelines, refreshPipelines, loadDiscussions, loadMoreDiscussions, refreshDiscussions, selectPipeline, loadMoreJobs, refreshJobs, destroy };
}
