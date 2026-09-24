import { HostRequestError, type HostClient, type GuestRequest } from '@openchamber/sdk';

export type GitLabHost = Pick<HostClient, 'request'>;
export const GITLAB_VARIANT_ID = 'gitlab-self-managed';

export type GitLabProject = {
  id: number;
  path: string;
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
  | 'invalid-response'
  | 'transport'
  | 'server';

export class GitLabApiError extends Error {
  constructor(
    readonly code: GitLabErrorCode,
    readonly resource: 'account' | 'projects',
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
        : `GitLab could not find this project. It may have been removed or is no longer visible to this account. Search again to select an accessible project. ${packageOriginRecovery}`;
    case 'invalid-origin':
      return `The configured GitLab API origin is invalid. ${packageOriginRecovery}`;
    case 'not-granted':
      return 'Approve the GitLab integration capability in Settings → Extensions before using this panel.';
    case 'invalid-response':
      return `GitLab returned an unexpected response. Verify the package's HTTPS origin and try again. ${packageOriginRecovery}`;
    case 'server':
      return `GitLab could not complete the request. Check the network and try again. ${packageOriginRecovery}`;
    case 'transport':
      return `Could not reach GitLab. Check the network and trusted TLS certificate. ${packageOriginRecovery}`;
  }
}
