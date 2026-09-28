import { HostRequestError, type HostClient, type GuestRequest } from '@openchamber/sdk';

export type GitLabHost = Pick<HostClient, 'request'>;
export const GITLAB_VARIANT_ID = 'gitlab-self-managed';

export type GitLabProject = {
  id: number;
  path: string;
};

export type GitLabIssue = {
  id: number;
  iid: number;
  projectId: number;
  title: string;
  description: string;
  state: 'opened' | 'closed';
  webUrl: string;
  updatedAt: string;
};

export type GitLabMergeRequest = {
  id: number;
  iid: number;
  projectId: number;
  targetProjectId: number;
  sourceProjectId: number | null;
  title: string;
  description: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  webUrl: string;
  updatedAt: string;
  sourceBranch: string | null;
  targetBranch: string | null;
};

export type GitLabPipeline = {
  id: number;
  projectId: number | null;
  status: string | null;
  ref: string | null;
  sha: string | null;
  source: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  webUrl: string | null;
};

export type GitLabJob = {
  id: number;
  name: string;
  status: string;
  stage: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  webUrl: string | null;
};

export type GitLabDiscussionAuthor = {
  id: number | null;
  username: string | null;
  name: string | null;
};

export type GitLabDiscussionNote = {
  id: number;
  body: string;
  author: GitLabDiscussionAuthor | null;
  createdAt: string | null;
  updatedAt: string | null;
  system: boolean | null;
  resolvable: boolean | null;
  resolved: boolean | null;
  resolvedBy: GitLabDiscussionAuthor | null;
  resolvedAt: string | null;
};

export type GitLabDiscussion = {
  id: string;
  notes: GitLabDiscussionNote[];
};

export type GitLabUser = {
  id: number;
  username: string;
  variant: typeof GITLAB_VARIANT_ID;
};

export type GitLabErrorCode =
  | 'redirect'
  | 'disconnected'
  | 'forbidden'
  | 'not-found'
  | 'invalid-origin'
  | 'not-granted'
  | 'rate-limited'
  | 'invalid-response'
  | 'transport'
  | 'server';

export class GitLabApiError extends Error {
  constructor(
    readonly code: GitLabErrorCode,
    readonly resource: 'account' | 'projects' | 'issues' | 'merge-requests' | 'pipelines' | 'jobs' | 'discussions',
  ) {
    super(code);
    this.name = 'GitLabApiError';
  }
}

type JsonRecord = Record<string, unknown>;
const packageOriginRecovery = 'To change the instance origin: Remove the extension, configure the package, reinstall it, reconnect in Settings → Integrations, then reselect the project.';

// Keep response parsing strict so malformed provider data never becomes an association.
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Accept only positive safe integers as GitLab's stable numeric project and account IDs.
function isStableId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// Parse issue fields only when they provide a stable identity and safe display values.
function parseGitLabIssue(value: unknown, projectId: number): GitLabIssue {
  // Require every association field before accepting provider data.
  if (
    !isRecord(value)
    || !isStableId(value.id)
    || !isStableId(value.iid)
    || value.project_id !== projectId
    || typeof value.title !== 'string'
    || !value.title.trim()
    || (value.state !== 'opened' && value.state !== 'closed')
    || typeof value.updated_at !== 'string'
    || !value.updated_at.trim()
    || (value.description !== null && typeof value.description !== 'string')
    || typeof value.web_url !== 'string'
  ) {
    throw new GitLabApiError('invalid-response', 'issues');
  }

  let webUrl: URL;
  // Accept only absolute HTTPS links without embedded credentials.
  try {
    webUrl = new URL(value.web_url);
  } catch {
    throw new GitLabApiError('invalid-response', 'issues');
  }
  if (webUrl.protocol !== 'https:' || webUrl.username || webUrl.password) {
    throw new GitLabApiError('invalid-response', 'issues');
  }

  return {
    id: value.id,
    iid: value.iid,
    projectId,
    title: value.title.trim(),
    description: value.description ?? '',
    state: value.state,
    webUrl: webUrl.toString(),
    updatedAt: value.updated_at.trim(),
  };
}

// Parse merge request identity and display fields without rejecting fork sources.
function parseGitLabMergeRequest(value: unknown, expectedTargetProjectId: number, requireTargetProjectId = false): GitLabMergeRequest {
  if (
    !isRecord(value)
    || !isStableId(value.id)
    || !isStableId(value.iid)
    || value.project_id !== expectedTargetProjectId
    || (requireTargetProjectId && value.target_project_id !== expectedTargetProjectId)
    || (value.target_project_id !== undefined && value.target_project_id !== expectedTargetProjectId)
    || (value.source_project_id !== undefined && value.source_project_id !== null && !isStableId(value.source_project_id))
    || typeof value.title !== 'string'
    || !value.title.trim()
    || (value.state !== 'opened' && value.state !== 'closed' && value.state !== 'merged' && value.state !== 'locked')
    || typeof value.updated_at !== 'string'
    || !value.updated_at.trim()
    || (value.description !== null && typeof value.description !== 'string')
    || typeof value.web_url !== 'string'
    || (value.source_branch !== undefined && value.source_branch !== null && (typeof value.source_branch !== 'string' || !value.source_branch.trim()))
    || (value.target_branch !== undefined && value.target_branch !== null && (typeof value.target_branch !== 'string' || !value.target_branch.trim()))
  ) {
    throw new GitLabApiError('invalid-response', 'merge-requests');
  }

  let webUrl: URL;
  // Accept only absolute HTTPS links without embedded credentials.
  try {
    webUrl = new URL(value.web_url);
  } catch {
    throw new GitLabApiError('invalid-response', 'merge-requests');
  }
  if (webUrl.protocol !== 'https:' || webUrl.username || webUrl.password) {
    throw new GitLabApiError('invalid-response', 'merge-requests');
  }

  return {
    id: value.id,
    iid: value.iid,
    projectId: expectedTargetProjectId,
    targetProjectId: expectedTargetProjectId,
    sourceProjectId: value.source_project_id ?? null,
    title: value.title.trim(),
    description: value.description ?? '',
    state: value.state,
    webUrl: webUrl.toString(),
    updatedAt: value.updated_at.trim(),
    sourceBranch: typeof value.source_branch === 'string' ? value.source_branch.trim() : null,
    targetBranch: typeof value.target_branch === 'string' ? value.target_branch.trim() : null,
  };
}

// Normalize optional display text while rejecting provider fields with unexpected types.
function optionalDisplayText(value: unknown, resource: 'pipelines' | 'jobs' | 'discussions'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new GitLabApiError('invalid-response', resource);
  return value.trim() || null;
}

// Accept optional links only when they are absolute HTTPS URLs without credentials.
function optionalHttpsUrl(value: unknown, resource: 'pipelines' | 'jobs' | 'discussions'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new GitLabApiError('invalid-response', resource);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GitLabApiError('invalid-response', resource);
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new GitLabApiError('invalid-response', resource);
  return url.toString();
}

// Parse pipeline identity and use only GitLab's project_id as the job-owner identity.
function parseGitLabPipeline(value: unknown): GitLabPipeline {
  if (!isRecord(value) || !isStableId(value.id)
    || (value.project_id !== undefined && value.project_id !== null && !isStableId(value.project_id))) {
    throw new GitLabApiError('invalid-response', 'pipelines');
  }

  return {
    id: value.id,
    projectId: value.project_id ?? null,
    status: optionalDisplayText(value.status, 'pipelines'),
    ref: optionalDisplayText(value.ref, 'pipelines'),
    sha: optionalDisplayText(value.sha, 'pipelines'),
    source: optionalDisplayText(value.source, 'pipelines'),
    createdAt: optionalDisplayText(value.created_at, 'pipelines'),
    updatedAt: optionalDisplayText(value.updated_at, 'pipelines'),
    startedAt: optionalDisplayText(value.started_at, 'pipelines'),
    finishedAt: optionalDisplayText(value.finished_at, 'pipelines'),
    webUrl: optionalHttpsUrl(value.web_url, 'pipelines'),
  };
}

// Parse the safe fields needed to show one pipeline job without trusting its provider link.
function parseGitLabJob(value: unknown): GitLabJob {
  if (!isRecord(value) || !isStableId(value.id)
    || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.status !== 'string' || !value.status.trim()) {
    throw new GitLabApiError('invalid-response', 'jobs');
  }

  return {
    id: value.id,
    name: value.name.trim(),
    status: value.status.trim(),
    stage: optionalDisplayText(value.stage, 'jobs'),
    createdAt: optionalDisplayText(value.created_at, 'jobs'),
    startedAt: optionalDisplayText(value.started_at, 'jobs'),
    finishedAt: optionalDisplayText(value.finished_at, 'jobs'),
    webUrl: optionalHttpsUrl(value.web_url, 'jobs'),
  };
}

// Keep optional author identity and display fields typed even for deleted users.
function parseDiscussionAuthor(value: unknown, resource: 'discussions'): GitLabDiscussionAuthor | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)
    || (value.id !== undefined && value.id !== null && !isStableId(value.id))) {
    throw new GitLabApiError('invalid-response', resource);
  }

  return {
    id: value.id ?? null,
    username: optionalDisplayText(value.username, resource),
    name: optionalDisplayText(value.name, resource),
  };
}

// Preserve note bodies verbatim as plain text and validate all optional thread metadata.
function parseDiscussionNote(value: unknown): GitLabDiscussionNote {
  if (!isRecord(value) || !isStableId(value.id) || typeof value.body !== 'string') {
    throw new GitLabApiError('invalid-response', 'discussions');
  }
  // Accept optional status flags only when the provider sends booleans or null.
  for (const key of ['system', 'resolvable', 'resolved'] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'boolean') {
      throw new GitLabApiError('invalid-response', 'discussions');
    }
  }

  return {
    id: value.id,
    body: value.body,
    author: parseDiscussionAuthor(value.author, 'discussions'),
    createdAt: optionalDisplayText(value.created_at, 'discussions'),
    updatedAt: optionalDisplayText(value.updated_at, 'discussions'),
    system: typeof value.system === 'boolean' ? value.system : null,
    resolvable: typeof value.resolvable === 'boolean' ? value.resolvable : null,
    resolved: typeof value.resolved === 'boolean' ? value.resolved : null,
    resolvedBy: parseDiscussionAuthor(value.resolved_by, 'discussions'),
    resolvedAt: optionalDisplayText(value.resolved_at, 'discussions'),
  };
}

// Require a non-empty discussion identity and a notes array before parsing the full thread.
function parseGitLabDiscussion(value: unknown): GitLabDiscussion {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim() || !Array.isArray(value.notes)) {
    throw new GitLabApiError('invalid-response', 'discussions');
  }

  return { id: value.id.trim(), notes: value.notes.map(parseDiscussionNote) };
}

// Normalize the full project path and stable numeric ID for both search and direct lookup.
function parseGitLabProject(value: unknown): GitLabProject {
  if (!isRecord(value) || !isStableId(value.id) || typeof value.path_with_namespace !== 'string' || !value.path_with_namespace.trim()) {
    throw new GitLabApiError('invalid-response', 'projects');
  }

  return { id: value.id, path: value.path_with_namespace.trim() };
}

// Convert host failures into safe categories without exposing request or response details.
function classifyHostFailure(error: unknown): GitLabErrorCode {
  if (error instanceof HostRequestError) {
    if (error.code === 'DISCONNECTED' || error.code === 'NO_INTEGRATION') return 'disconnected';
    if (error.code === 'BAD_PATH') return 'invalid-origin';
    if (error.code === 'NOT_GRANTED') return 'not-granted';
  }

  return 'transport';
}

// Use only the host's authenticated request bridge; it enforces the configured origin and redirect policy.
async function requestJson(host: GitLabHost, request: GuestRequest, resource: GitLabApiError['resource']): Promise<unknown> {
  let response: Awaited<ReturnType<GitLabHost['request']>>;

  try {
    response = await host.request(request);
  } catch (error) {
    throw new GitLabApiError(classifyHostFailure(error), resource);
  }

  // Treat every redirect as a configuration error because the host intentionally does not follow it.
  if (response.status >= 300 && response.status < 400) throw new GitLabApiError('redirect', resource);
  if (response.status === 401) throw new GitLabApiError('disconnected', resource);
  if (response.status === 403) throw new GitLabApiError('forbidden', resource);
  if (response.status === 404) throw new GitLabApiError('not-found', resource);
  if (response.status === 429) throw new GitLabApiError('rate-limited', resource);
  if (response.status < 200 || response.status >= 300) throw new GitLabApiError('server', resource);

  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw new GitLabApiError('invalid-response', resource);
  }
}

// Verify the account ID while keeping instance scope fixed to this extension's panel identity.
export async function getCurrentUser(host: GitLabHost): Promise<GitLabUser> {
  const value = await requestJson(host, { method: 'GET', path: '/api/v4/user' }, 'account');
  if (!isRecord(value) || !isStableId(value.id) || typeof value.username !== 'string' || !value.username.trim()) {
    throw new GitLabApiError('invalid-response', 'account');
  }

  return { id: value.id, username: value.username.trim(), variant: GITLAB_VARIANT_ID };
}

// Search only non-empty queries and preserve GitLab's full namespace in every result.
export async function searchVisibleProjects(host: GitLabHost, query: string): Promise<GitLabProject[]> {
  const search = query.trim();
  if (!search) return [];

  const value = await requestJson(host, {
    method: 'GET',
    path: '/api/v4/projects',
    query: { search, per_page: '100', page: '1', order_by: 'name', sort: 'asc' },
  }, 'projects');

  if (!Array.isArray(value)) throw new GitLabApiError('invalid-response', 'projects');

  // Parse every result before exposing it and reject duplicate numeric IDs.
  const projects: GitLabProject[] = [];
  const ids = new Set<number>();
  for (const row of value) {
    const project = parseGitLabProject(row);
    if (ids.has(project.id)) throw new GitLabApiError('invalid-response', 'projects');
    ids.add(project.id);
    projects.push(project);
  }

  return projects;
}

// Fetch the selected project again so stale search results cannot be persisted.
export async function getProjectById(host: GitLabHost, projectId: number): Promise<GitLabProject> {
  if (!isStableId(projectId)) throw new GitLabApiError('invalid-response', 'projects');

  const value = await requestJson(host, { method: 'GET', path: `/api/v4/projects/${projectId}` }, 'projects');
  const project = parseGitLabProject(value);
  if (project.id !== projectId) {
    throw new GitLabApiError('invalid-response', 'projects');
  }

  return project;
}

// Fetch a bounded page of open project issues through the authenticated host bridge.
export async function listProjectIssues(host: GitLabHost, projectId: number, page = 1, search = ''): Promise<GitLabIssue[]> {
  // Refuse unsafe or unbounded caller input before making a network request.
  if (!isStableId(projectId) || !Number.isSafeInteger(page) || page < 1 || page > 1000) {
    throw new GitLabApiError('invalid-response', 'issues');
  }

  // Keep issue results current and cap each response to one small page.
  const query: Record<string, string> = {
    state: 'opened',
    per_page: '20',
    page: String(page),
    order_by: 'updated_at',
    sort: 'desc',
  };
  const normalizedSearch = search.trim();
  if (normalizedSearch) query.search = normalizedSearch;

  const value = await requestJson(host, {
    method: 'GET',
    path: `/api/v4/projects/${projectId}/issues`,
    query,
  }, 'issues');
  if (!Array.isArray(value)) throw new GitLabApiError('invalid-response', 'issues');

  // Reject repeated provider identities before exposing the issue page.
  const issues: GitLabIssue[] = [];
  const ids = new Set<number>();
  const iids = new Set<number>();
  for (const row of value) {
    const issue = parseGitLabIssue(row, projectId);
    if (ids.has(issue.id) || iids.has(issue.iid)) throw new GitLabApiError('invalid-response', 'issues');
    ids.add(issue.id);
    iids.add(issue.iid);
    issues.push(issue);
  }

  return issues;
}

// Refresh one project issue and verify both its project and local identity.
export async function getProjectIssue(host: GitLabHost, projectId: number, iid: number): Promise<GitLabIssue> {
  // Validate both path IDs before using them in the API route.
  if (!isStableId(projectId) || !isStableId(iid)) throw new GitLabApiError('invalid-response', 'issues');

  // Load the requested issue through the authenticated host request bridge.
  const value = await requestJson(host, {
    method: 'GET',
    path: `/api/v4/projects/${projectId}/issues/${iid}`,
  }, 'issues');
  const issue = parseGitLabIssue(value, projectId);
  if (issue.iid !== iid) throw new GitLabApiError('invalid-response', 'issues');

  return issue;
}

// Fetch a bounded, current page of merge requests for the selected target project.
export async function listProjectMergeRequests(host: GitLabHost, projectId: number, page = 1, search = ''): Promise<GitLabMergeRequest[]> {
  // Refuse unsafe or unbounded caller input before making a network request.
  if (!isStableId(projectId) || !Number.isSafeInteger(page) || page < 1 || page > 1000) {
    throw new GitLabApiError('invalid-response', 'merge-requests');
  }

  // Keep results current and cap each response to one small page.
  const query: Record<string, string> = {
    state: 'opened',
    order_by: 'updated_at',
    sort: 'desc',
    per_page: '20',
    page: String(page),
  };
  const normalizedSearch = search.trim();
  if (normalizedSearch) query.search = normalizedSearch;

  const value = await requestJson(host, {
    method: 'GET',
    path: `/api/v4/projects/${projectId}/merge_requests`,
    query,
  }, 'merge-requests');
  if (!Array.isArray(value)) throw new GitLabApiError('invalid-response', 'merge-requests');

  // Parse all rows and reject duplicate stable identities within this response page.
  const mergeRequests: GitLabMergeRequest[] = [];
  const ids = new Set<number>();
  const iids = new Set<number>();
  for (const row of value) {
    const mergeRequest = parseGitLabMergeRequest(row, projectId);
    if (ids.has(mergeRequest.id) || iids.has(mergeRequest.iid)) throw new GitLabApiError('invalid-response', 'merge-requests');
    ids.add(mergeRequest.id);
    iids.add(mergeRequest.iid);
    mergeRequests.push(mergeRequest);
  }

  return mergeRequests;
}

// Refresh one merge request and verify its project-local IID.
export async function getProjectMergeRequest(host: GitLabHost, projectId: number, iid: number): Promise<GitLabMergeRequest> {
  // Validate both path IDs before using them in the API route.
  if (!isStableId(projectId) || !isStableId(iid)) throw new GitLabApiError('invalid-response', 'merge-requests');

  // Load the requested merge request through the authenticated host bridge.
  const value = await requestJson(host, {
    method: 'GET',
    path: `/api/v4/projects/${projectId}/merge_requests/${iid}`,
  }, 'merge-requests');
  const mergeRequest = parseGitLabMergeRequest(value, projectId);
  if (mergeRequest.iid !== iid) throw new GitLabApiError('invalid-response', 'merge-requests');

  return mergeRequest;
}

// Fetch one bounded page of issue-related merge requests without implying that it is exhaustive.
export async function listRelatedMergeRequestsPage(
  host: GitLabHost,
  issueProjectId: number,
  issueIid: number,
  page: number,
): Promise<GitLabMergeRequest[]> {
  // Validate every path and paging value before issuing the related-resource request.
  if (!isStableId(issueProjectId) || !isStableId(issueIid) || !Number.isSafeInteger(page) || page < 1 || page > 10) {
    throw new GitLabApiError('invalid-response', 'merge-requests');
  }

  // Keep the provider page size fixed and avoid undocumented filters that can hide valid states.
  const value = await requestJson(host, {
    method: 'GET',
    path: `/api/v4/projects/${issueProjectId}/issues/${issueIid}/related_merge_requests`,
    query: { page: String(page), per_page: '50' },
  }, 'merge-requests');
  if (!Array.isArray(value) || value.length > 50) throw new GitLabApiError('invalid-response', 'merge-requests');

  // Parse the full page and reject duplicate identities rather than returning a partial association.
  const mergeRequests: GitLabMergeRequest[] = [];
  const ids = new Set<number>();
  const identities = new Set<string>();
  for (const row of value) {
    if (!isRecord(row) || !isStableId(row.project_id)) {
      throw new GitLabApiError('invalid-response', 'merge-requests');
    }
    const mergeRequest = parseGitLabMergeRequest(row, row.project_id, true);
    const identity = `${mergeRequest.projectId}:${mergeRequest.iid}`;
    if (ids.has(mergeRequest.id) || identities.has(identity)) {
      throw new GitLabApiError('invalid-response', 'merge-requests');
    }
    ids.add(mergeRequest.id);
    identities.add(identity);
    mergeRequests.push(mergeRequest);
  }

  return mergeRequests;
}

// Validate pagination consistently and reject oversized provider pages as a whole.
function requireBoundedPage(value: unknown, resource: 'pipelines' | 'jobs' | 'discussions'): unknown[] {
  if (!Array.isArray(value) || value.length > 20) throw new GitLabApiError('invalid-response', resource);
  return value;
}

// Fetch a bounded page of pipelines for one merge request in its target project.
export async function listMergeRequestPipelines(
  host: GitLabHost,
  targetProjectId: number,
  mrIid: number,
  page = 1,
): Promise<GitLabPipeline[]> {
  // Reject unsafe path IDs and pages before constructing a host request.
  if (!isStableId(targetProjectId) || !isStableId(mrIid) || !Number.isSafeInteger(page) || page < 1 || page > 1000) {
    throw new GitLabApiError('invalid-response', 'pipelines');
  }

  const value = await requestJson(host, {
    method: 'GET',
    path: `/api/v4/projects/${targetProjectId}/merge_requests/${mrIid}/pipelines`,
    query: { page: String(page), per_page: '20' },
  }, 'pipelines');
  const rows = requireBoundedPage(value, 'pipelines');
  const pipelines: GitLabPipeline[] = [];
  const ids = new Set<number>();
  // Parse the full page and reject duplicate pipeline identities before returning data.
  for (const row of rows) {
    const parsed = parseGitLabPipeline(row);
    if (ids.has(parsed.id)) throw new GitLabApiError('invalid-response', 'pipelines');
    ids.add(parsed.id);
    pipelines.push(parsed);
  }

  return pipelines;
}

// Load jobs only from the exact pipeline-owner project ID returned by GitLab.
export async function listPipelineJobs(
  host: GitLabHost,
  pipelineProjectId: number,
  pipelineId: number,
  page = 1,
): Promise<GitLabJob[]> {
  // Refuse inferred, malformed, or unbounded identities before contacting GitLab.
  if (!isStableId(pipelineProjectId) || !isStableId(pipelineId) || !Number.isSafeInteger(page) || page < 1 || page > 1000) {
    throw new GitLabApiError('invalid-response', 'jobs');
  }

  const value = await requestJson(host, {
    method: 'GET',
    path: `/api/v4/projects/${pipelineProjectId}/pipelines/${pipelineId}/jobs`,
    query: { page: String(page), per_page: '20' },
  }, 'jobs');
  const rows = requireBoundedPage(value, 'jobs');
  const jobs: GitLabJob[] = [];
  const ids = new Set<number>();
  // Keep malformed or duplicate job rows from creating a partial result.
  for (const row of rows) {
    const parsed = parseGitLabJob(row);
    if (ids.has(parsed.id)) throw new GitLabApiError('invalid-response', 'jobs');
    ids.add(parsed.id);
    jobs.push(parsed);
  }

  return jobs;
}

// Fetch discussion threads for one merge request without using provider-supplied paths.
export async function listMergeRequestDiscussions(
  host: GitLabHost,
  targetProjectId: number,
  mrIid: number,
  page = 1,
): Promise<GitLabDiscussion[]> {
  // Validate all path components and paging bounds before creating the request.
  if (!isStableId(targetProjectId) || !isStableId(mrIid) || !Number.isSafeInteger(page) || page < 1 || page > 1000) {
    throw new GitLabApiError('invalid-response', 'discussions');
  }

  const value = await requestJson(host, {
    method: 'GET',
    path: `/api/v4/projects/${targetProjectId}/merge_requests/${mrIid}/discussions`,
    query: { page: String(page), per_page: '20' },
  }, 'discussions');
  const rows = requireBoundedPage(value, 'discussions');
  const discussions: GitLabDiscussion[] = [];
  const discussionIds = new Set<string>();
  const noteIds = new Set<number>();
  // Require unique thread and note identities across the complete page.
  for (const row of rows) {
    const parsed = parseGitLabDiscussion(row);
    if (discussionIds.has(parsed.id)) throw new GitLabApiError('invalid-response', 'discussions');
    discussionIds.add(parsed.id);
    // Note IDs are globally unique within a project, even across discussion threads.
    for (const note of parsed.notes) {
      if (noteIds.has(note.id)) throw new GitLabApiError('invalid-response', 'discussions');
      noteIds.add(note.id);
    }
    discussions.push(parsed);
  }

  return discussions;
}

// Map provider and host failures to safe messages that tell the user where to recover.
export function gitLabErrorMessage(error: unknown): string {
  const apiError = error instanceof GitLabApiError ? error : new GitLabApiError('transport', 'projects');

  switch (apiError.code) {
    case 'redirect':
      return `GitLab redirected the API request, and redirects are not followed. ${packageOriginRecovery}`;
    case 'disconnected':
      return `GitLab is disconnected or rejected the token. Reconnect with a valid token in Settings → Integrations. ${packageOriginRecovery}`;
    case 'forbidden':
      return 'GitLab denied this request. Check the token permissions and your access to the project in Settings → Integrations.';
    case 'not-found':
      return apiError.resource === 'account'
        ? `GitLab could not find the current-user API. Verify the package's HTTPS origin. ${packageOriginRecovery}`
        : apiError.resource === 'issues'
          ? `GitLab could not find these project issues. The project or issue may have been removed or is no longer visible to this account. Refresh the project and try again. ${packageOriginRecovery}`
          : apiError.resource === 'merge-requests'
            ? `GitLab could not find these project merge requests. The project or merge request may have been removed or is no longer visible to this account. Refresh the project and try again. ${packageOriginRecovery}`
            : apiError.resource === 'pipelines'
              ? `GitLab could not provide these merge-request pipelines. They may be unavailable or inaccessible to this account. Try again later or check project access. ${packageOriginRecovery}`
              : apiError.resource === 'jobs'
                ? `GitLab could not provide these pipeline jobs. They may be unavailable or inaccessible to this account. Try again later or check project access. ${packageOriginRecovery}`
                : apiError.resource === 'discussions'
                  ? `GitLab could not provide these merge-request discussions. They may be unavailable or inaccessible to this account. Try again later or check project access. ${packageOriginRecovery}`
          : `GitLab could not find this project. It may have been removed or is no longer visible to this account. Search again to select an accessible project. ${packageOriginRecovery}`;
    case 'invalid-origin':
      return `The configured GitLab API origin is invalid. ${packageOriginRecovery}`;
    case 'not-granted':
      return 'Approve the GitLab integration capability in Settings → Extensions before using this panel.';
    case 'invalid-response':
      return `GitLab returned an unexpected response. Verify the package's HTTPS origin and try again. ${packageOriginRecovery}`;
    case 'server':
      return `GitLab could not complete the request. Check the network and try again. ${packageOriginRecovery}`;
    case 'rate-limited':
      return `GitLab is rate-limiting requests. Wait briefly and try again. ${packageOriginRecovery}`;
    case 'transport':
      return `Could not reach GitLab. Check the network and trusted TLS certificate. ${packageOriginRecovery}`;
  }
}
