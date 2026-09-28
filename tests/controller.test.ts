import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { GuestConnection, GuestProjectsSnapshot, GuestRequest, GuestRequestResult, GuestSessionsSnapshot, GuestWorktreesSnapshot, HostClient, HostReadyContext, JsonValue, SessionSnapshot, StartSessionRequest, StartSessionResult } from '@openchamber/sdk';
import { HostRequestError } from '@openchamber/sdk';
import { Window } from 'happy-dom';
import { mountGitLabPanel, type GitLabPanelHost } from '../src/controller.js';
import { writeAssociation } from '../src/association.js';
import { RECOVERY_KEY, type RecoveryRecord } from '../src/worktree-recovery.js';
import { GITLAB_VARIANT_ID } from '../src/gitlab.js';

const projects: GuestProjectsSnapshot = {
  kind: 'projects',
  state: 'ready',
  projects: [{ id: 'workspace-1', name: 'OpenChamber', directory: '/repos/openchamber' }],
};

const worktrees: GuestWorktreesSnapshot = {
  kind: 'worktrees',
  projectId: 'workspace-1',
  state: 'ready',
  worktrees: [{ directory: '/repos/openchamber/.worktrees/fix', name: 'fix', branch: 'fix', status: 'ready' }],
};

const gitLabIssue = {
  id: 901,
  iid: 17,
  projectId: 812,
  title: 'Fix deployment flow',
  description: 'Issue details',
  state: 'opened' as const,
  webUrl: 'https://gitlab.example.com/platform/infra/deploy/-/issues/17',
  updatedAt: '2026-09-20T12:30:00.000Z',
};

function response(status: number, value: unknown): GuestRequestResult {
  return { status, body: JSON.stringify(value) };
}

function issueResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 901,
    iid: 17,
    project_id: 812,
    title: 'Fix deployment flow',
    description: 'Issue details',
    state: 'opened',
    issue_type: 'issue',
    web_url: gitLabIssue.webUrl,
    updated_at: gitLabIssue.updatedAt,
    ...overrides,
  };
}

// Keep fork merge requests tied to the target project while preserving their distinct source project.
function mergeRequestResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 1901,
    iid: 39,
    project_id: 812,
    target_project_id: 812,
    source_project_id: 913,
    title: 'Ship forked deployment fix',
    description: 'Merge request details',
    state: 'opened',
    web_url: 'https://gitlab.example.com/platform/infra/deploy/-/merge_requests/39',
    updated_at: '2026-09-21T12:30:00.000Z',
    ...overrides,
  };
}

// Model only the host contract used by the mounted panel, with controllable API responses.
class MockHost implements GitLabPanelHost {
  readonly requests: GuestRequest[] = [];
  readonly completedRequests: GuestRequest[] = [];
  readonly storedValues = new Map<string, JsonValue>();
  readonly readyListeners: Array<(context: HostReadyContext) => void> = [];
  readonly directoryListeners: Array<(directory: string | null) => void> = [];
  readonly connectionListeners: Array<(connection: GuestConnection) => void> = [];
  readonly sessionListeners: Array<(session: SessionSnapshot | null) => void> = [];
  readonly sessionsListeners: Array<(snapshot: GuestSessionsSnapshot) => void> = [];
  readonly startedSessions: StartSessionRequest[] = [];
  readonly openedSessions: string[] = [];
  readonly events: string[] = [];
  readonly requestHandler: (request: GuestRequest) => Promise<GuestRequestResult>;
  sessionsReads = 0;
  storedWrites = 0;
  storageDeletes = 0;
  storageReadError: Error | null = null;
  storageWriteError: Error | null = null;
  storageDeleteError: Error | null = null;
  storageDeleteBarrier: Promise<void> | null = null;
  startSessionError: Error | null = null;
  openSessionError: Error | null = null;
  directory = '/repos/openchamber';
  connection: GuestConnection = { connected: true, account: 'maya' };
  projectsSnapshot = projects;
  worktreesSnapshot = worktrees;
  sessionsSnapshot: GuestSessionsSnapshot = {
    kind: 'sessions',
    projectId: 'workspace-1',
    state: 'ready',
    coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
    sessions: [],
  };
  startSessionResult: StartSessionResult = { sessionId: 'created-session', directory: '/repos/openchamber/.worktrees/created-issue', sent: 'skipped', linked: true };

  readonly storage: HostClient['storage'] = {
    // Read and write scoped values through the same in-memory namespace.
    get: async (key) => {
      if (key === RECOVERY_KEY && this.storageReadError) throw this.storageReadError;
      return this.storedValues.get(key);
    },
    set: async (key, value) => {
      this.events.push(`set:${key}`);
      this.storedWrites += 1;
      if (this.storageWriteError) throw this.storageWriteError;
      this.storedValues.set(key, value);
    },

    // Track removals so tests can prove which actions reached persistent storage.
    delete: async (key) => {
      this.events.push(`delete:${key}`);
      this.storageDeletes += 1;
      if (this.storageDeleteError) throw this.storageDeleteError;
      if (this.storageDeleteBarrier) await this.storageDeleteBarrier;
      this.storedValues.delete(key);
    },
    keys: async () => [...this.storedValues.keys()].sort(),
  };

  // Supply safe account and project fixtures unless a test provides a custom bridge response.
  constructor(requestHandler?: (request: GuestRequest) => Promise<GuestRequestResult>) {
    this.requestHandler = requestHandler ?? (async (request) => {
      // Return the current account for host-backed authentication checks.
      if (request.path === '/api/v4/user') {
        return response(200, { id: 73, username: 'maya', web_url: 'https://gitlab.example.com/users/maya' });
      }

      // Provide one visible namespace result for mounted search tests.
      if (request.path === '/api/v4/projects') {
        return response(200, [{ id: 812, path_with_namespace: 'platform/infra/deploy' }]);
      }

      // Confirm the selected numeric project ID before a test save.
      if (request.path === '/api/v4/projects/812') {
        return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      }
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return response(200, issueResponse());

      return response(404, {});
    });
  }

  // Record each bridge response after its handler settles so stale-response tests can await completion.
  async request(request: GuestRequest): Promise<GuestRequestResult> {
    this.requests.push(request);
    try {
      const result = await this.requestHandler(request);
      this.completedRequests.push(request);
      return result;
    } catch (error) {
      this.completedRequests.push(request);
      throw error;
    }
  }

  // Return the current registered local repositories snapshot.
  async listProjects(): Promise<GuestProjectsSnapshot> {
    return this.projectsSnapshot;
  }

  // Return ready worktree records for the requested registered repository.
  async listWorktrees(projectId: string): Promise<GuestWorktreesSnapshot> {
    return { ...this.worktreesSnapshot, projectId };
  }

  // Return the project's known session records with explicit coverage.
  async listSessions(projectId: string): Promise<GuestSessionsSnapshot> {
    this.sessionsReads += 1;
    return { ...this.sessionsSnapshot, projectId };
  }

  // Register an issue-workflow observer and immediately provide its current snapshot.
  async onSessions(projectId: string, listener: (snapshot: GuestSessionsSnapshot) => void): Promise<() => void> {
    this.sessionsListeners.push(listener);
    listener({ ...this.sessionsSnapshot, projectId });
    return () => this.removeListener(this.sessionsListeners, listener);
  }

  // Capture the exact worktree request passed to the host bridge.
  async startSession(request: StartSessionRequest): Promise<StartSessionResult> {
    this.events.push('startSession');
    this.startedSessions.push(request);
    if (this.startSessionError) throw this.startSessionError;
    return this.startSessionResult;
  }

  // Record explicit navigation requests and allow recovery tests to simulate host refusal.
  async openSession(sessionId: string): Promise<void> {
    this.events.push('openSession');
    this.openedSessions.push(sessionId);
    if (this.openSessionError) throw this.openSessionError;
  }

  // Keep lifecycle listeners removable so destroy tests match the SDK host contract.
  onReady(listener: (context: HostReadyContext) => void): () => void {
    this.readyListeners.push(listener);
    return () => this.removeListener(this.readyListeners, listener);
  }

  // Register current-directory change callbacks for lifecycle tests.
  onDirectory(listener: (directory: string | null) => void): () => void {
    this.directoryListeners.push(listener);
    return () => this.removeListener(this.directoryListeners, listener);
  }

  // Register account callbacks separately so same-label reconnects can be tested.
  onConnection(listener: (connection: GuestConnection) => void): () => void {
    this.connectionListeners.push(listener);
    return () => this.removeListener(this.connectionListeners, listener);
  }

  // Deliver focused-session changes independently from item payloads.
  onSession(listener: (session: SessionSnapshot | null) => void): () => void {
    this.sessionListeners.push(listener);
    return () => this.removeListener(this.sessionListeners, listener);
  }

  // Push a ready session snapshot to every active project-scoped observer.
  pushSessions(snapshot: GuestSessionsSnapshot = this.sessionsSnapshot): void {
    this.sessionsSnapshot = snapshot;
    for (const listener of this.sessionsListeners) listener(snapshot);
  }

  // Change the focused session without providing any issue item as an independent proof.
  focusSession(session: SessionSnapshot | null): void {
    for (const listener of this.sessionListeners) listener(session);
  }

  // Deliver a host-ready snapshot to all mounted controller listeners.
  ready(directory: string | null = this.directory, connection: GuestConnection = this.connection): void {
    this.directory = directory ?? '';
    this.connection = connection;
    const context = { directory, connection } as HostReadyContext;
    for (const listener of this.readyListeners) listener(context);
  }

  // Deliver the exact directory update without normalizing its path.
  changeDirectory(directory: string | null): void {
    this.directory = directory ?? '';
    for (const listener of this.directoryListeners) listener(directory);
  }

  // Dispatch even unchanged labels so tests cover account changes hidden by the host display string.
  changeConnection(connection: GuestConnection): void {
    this.connection = connection;
    for (const listener of this.connectionListeners) listener(connection);
  }

  // Remove a listener when its controller is destroyed.
  private removeListener<T>(listeners: T[], listener: T): void {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  }
}

let browser: Window;
let root: HTMLElement;
let mounted: { destroy(): void } | null;
let host: MockHost;

// Wait for the host bridge and SHA-256 storage scope work to settle before checking visible output.
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for panel state.');
}

// Drain response parsing and controller continuations after a mocked bridge response completes.
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

// Dispatch input the same way a mounted panel receives a user search.
function enterSearch(query: string): void {
  const input = root.querySelector<HTMLInputElement>('#project-search')!;
  input.value = query;
  input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
}

// Find visible actions by their accessible name instead of relying on presentation classes.
function findButton(name: RegExp): HTMLButtonElement | null {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => {
    let ancestor: HTMLElement | null = button;
    while (ancestor && root.contains(ancestor)) {
      if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true') return false;
      ancestor = ancestor.parentElement;
    }
    return name.test(`${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''}`.trim());
  }) ?? null;
}

// Restore one verified association and wait for both GitLab and workspace checks.
async function prepareAssociatedProject(): Promise<void> {
  await writeAssociation(host.storage, {
    projectId: 'workspace-1',
    accountId: 73,
    variant: GITLAB_VARIANT_ID,
  }, { id: 812, path: 'platform/infra/deploy' });
  host.ready();
  await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');
}

// Navigate to a selected browse issue after both the association and global recovery state are ready.
async function prepareIssueDetail(): Promise<void> {
  await prepareAssociatedProject();
  await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
  root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
  await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');
}

// Read the test host's persisted one-record recovery value without exposing it to production code.
function storedRecovery(): RecoveryRecord | null {
  const value = host.storedValues.get(RECOVERY_KEY);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as unknown as RecoveryRecord : null;
}

// Exercise the real panel DOM against a mocked OpenChamber host bridge.
describe('mounted GitLab panel controller', () => {
  // Mount a fresh document and host so each visible-state assertion is isolated.
  beforeEach(() => {
    browser = new Window();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document });
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: browser.Element });
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: browser.HTMLElement });
    Object.defineProperty(globalThis, 'HTMLAnchorElement', { configurable: true, value: browser.HTMLAnchorElement });
    Object.defineProperty(globalThis, 'KeyboardEvent', { configurable: true, value: browser.KeyboardEvent });
    const panelRoot = browser.document.createElement('main');
    root = panelRoot as unknown as HTMLElement;
    browser.document.body.append(panelRoot);
    host = new MockHost();
    mounted = mountGitLabPanel(host, root);
  });

  // Remove listeners and browser resources after each mounted-panel scenario.
  afterEach(() => {
    mounted?.destroy();
    mounted = null;
    browser.happyDOM.abort();
  });

  // Verify account, repository, worktree, full project path, and verified persistence in the DOM.
  it('shows verified account, registered repository, and exact worktree directory, then saves a refreshed GitLab project', async () => {
    host.ready('/repos/openchamber/.worktrees/fix');
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');

    expect(root.querySelector('#repository-value')?.textContent).toBe('OpenChamber');
    expect(root.querySelector('#directory-value')?.textContent).toBe('/repos/openchamber/.worktrees/fix');
    expect(root.querySelector('#project-search')).toBeTruthy();
    expect(root.querySelector('#project-results button')).toBeNull();

    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    expect(root.querySelector('#project-results')?.textContent).toContain('platform/infra/deploy');
    expect(root.querySelector<HTMLButtonElement>('#project-results button')?.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => host.storedWrites === 1);
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/issues'));

    expect(host.requests.map((request) => request.path)).toEqual([
      '/api/v4/user',
      '/api/v4/projects',
      '/api/v4/projects/812',
      '/api/v4/user',
      '/api/v4/projects/812/issues',
    ]);
    expect(root.querySelector('#association-value')?.textContent).toBe('platform/infra/deploy');
    expect(root.querySelector('#panel-status')?.textContent).toContain('Saved association');
    const [stored] = host.storedValues.values();
    expect(stored).toMatchObject({
      projectId: 'workspace-1',
      accountId: 73,
      variant: GITLAB_VARIANT_ID,
      project: { id: 812, path: 'platform/infra/deploy' },
    });
  });

  // Restore a saved association for a worktree only after GitLab confirms that project is still accessible.
  it('restores an accessible saved association for its registered worktree', async () => {
    await writeAssociation(host.storage, {
      projectId: 'workspace-1',
      accountId: 73,
      variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'old/path' });
    host.ready('/repos/openchamber/.worktrees/fix');
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/issues'));

    expect(root.querySelector('#repository-value')?.textContent).toBe('OpenChamber');
    expect(root.querySelector('#directory-value')?.textContent).toBe('/repos/openchamber/.worktrees/fix');
    expect(host.requests.map((request) => request.path)).toEqual([
      '/api/v4/user',
      '/api/v4/projects/812',
      '/api/v4/projects/812/issues',
    ]);
  });

  // Keep the picker collapsed for an existing association until the user asks to change it.
  it('opens and cancels project replacement from the associated project state', async () => {
    await writeAssociation(host.storage, {
      projectId: 'workspace-1',
      accountId: 73,
      variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'platform/infra/deploy' });
    host.ready();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

    const picker = root.querySelector<HTMLElement>('#project-picker')!;
    const change = root.querySelector<HTMLButtonElement>('#change-button')!;
    expect(picker.hidden).toBe(true);
    expect(change.hidden).toBe(false);
    expect(change.getAttribute('aria-expanded')).toBe('false');

    change.click();
    expect(picker.hidden).toBe(false);
    expect(change.textContent).toBe('Cancel');
    expect(change.getAttribute('aria-expanded')).toBe('true');
    expect(browser.document.activeElement?.id).toBe('project-search');

    change.click();
    expect(picker.hidden).toBe(true);
    expect(change.textContent).toBe('Change project');
    expect(change.getAttribute('aria-expanded')).toBe('false');
  });

  // Keep replacement search inside a visible Setup surface without losing the daily issue list.
  it('shows and cancels the replacement chooser without hiding the associated issue list state', async () => {
    await prepareAssociatedProject();
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));

    const setup = root.querySelector<HTMLElement>('#setup-view')!;
    const issues = root.querySelector<HTMLElement>('#issues-view')!;
    const issueList = root.querySelector<HTMLElement>('#issues-list')!;
    const change = root.querySelector<HTMLButtonElement>('#change-button')!;
    const issueRows = issueList.querySelectorAll('[data-issue-iid]').length;

    expect(setup.hidden).toBe(true);
    expect(issues.hidden).toBe(false);
    change.click();

    const search = setup.querySelector<HTMLInputElement>('#project-search');
    expect(setup.hidden).toBe(false);
    expect(search).not.toBeNull();
    expect(search?.disabled).toBe(false);
    expect(search?.getAttribute('aria-label')?.trim().length).toBeGreaterThan(0);
    expect(issues.hidden).toBe(true);
    expect(issueList.querySelectorAll('[data-issue-iid]')).toHaveLength(issueRows);

    change.click();

    expect(setup.hidden).toBe(true);
    expect(issues.hidden).toBe(false);
    expect(issueList.querySelectorAll('[data-issue-iid]')).toHaveLength(issueRows);
    expect(browser.document.activeElement?.id).toBe('change-button');
  });

  // Keep associated project identity and issue browsing inside a dedicated workspace shell.
  it('shows the associated project and issues in the workspace shell, not the standalone header', async () => {
    await prepareAssociatedProject();
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));

    const workspace = root.querySelector<HTMLElement>('#workspace-view');
    const setup = root.querySelector<HTMLElement>('#setup-view');
    const standaloneHeader = root.querySelector<HTMLElement>('#panel-header');

    expect(workspace).not.toBeNull();
    expect(workspace?.hidden).toBe(false);
    expect(workspace?.querySelector('#association-value')?.textContent).toContain('platform/infra/deploy');
    expect(workspace?.querySelector<HTMLElement>('#issues-view')?.hidden).toBe(false);
    expect(workspace?.querySelector('[data-issue-iid="17"]')).not.toBeNull();
    expect(standaloneHeader === null || standaloneHeader.hidden).toBe(true);
    expect(setup?.hidden).toBe(true);

    expect(workspace?.textContent).not.toMatch(/FAKE/i);
    const controlLabels = [...(workspace?.querySelectorAll<HTMLElement>('button, input, select') ?? [])]
      .map((control) => `${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''}`);
    expect(controlLabels.join(' ')).not.toMatch(/FAKE/i);
  });

  // Keep the associated-project view focused on repository identity and real issue metadata.
  it('shows a compact GitLab work queue with repository identity and issue metadata', async () => {
    await prepareAssociatedProject();
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));

    const workspace = root.querySelector<HTMLElement>('#workspace-view')!;
    const repoStrip = workspace.querySelector<HTMLElement>('#repo-strip, .repo-strip');
    const queue = workspace.querySelector<HTMLElement>('#issues-view')!;
    const issueRow = queue.querySelector<HTMLElement>('[data-issue-iid="17"]')!;
    const rowText = issueRow.textContent ?? '';

    expect(repoStrip).not.toBeNull();
    expect(repoStrip?.textContent).toContain('OpenChamber');
    expect(repoStrip?.textContent).toContain('platform/infra/deploy');
    expect(workspace.querySelector('#workspace-title')?.textContent).toContain('GitLab work');
    expect(queue.hidden).toBe(false);
    expect(queue.textContent).toContain('Updated');
    expect(rowText).toMatch(/Open/i);
    expect(rowText).toContain('Issue');
    expect(rowText).toContain('2026');

    expect(workspace.textContent).not.toMatch(/Assigned to you|\bFilter\b/i);
    expect(workspace.textContent).not.toMatch(/FAKE/i);
    const controlLabels = [...workspace.querySelectorAll<HTMLElement>('button, a, input, select')]
      .map((control) => `${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''}`);
    expect(controlLabels.join(' ')).not.toMatch(/FAKE/i);
  });

  // Collapse replacement search after a newly verified project becomes the association.
  it('collapses the picker after successfully replacing an association', async () => {
    host = new MockHost(async (request) => {
      // Provide the saved and replacement projects through the same verified host bridge.
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya', web_url: 'https://gitlab.example.com/users/maya' });
      if (request.path === '/api/v4/projects') return response(200, [{ id: 813, path_with_namespace: 'platform/observability' }]);
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/813') return response(200, { id: 813, path_with_namespace: 'platform/observability' });
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await writeAssociation(host.storage, {
      projectId: 'workspace-1',
      accountId: 73,
      variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'platform/infra/deploy' });
    host.ready();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

    root.querySelector<HTMLButtonElement>('#change-button')!.click();
    enterSearch('observability');
    await waitFor(() => root.querySelector('#project-results')?.textContent.includes('platform/observability') === true);
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/observability');

    expect(root.querySelector<HTMLElement>('#project-picker')?.hidden).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('#change-button')?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector<HTMLButtonElement>('#change-button')?.textContent).toBe('Change project');
  });

  // Ignore search feedback that arrives after the user cancels project replacement.
  it('does not show a late no-results status after canceling a pending replacement search', async () => {
    let resolveSearch!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya', web_url: 'https://gitlab.example.com/users/maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects') {
        return new Promise((resolve) => { resolveSearch = resolve; });
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await writeAssociation(host.storage, {
      projectId: 'workspace-1',
      accountId: 73,
      variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'platform/infra/deploy' });
    host.ready();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

    root.querySelector<HTMLButtonElement>('#change-button')!.click();
    enterSearch('no-such-project');
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects'));
    root.querySelector<HTMLButtonElement>('#change-button')!.click();
    resolveSearch(response(200, []));
    await waitFor(() => root.querySelector('#searching-indicator')?.hasAttribute('hidden') === true);

    expect(root.querySelector<HTMLElement>('#project-picker')?.hidden).toBe(true);
    expect(root.querySelector('#panel-status')?.textContent).toBe('');
  });

  // Do not restore another repository's or GitLab variant's persisted association.
  it('isolates saved associations by registered repository and GitLab variant', async () => {
    await writeAssociation(host.storage, {
      projectId: 'workspace-other',
      accountId: 73,
      variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'wrong/repository' });

    // URL-derived keys from earlier builds are intentionally ignored rather than migrated.
    await writeAssociation(host.storage, {
      projectId: 'workspace-1',
      accountId: 73,
      variant: 'https://gitlab.other.example',
    }, { id: 812, path: 'wrong/instance' });
    host.ready();
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');

    expect(root.querySelector('#association-value')?.textContent).toBe('No GitLab project associated');
    expect(root.querySelector('#remove-slot')?.hasAttribute('hidden')).toBe(true);
    expect(host.requests.map((request) => request.path)).toEqual(['/api/v4/user']);
  });

  // Never show a stored project that GitLab no longer exposes to the verified account.
  it('does not restore a saved association when the project returns not found', async () => {
    mounted?.destroy();
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') {
        return response(200, { id: 73, username: 'maya', web_url: 'https://gitlab.example.com/users/maya' });
      }
      return response(404, {});
    });
    mounted = mountGitLabPanel(host, root);
    await writeAssociation(host.storage, {
      projectId: 'workspace-1',
      accountId: 73,
      variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'platform/infra/deploy' });
    host.ready();
    await waitFor(() => root.querySelector('#error-box')?.hasAttribute('hidden') === false);

    expect(root.querySelector('#association-value')?.textContent).toBe('No GitLab project associated');
    expect(root.querySelector('#remove-slot')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('#error-text')?.textContent).toContain('could not find this project');
    expect(host.requests.map((request) => request.path)).toEqual(['/api/v4/user', '/api/v4/projects/812']);
  });

  // Keep an unregistered session choice visible without writing it to host storage.
  it('keeps unknown-directory choices session-only and clears them without storage writes', async () => {
    host.ready('/tmp/unregistered-session');
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');
    expect(root.querySelector<HTMLElement>('#project-picker')?.hidden).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('#change-button')?.hidden).toBe(true);
    expect(root.querySelector('#save-hint')?.textContent).toContain('session only');
    expect(root.querySelector('#panel-status')?.textContent).toBe('');
    expect(root.querySelector('#save-hint')?.textContent).toContain('session only');
    expect(root.querySelector('#association-value')?.textContent).toBe('No project chosen for this session');

    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

    expect(root.querySelector('#association-label')?.textContent).toBe('GitLab project for this session');
    expect(root.querySelector('#panel-status')?.textContent).toContain('session only');
    expect(host.storedWrites).toBe(0);

    root.querySelector<HTMLButtonElement>('#remove-button')!.click();
    await waitFor(() => root.querySelector('#remove-slot')?.hasAttribute('hidden') === true);
    expect(host.storageDeletes).toBe(0);
  });

  // Keep search unavailable until both the host connection and local directory are known.
  it('disables search with nearby guidance for disconnected and unresolved host-ready contexts', async () => {
    host.ready('/repos/openchamber', { connected: false, account: '' });
    await waitFor(() => root.querySelector('#search-blocker')?.hasAttribute('hidden') === false);

    const disconnectedSearch = root.querySelector<HTMLInputElement>('#project-search')!;
    expect(root.querySelector<HTMLElement>('#project-picker')?.hidden).toBe(false);
    expect(disconnectedSearch.disabled).toBe(true);
    expect(root.querySelector('#search-blocker')?.textContent).toContain('Connect GitLab');
    expect(disconnectedSearch.getAttribute('aria-describedby')).toBe('search-blocker');
    expect(host.requests).toHaveLength(0);

    host.ready(null, { connected: true, account: 'maya' });
    await waitFor(() => root.querySelector('#search-blocker')?.textContent.includes('Open a local repository') === true);

    expect(root.querySelector<HTMLInputElement>('#project-search')?.disabled).toBe(true);
    expect(root.querySelector<HTMLElement>('#project-picker')?.hidden).toBe(false);
    expect(root.querySelector('#search-blocker')?.textContent).toContain('Open a local repository');
    expect(host.requests.map((request) => request.path)).toEqual(['/api/v4/user']);
  });

  // Show empty search feedback once in the live status area without duplicating it in results.
  it('reports an empty project search with one no-results status', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya', web_url: 'https://gitlab.example.com/users/maya' });
      if (request.path === '/api/v4/projects') return response(200, []);
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.ready();
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');

    enterSearch('no-such-project');
    await waitFor(() => root.querySelector('#panel-status')?.textContent === 'No visible projects matched that search.');

    expect(root.querySelector('#project-results')?.textContent).toBe('');
    expect(root.querySelector('#project-results .empty-results')).toBeNull();
  });

  // Keep the panel's association labels and hierarchy distinct for registered and session-only choices.
  it('shows the registered and session-only association hierarchy and precise action labels', async () => {
    host.ready();
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');
    expect(root.querySelector('#repository-label')?.textContent).toBe('Local repository');
    expect(root.querySelector('#association-label')?.textContent).toBe('GitLab project');
    expect(root.querySelector('#association-value')?.textContent).toBe('No GitLab project associated');

    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    expect(root.querySelector('#project-results .project-action')?.textContent).toBe('Choose');
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');
    expect(root.querySelector('#remove-button')?.textContent).toBe('Remove association');

    host.changeDirectory('/tmp/unregistered-session');
    await waitFor(() => root.querySelector('#association-label')?.textContent === 'GitLab project for this session');
    expect(root.querySelector('#repository-label')?.textContent).toBe('Directory');
    expect(root.querySelector('#repository-value')?.textContent).toBe('Unregistered directory');
    expect(root.querySelector('#association-value')?.textContent).toBe('No project chosen for this session');
    expect(root.querySelector('#remove-slot')?.hasAttribute('hidden')).toBe(true);
    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    expect(root.querySelector('#project-results .project-action')?.textContent).toBe('Use for this session');
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');
    expect(root.querySelector('#remove-button')?.textContent).toBe('Clear session choice');
  });

  // Preserve input focus for normal searches and move action focus to stable status feedback.
  it('preserves search focus across results and moves focus after save and removal', async () => {
    host.ready();
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');
    const input = root.querySelector<HTMLInputElement>('#project-search')!;
    input.focus();
    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    expect(browser.document.activeElement?.id).toBe('project-search');

    const result = root.querySelector<HTMLButtonElement>('#project-results button')!;
    result.focus();
    result.click();
    await waitFor(() => host.storedWrites === 1);
    expect(browser.document.activeElement?.id).toBe('panel-status');

    const remove = root.querySelector<HTMLButtonElement>('#remove-button')!;
    remove.focus();
    remove.click();
    await waitFor(() => host.storageDeletes === 1);
    expect(browser.document.activeElement?.id).toBe('panel-status');
    await waitFor(() => root.querySelector('#panel-status')?.textContent.includes('Association removed') === true);
    expect(root.querySelector('#remove-slot')?.hasAttribute('hidden')).toBe(true);
  });

  // Focus visible feedback before a restored association removes its focused action.
  it('moves removal focus to visible status when a restored association enters its busy state', async () => {
    let releaseDelete!: () => void;
    host.storageDeleteBarrier = new Promise((resolve) => { releaseDelete = resolve; });
    await prepareAssociatedProject();

    const status = root.querySelector<HTMLElement>('#panel-status')!;
    const remove = root.querySelector<HTMLButtonElement>('#remove-button')!;
    let focusedWhileHidden = false;
    status.addEventListener('focus', () => { focusedWhileHidden = focusedWhileHidden || Boolean(status.hidden); });
    expect(status.hidden).toBe(true);

    remove.focus();
    remove.click();
    await waitFor(() => remove.disabled);

    expect(focusedWhileHidden).toBe(false);
    expect(status.hidden).toBe(false);
    expect(browser.document.activeElement?.id).toBe('panel-status');
    expect(root.querySelector('#remove-slot')?.hasAttribute('hidden')).toBe(false);

    releaseDelete();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'No GitLab project associated');
    expect(root.querySelector('#remove-slot')?.hasAttribute('hidden')).toBe(true);
    expect(status.hidden).toBe(false);
    expect(browser.document.activeElement?.id).toBe('panel-status');
  });

  // Avoid moving a focused Cancel button when unrelated search renders update Setup.
  it('keeps the focused Cancel control in place across project-search renders', async () => {
    await prepareAssociatedProject();
    root.querySelector<HTMLButtonElement>('#change-button')!.click();

    const cancel = root.querySelector<HTMLButtonElement>('#change-button')!;
    const setupSlot = root.querySelector<HTMLElement>('#setup-action-slot')!;
    const observer = new browser.MutationObserver(() => {});
    observer.observe(setupSlot as unknown as Parameters<typeof observer.observe>[0], { childList: true });
    cancel.focus();

    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const childListMutations = observer.takeRecords().filter((record) => record.type === 'childList');
    observer.disconnect();

    expect(childListMutations).toHaveLength(0);
    expect(browser.document.activeElement?.id).toBe('change-button');
    expect(cancel.parentElement).toBe(setupSlot);
  });

  // Distinguish persistent removal from clearing an unregistered directory's session choice.
  it('uses registered removal versus session-only clearing without persistent deletion', async () => {
    host.ready('/tmp/unregistered-session');
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');
    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

    const clear = root.querySelector<HTMLButtonElement>('#remove-button')!;
    expect(clear.textContent).toBe('Clear session choice');
    clear.click();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'No project chosen for this session');
    expect(host.storageDeletes).toBe(0);
    expect(host.storedWrites).toBe(0);
  });

  // Show actionable, sanitized errors through the mounted panel for every host and API failure class.
  it('shows safe states for redirects, transport, unavailable API, auth, forbidden, and missing resources', async () => {
    const failures: Array<{ result: GuestRequestResult | Error; message: string; packageRecovery?: boolean }> = [
      { result: response(302, {}), message: 'redirected the API request', packageRecovery: true },
      { result: new HostRequestError('BAD_PATH', 'origin details'), message: 'configured GitLab API origin is invalid', packageRecovery: true },
      { result: new Error('TLS certificate details contain secret text'), message: 'trusted TLS certificate', packageRecovery: true },
      { result: new HostRequestError('HOST_UNAVAILABLE', 'private bridge details'), message: 'Could not reach GitLab', packageRecovery: true },
      { result: new HostRequestError('DISCONNECTED', 'private auth details'), message: 'rejected the token', packageRecovery: true },
      { result: response(401, {}), message: 'rejected the token', packageRecovery: true },
      { result: response(403, {}), message: 'denied this request' },
      { result: response(404, {}), message: 'current-user API', packageRecovery: true },
      { result: response(503, {}), message: 'could not complete the request', packageRecovery: true },
    ];

    for (const failure of failures) {
      mounted?.destroy();
      host = new MockHost(async (request) => {
        if (request.path !== '/api/v4/user') return response(200, []);
        if (failure.result instanceof Error) throw failure.result;
        return failure.result;
      });
      mounted = mountGitLabPanel(host, root);
      host.ready();
      await waitFor(() => root.querySelector('#error-box')?.hasAttribute('hidden') === false);

      const message = root.querySelector('#error-text')?.textContent ?? '';
      expect(message).toContain(failure.message);
      expect(message).not.toContain('secret text');
      expect(message).not.toContain('private');
      expect(message).not.toContain('origin in Settings → Integrations');
      if (failure.packageRecovery) expect(message).toContain('Remove the extension, configure the package, reinstall it');
      expect(root.querySelector('#project-results button')).toBeNull();
      expect(host.requests.map((request) => request.path)).toEqual(['/api/v4/user']);
    }
  });

  // Reverify the numeric user after an onConnection event even when its display string does not change.
  it('requires search and reselection after the same displayed account changes numeric identity', async () => {
    let profile = { id: 73, username: 'maya', web_url: 'https://gitlab.example.com/users/maya' };
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, profile);
      if (request.path === '/api/v4/projects') return response(200, [{ id: 812, path_with_namespace: 'platform/infra/deploy' }]);
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await writeAssociation(host.storage, {
      projectId: 'workspace-1',
      accountId: 74,
      variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'stale/saved-association' });
    host.ready();
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');

    profile = { ...profile, id: 74 };
    host.changeConnection({ connected: true, account: 'maya' });
    await waitFor(() => root.querySelector('#panel-status')?.textContent.includes('account changed') === true);
    expect(root.querySelector('#association-value')?.textContent).toBe('No GitLab project associated');
    expect(root.querySelector('#remove-slot')?.hasAttribute('hidden')).toBe(true);
    expect(host.requests.filter((request) => request.path === '/api/v4/user')).toHaveLength(2);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812')).toBe(false);

    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

    expect(root.querySelector('#panel-status')?.textContent).toContain('Saved association');
    expect(host.storedWrites).toBe(2);
  });

  // A save must stop and reload when its final /user check finds a different numeric account.
  it('does not persist a project if the verified account changes during save', async () => {
    let profile = { id: 73, username: 'maya', web_url: 'https://gitlab.example.com/users/maya' };
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, profile);
      if (request.path === '/api/v4/projects') return response(200, [{ id: 812, path_with_namespace: 'platform/infra/deploy' }]);
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await writeAssociation(host.storage, {
      projectId: 'workspace-1',
      accountId: 74,
      variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'stale/saved-association' });
    host.ready();
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');
    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));

    profile = { ...profile, id: 74 };
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => root.querySelector('#panel-status')?.textContent.includes('account changed') === true);

    expect(root.querySelector('#association-value')?.textContent).toBe('No GitLab project associated');
    expect(root.querySelector('#remove-slot')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('#project-results button')).toBeNull();
    expect(host.requests.map((request) => request.path)).toEqual([
      '/api/v4/user',
      '/api/v4/projects',
      '/api/v4/projects/812',
      '/api/v4/user',
    ]);
    expect(host.storedWrites).toBe(1);
  });

  // Give connected repositories without an association a dedicated project setup surface.
  it('shows a dedicated setup workspace for a connected unassociated repository', async () => {
    host.ready('/repos/openchamber');
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');

    const setup = root.querySelector<HTMLElement>('#setup-view');
    expect(setup).not.toBeNull();
    expect(setup?.hidden).toBe(false);
    expect(setup?.querySelector('#setup-heading')?.textContent?.trim().length).toBeGreaterThan(0);
    expect(setup?.querySelector<HTMLInputElement>('#project-search')?.disabled).toBe(false);
    expect([...setup!.querySelectorAll('p')].some((instruction) => {
      const text = instruction.textContent?.trim() ?? '';
      return text.length > 0 && text.length <= 200;
    })).toBe(true);
    expect(root.querySelector<HTMLElement>('#issues-view')?.hidden ?? true).toBe(true);
  });

  // Reverify a registered association's account before removal when the host display name is unchanged.
  it('does not delete a saved association after the numeric account changes before remove', async () => {
    let profile = { id: 73, username: 'maya', web_url: 'https://gitlab.example.com/users/maya' };
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, profile);
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await writeAssociation(host.storage, {
      projectId: 'workspace-1',
      accountId: 73,
      variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'platform/infra/deploy' });
    host.ready();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

    profile = { ...profile, id: 74 };
    root.querySelector<HTMLButtonElement>('#remove-button')!.click();
    await waitFor(() => root.querySelector('#panel-status')?.textContent.includes('account changed') === true);

    expect(host.requests.filter((request) => request.path === '/api/v4/user')).toHaveLength(2);
    expect(host.storageDeletes).toBe(0);
    expect(host.storedValues.size).toBe(1);
    expect(root.querySelector('#association-value')?.textContent).toBe('No GitLab project associated');
    expect(root.querySelector('#remove-slot')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('#project-results button')).toBeNull();
    expect(root.querySelector('#panel-status')?.textContent).toContain('reselect a project');
  });

  // Keep removal disabled and surface safe API guidance when account verification fails.
  it('fails closed on /user rejection during remove and preserves the API error', async () => {
    const failures: Array<{ result: GuestRequestResult | Error; message: string }> = [
      { result: response(401, {}), message: 'rejected the token' },
      { result: new HostRequestError('DISCONNECTED', 'private credential details'), message: 'rejected the token' },
      { result: new Error('private TLS certificate details'), message: 'trusted TLS certificate' },
    ];

    for (const failure of failures) {
      let verificationFailure: GuestRequestResult | Error | null = null;
      host = new MockHost(async (request) => {
        if (request.path === '/api/v4/user') {
          if (verificationFailure instanceof Error) throw verificationFailure;
          if (verificationFailure) return verificationFailure;
          return response(200, { id: 73, username: 'maya' });
        }
        if (request.path === '/api/v4/projects/812') {
          return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
        }
        return response(404, {});
      });
      mounted?.destroy();
      mounted = mountGitLabPanel(host, root);
      await writeAssociation(host.storage, {
        projectId: 'workspace-1',
        accountId: 73,
        variant: GITLAB_VARIANT_ID,
      }, { id: 812, path: 'platform/infra/deploy' });
      host.ready();
      await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

      verificationFailure = failure.result;
      root.querySelector<HTMLButtonElement>('#remove-button')!.click();
      await waitFor(() => root.querySelector('#error-box')?.hasAttribute('hidden') === false);

      const message = root.querySelector('#error-text')?.textContent ?? '';
      expect(message).toContain(failure.message);
      expect(message).not.toContain('private');
      expect(host.storageDeletes).toBe(0);
      expect(host.storedValues.size).toBe(1);
      expect(root.querySelector<HTMLButtonElement>('#remove-button')?.disabled).toBe(true);
      expect(root.querySelector('#project-results button')).toBeNull();
    }
  });

  // Report storage failures separately from GitLab account-verification failures.
  it('fails closed with a storage-specific message when deletion is uncertain', async () => {
    mounted?.destroy();
    host = new MockHost();
    mounted = mountGitLabPanel(host, root);
    await writeAssociation(host.storage, {
      projectId: 'workspace-1',
      accountId: 73,
      variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'platform/infra/deploy' });
    host.ready();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

    let deleteCalls = 0;
    host.storage.delete = async () => {
      deleteCalls += 1;
      throw new Error('private storage backend detail');
    };
    root.querySelector<HTMLButtonElement>('#remove-button')!.click();
    await waitFor(() => root.querySelector('#error-box')?.hasAttribute('hidden') === false);

    const message = root.querySelector('#error-text')?.textContent ?? '';
    expect(message).toContain('could not confirm whether the association was removed');
    expect(message).not.toContain('private storage backend detail');
    expect(deleteCalls).toBe(1);
    expect(root.querySelector<HTMLButtonElement>('#remove-button')?.disabled).toBe(true);
    expect(root.querySelector('#project-results button')).toBeNull();
  });

  // A workspace snapshot that stops being ready must block the selected-project request and save.
  it('fails closed if workspace snapshots become incomplete before a save', async () => {
    host.ready();
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');
    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    host.projectsSnapshot = { ...projects, state: 'loading' };
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => root.querySelector('#error-box')?.hasAttribute('hidden') === false);

    expect(root.querySelector('#error-text')?.textContent).toContain('snapshots changed');
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812')).toBe(false);
    expect(host.storedWrites).toBe(0);
  });

  // A stale project request must not write after OpenChamber changes the active directory.
  it('ignores a selected-project response after the OpenChamber directory changes', async () => {
    let resolveSelected!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') {
        return response(200, { id: 73, username: 'maya', web_url: 'https://gitlab.example.com/users/maya' });
      }
      if (request.path === '/api/v4/projects') {
        return response(200, [{ id: 812, path_with_namespace: 'platform/infra/deploy' }]);
      }
      if (request.path === '/api/v4/projects/812') {
        return new Promise((resolve) => { resolveSelected = resolve; });
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.ready();
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');
    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812'));

    host.changeDirectory('/tmp/unregistered-session');
    resolveSelected(response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' }));
    await waitFor(() => root.querySelector('#save-hint')?.textContent.includes('session only') === true);

    expect(host.storedWrites).toBe(0);
    expect(root.querySelector('#association-value')?.textContent).toBe('No project chosen for this session');
    expect(root.querySelector('#association-label')?.textContent).toBe('GitLab project for this session');
    expect(root.querySelector('#panel-status')?.textContent).toBe('');
    expect(root.querySelector('#remove-slot')?.hasAttribute('hidden')).toBe(true);
  });

  // Newer searches must win even when an older host request completes last.
  it('ignores late search responses after a newer query completes', async () => {
    let resolveOlder!: (value: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/projects' && request.query?.search === 'older') {
        return new Promise((resolve) => { resolveOlder = resolve; });
      }
      if (request.path === '/api/v4/projects' && request.query?.search === 'newer') {
        return response(200, [{ id: 813, path_with_namespace: 'platform/newer' }]);
      }
      if (request.path === '/api/v4/user') {
        return response(200, { id: 73, username: 'maya', web_url: 'https://gitlab.example.com/users/maya' });
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.ready();
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');

    enterSearch('older');
    await waitFor(() => host.requests.some((request) => request.query?.search === 'older'));
    enterSearch('newer');
    await waitFor(() => root.querySelector('#project-results')?.textContent.includes('platform/newer') === true);
    resolveOlder(response(200, [{ id: 812, path_with_namespace: 'platform/older' }]));
    await waitFor(() => root.querySelector('#project-results')?.textContent.includes('platform/newer') === true);

    expect(root.querySelector('#project-results')?.textContent).toContain('platform/newer');
    expect(root.querySelector('#project-results')?.textContent).not.toContain('platform/older');
  });

  // Start the first issue page after association verification without showing a false empty state.
  it('automatically loads project issues, fetches fresh detail, and returns to the list', async () => {
    let resolveIssues!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return new Promise((resolve) => { resolveIssues = resolve; });
      if (request.path === '/api/v4/projects/812/issues/17') return response(200, issueResponse());
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/issues'));
    expect(root.querySelector('#issues-count')?.textContent).not.toContain('0');
    expect(root.querySelector<HTMLElement>('#issues-empty')?.hidden).toBe(true);
    resolveIssues(response(200, [issueResponse()]));
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
    expect(host.requests.find((request) => request.path === '/api/v4/projects/812/issues')).toMatchObject({
      query: { state: 'opened', per_page: '20', page: '1', order_by: 'updated_at', sort: 'desc' },
    });

    root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17')).toBe(true);

    root.querySelector<HTMLButtonElement>('#back-to-issues')!.click();
    await waitFor(() => root.querySelector<HTMLElement>('#issues-view')?.hidden === false);
    expect(root.querySelector('[data-issue-iid="17"]')).toBeTruthy();
  });

  // Switch work types and keep merge-request search and pagination scoped to the associated project.
  it('does not submit a pending merge-request search after switching to Issues', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') return response(200, [mergeRequestResponse()]);
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Queue a search, then leave the merge-request list before its debounce expires.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => root.textContent?.includes('Ship forked deployment fix') === true);
    const search = [...root.querySelectorAll<HTMLInputElement>('input')].find((input) =>
      /search merge requests/i.test(input.getAttribute('aria-label') ?? ''))!;
    search.value = 'stale query';
    search.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
    findButton(/^issues$/i)!.click();
    await new Promise((resolve) => setTimeout(resolve, 130));

    // Keep the visible issue list and avoid a hidden search request.
    expect(root.querySelector<HTMLElement>('#issues-view')?.hidden).toBe(false);
    expect(root.textContent).toContain('Fix deployment flow');
    expect(host.requests.filter((request) => request.path === '/api/v4/projects/812/merge_requests'
      && request.query?.search === 'stale query')).toHaveLength(0);
  });

  // Clear a focused search when moving between two eligible registered project scopes.
  it('does not carry a pending merge-request search across registered directories', async () => {
    const otherDirectory = '/repos/other';
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/813') return response(200, { id: 813, path_with_namespace: 'platform/other' });
      if (request.path.endsWith('/issues')) return response(200, [issueResponse()]);
      if (request.path.endsWith('/merge_requests')) return response(200, [mergeRequestResponse()]);
      return response(404, {});
    });
    host.projectsSnapshot = {
      ...projects,
      projects: [...projects.projects, { id: 'workspace-2', name: 'Other', directory: otherDirectory }],
    };
    await writeAssociation(host.storage, {
      projectId: 'workspace-2', accountId: 73, variant: GITLAB_VARIANT_ID,
    }, { id: 813, path: 'platform/other' });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Hold only the search debounce so host readiness waits still use real timers.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests'));
    const search = root.querySelector<HTMLInputElement>('input[aria-label="Search merge requests"]')!;
    search.focus();
    expect(Object.is(browser.document.activeElement, search)).toBe(true);
    const originalSetTimeout = globalThis.setTimeout;
    let pendingSearch: (() => void) | null = null;
    let heldTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay === 80) {
          pendingSearch = () => (callback as (...values: unknown[]) => void)(...args);
          heldTimer = originalSetTimeout(callback, 10_000, ...args) as unknown as ReturnType<typeof setTimeout>;
          return heldTimer;
        }
        return originalSetTimeout(callback, delay, ...args);
      }) as typeof setTimeout;
      search.value = 'old-scope-only';
      search.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
      expect(pendingSearch).not.toBeNull();

      // Reach a verified B list and then a verified A list before the held callback runs.
      host.changeDirectory(otherDirectory);
      await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/other');
      await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/813/merge_requests'));
      expect(root.querySelector<HTMLInputElement>('input[aria-label="Search merge requests"]')?.value).toBe('');
      expect(Object.is(browser.document.activeElement, search)).toBe(true);
      host.changeDirectory('/repos/openchamber');
      await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');
      expect(root.querySelector<HTMLInputElement>('input[aria-label="Search merge requests"]')?.value).toBe('');

      // Even a callback already queued before cancellation cannot submit to either scope.
      pendingSearch!();
      await new Promise((resolve) => originalSetTimeout(resolve, 10));
      for (const projectId of [812, 813]) {
        expect(host.requests.filter((request) => request.path === `/api/v4/projects/${projectId}/merge_requests`
          && request.query?.search === 'old-scope-only')).toHaveLength(0);
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      if (heldTimer) clearTimeout(heldTimer);
    }
  });

  // Switch work types and keep merge-request search and pagination scoped to the associated project.
  it('switches to project merge requests, searches them, and loads only the next bounded page', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') {
        const page = Number(request.query?.page);
        const search = request.query?.search;
        const count = search ? (page === 1 ? 20 : 1) : 0;
        return response(200, Array.from({ length: count }, (_, index) => mergeRequestResponse({
          id: 1901 + index + (page - 1) * 20,
          iid: 39 + index + (page - 1) * 20,
          title: `Fork change ${index + 1 + (page - 1) * 20}`,
          web_url: `https://gitlab.example.com/platform/infra/deploy/-/merge_requests/${39 + index + (page - 1) * 20}`,
        })));
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Confirm the current queue is Issues before the user changes work types.
    await waitFor(() => root.textContent?.includes('Fix deployment flow') === true);
    expect(root.textContent).toContain('Issues');

    // Select the merge-request queue through its visible work-type action.
    const mergeRequestsChoice = findButton(/^merge requests$/i);
    expect(mergeRequestsChoice).not.toBeNull();
    mergeRequestsChoice!.click();
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests'));

    // Search through the merge-request queue's accessible input.
    const search = [...root.querySelectorAll<HTMLInputElement>('input')].find((input) =>
      /search merge requests/i.test(input.getAttribute('aria-label') ?? ''));
    expect(search).not.toBeUndefined();
    search!.focus();
    search!.value = 'fork';
    search!.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
    root.querySelector<HTMLFormElement>('#merge-request-search-form')!.dispatchEvent(
      new browser.Event('submit', { bubbles: true, cancelable: true }) as unknown as SubmitEvent,
    );
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests'
      && request.query?.search === 'fork' && request.query?.page === '1'));
    await waitFor(() => root.textContent?.includes('Fork change 1') === true);

    // Verify the server request is project-scoped and the first page is bounded.
    const listRequests = host.requests.filter((request) => request.path === '/api/v4/projects/812/merge_requests');
    expect(listRequests.at(-1)).toMatchObject({
      path: '/api/v4/projects/812/merge_requests',
      query: { search: 'fork', per_page: '20', page: '1' },
    });
    expect(root.textContent).toContain('Fork change 20');
    expect(root.textContent).not.toContain('Fork change 21');

    // Request one next page and keep the search term on that page request.
    const loadMore = findButton(/load more/i);
    expect(loadMore).not.toBeNull();
    loadMore!.click();
    await waitFor(() => root.textContent?.includes('Fork change 21') === true);

    expect(host.requests.filter((request) => request.path === '/api/v4/projects/812/merge_requests')
      .map((request) => request.query?.page)).toContain('2');
    expect(host.requests.filter((request) => request.path === '/api/v4/projects/812/merge_requests').at(-1))
      .toMatchObject({ query: { search: 'fork', per_page: '20', page: '2' } });
    expect(root.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  // Restore the searched list and its keyboard position after opening a full detail view.
  it('opens a fork merge request detail and Back restores its query and focused row', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') return response(200, [mergeRequestResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests/39') return response(200, mergeRequestResponse());
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Open the merge-request queue and preserve its search before selecting a row.
    const mergeRequestsChoice = findButton(/^merge requests$/i);
    expect(mergeRequestsChoice).not.toBeNull();
    mergeRequestsChoice!.click();
    await waitFor(() => root.textContent?.includes('Ship forked deployment fix') === true);
    const search = [...root.querySelectorAll<HTMLInputElement>('input')].find((input) =>
      /search merge requests/i.test(input.getAttribute('aria-label') ?? ''))!;
    search.focus();
    search.value = 'fork fix';
    search.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
    root.querySelector<HTMLFormElement>('#merge-request-search-form')!.dispatchEvent(
      new browser.Event('submit', { bubbles: true, cancelable: true }) as unknown as SubmitEvent,
    );
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests'
      && request.query?.search === 'fork fix'));
    await waitFor(() => root.textContent?.includes('Ship forked deployment fix') === true);

    // Move keyboard focus to the row before opening its full detail view.
    const row = findButton(/ship forked deployment fix/i);
    expect(row).not.toBeNull();
    row!.focus();
    row!.click();
    await waitFor(() => root.textContent?.includes('Merge request details') === true
      && root.querySelector('#merge-request-web-url')?.textContent.includes('https://gitlab.example.com/platform/infra/deploy/-/merge_requests/39') === true);

    // Confirm the selected fork request is loaded from the associated target project.
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests/39')).toBe(true);
    expect(root.textContent).toContain('Merge request details');
    expect(root.textContent).toContain('https://gitlab.example.com/platform/infra/deploy/-/merge_requests/39');
    expect(findButton(/ship forked deployment fix/i)).toBeNull();

    // Return to the filtered queue and verify focus returns to the selected keyboard row.
    const back = findButton(/back to merge requests/i);
    expect(back).not.toBeNull();
    back!.click();
    await waitFor(() => root.textContent?.includes('Ship forked deployment fix') === true
      && browser.document.activeElement?.textContent?.includes('Ship forked deployment fix') === true);

    const restoredSearch = [...root.querySelectorAll<HTMLInputElement>('input')].find((input) =>
      /search merge requests/i.test(input.getAttribute('aria-label') ?? ''));
    expect(restoredSearch?.value).toBe('fork fix');
    expect(browser.document.activeElement?.textContent).toContain('Ship forked deployment fix');
    expect(host.requests.filter((request) => request.path === '/api/v4/projects/812/merge_requests')
      .some((request) => request.query?.search === 'fork fix')).toBe(true);
  });

  // Discard a pending merge-request page when the associated local project context changes.
  it('does not render merge-request data returned after the project context changes', async () => {
    let resolveMergeRequests!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') {
        return new Promise((resolve) => { resolveMergeRequests = resolve; });
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Leave a project request pending so its result arrives after the local context changes.
    const mergeRequestsChoice = findButton(/^merge requests$/i);
    expect(mergeRequestsChoice).not.toBeNull();
    mergeRequestsChoice!.click();
    await waitFor(() => Boolean(resolveMergeRequests));
    host.changeDirectory('/tmp/changed-directory');
    resolveMergeRequests(response(200, [mergeRequestResponse({ title: 'Stale fork data must stay hidden' })]));
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'No project chosen for this session');

    expect(root.textContent).not.toContain('Stale fork data must stay hidden');
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests')).toBe(true);
  });

  // Clear previously visible provider data on a current 401 before re-verifying the account.
  it('resets issue and merge-request data after a current merge-request 401, then reloads the verified scope', async () => {
    let userChecks = 0;
    let mergeRequestReads = 0;
    let resolveReverification!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') {
        userChecks += 1;
        if (userChecks === 2) return new Promise((resolve) => { resolveReverification = resolve; });
        return response(200, { id: 73, username: 'maya' });
      }
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') {
        mergeRequestReads += 1;
        if (mergeRequestReads === 2) return response(401, {});
        const title = mergeRequestReads === 1 ? 'Old merge request data' : 'Fresh merge request data';
        return response(200, [mergeRequestResponse({ title })]);
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Load both old issue and merge-request data before the authorization failure.
    await waitFor(() => root.textContent?.includes('Fix deployment flow') === true);
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => root.textContent?.includes('Old merge request data') === true);
    findButton(/^refresh$/i)!.click();
    await waitFor(() => Boolean(resolveReverification));

    // Keep the verification request pending long enough to prove the old account data was removed.
    expect(root.textContent).not.toContain('Old merge request data');
    expect(root.textContent).not.toContain('Fix deployment flow');
    expect(host.requests.filter((request) => request.path === '/api/v4/user')).toHaveLength(2);

    // Restore only data read again after the current account passes verification.
    resolveReverification(response(200, { id: 73, username: 'maya' }));
    await waitFor(() => root.textContent?.includes('Fresh merge request data') === true);
    expect(host.requests.filter((request) => request.path === '/api/v4/projects/812/merge_requests')).toHaveLength(3);
    expect(root.textContent).not.toContain('Old merge request data');
  });

  // A current issue authorization failure must revoke the same account scope as an MR failure.
  it('hides account-scoped data and rejects a late merge-request page after an issue-page 401', async () => {
    let issueReads = 0;
    let userChecks = 0;
    let resolveMergeRequests!: (result: GuestRequestResult) => void;
    let resolveReverification!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') {
        userChecks += 1;
        if (userChecks > 1) return new Promise((resolve) => { resolveReverification = resolve; });
        return response(200, { id: 73, username: 'maya' });
      }
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') {
        issueReads += 1;
        if (request.query?.page === '2') return response(401, {});
        return response(200, Array.from({ length: 20 }, (_, index) => issueResponse({
          id: 901 + index, iid: 17 + index, title: `Account issue ${index + 1}`,
        })));
      }
      if (request.path === '/api/v4/projects/812/merge_requests') {
        return new Promise((resolve) => { resolveMergeRequests = resolve; });
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Keep the MR page pending while the existing issue list remains available.
    await waitFor(() => root.textContent?.includes('Account issue 1') === true);
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => Boolean(resolveMergeRequests));
    findButton(/^issues$/i)!.click();
    await waitFor(() => root.textContent?.includes('Account issue 1') === true);
    expect(issueReads).toBe(1);

    // Fail the current second issue page without allowing a fresh account verification to restore scope.
    findButton(/load more/i)!.click();
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/issues'
      && request.query?.page === '2'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(userChecks).toBe(2);
    expect(root.textContent).not.toContain('Account issue 1');
    expect(root.querySelector('#association-value')?.textContent).not.toBe('platform/infra/deploy');

    // A response from the earlier account scope must not repopulate the workspace.
    resolveMergeRequests(response(200, [mergeRequestResponse({ title: 'Revoked account merge request' })]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(root.textContent).not.toContain('Revoked account merge request');
    resolveReverification(response(401, {}));
  });

  // A detail authorization failure must clear the issue and MR scope before verification finishes.
  it('hides issue detail and merge-request data after a current issue-detail 401', async () => {
    let userChecks = 0;
    let resolveReverification!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') {
        userChecks += 1;
        if (userChecks === 2) return new Promise((resolve) => { resolveReverification = resolve; });
        return response(200, { id: 73, username: 'maya' });
      }
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return response(401, {});
      if (request.path === '/api/v4/projects/812/merge_requests') {
        return response(200, [mergeRequestResponse({ title: 'Old account MR' })]);
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Load MR rows under the verified account, then request a current issue detail.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => root.textContent?.includes('Old account MR') === true);
    findButton(/^issues$/i)!.click();
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
    root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'Not connected');

    // Keep re-verification pending so old account data cannot be mistaken for restored data.
    expect(userChecks).toBe(2);
    expect(root.querySelector('#association-value')?.textContent).not.toBe('platform/infra/deploy');
    expect(root.textContent).not.toContain('Fix deployment flow');
    expect(root.textContent).not.toContain('Old account MR');
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    resolveReverification(response(401, {}));
  });

  // Keep verified issue-session focus ahead of an unrelated merge-request list response.
  it('does not let a pending merge-request response replace a verified issue-session detail or focus', async () => {
    let resolveMergeRequests!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return response(200, issueResponse());
      if (request.path === '/api/v4/projects/812/merge_requests') {
        return new Promise((resolve) => { resolveMergeRequests = resolve; });
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.sessionsSnapshot = {
      kind: 'sessions',
      projectId: 'workspace-1',
      state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{ id: 'gitlab-self-managed:issue:73:812:17', data: {
          v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17,
          issueId: 901, webUrl: gitLabIssue.webUrl,
        } }],
      }],
    };
    await prepareAssociatedProject();
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => Boolean(resolveMergeRequests));

    // Verify the focused issue route while the merge-request page is still outstanding.
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');
    const focusedIssueHeading = root.querySelector<HTMLElement>('#issue-heading')!;
    const issueDetail = root.querySelector<HTMLElement>('#issue-detail')!;
    expect(issueDetail.hidden).toBe(false);
    expect(browser.document.activeElement?.id).toBe('issue-heading');

    // Let the unrelated list finish and prove it neither changes the route nor steals focus.
    resolveMergeRequests(response(200, [mergeRequestResponse({ title: 'Background merge request result' })]));
    await waitFor(() => root.textContent?.includes('Background merge request result') === true);
    expect(issueDetail.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('#merge-request-detail')?.hidden).toBe(true);
    expect(browser.document.activeElement?.id).toBe(focusedIssueHeading.id);
  });

  // Recheck once after an issue-list 401, then leave repeated denial disconnected.
  it('reverifies once and hides association after repeated issue-list 401', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(401, {});
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await writeAssociation(host.storage, {
      projectId: 'workspace-1', accountId: 73, variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'platform/infra/deploy' });
    host.ready();
    await waitFor(() => host.requests.filter((request) => request.path === '/api/v4/projects/812/issues').length === 2);
    expect(host.requests.filter((request) => request.path === '/api/v4/user')).toHaveLength(2);
    expect(root.querySelector('#association-value')?.textContent).not.toBe('platform/infra/deploy');
    expect(host.storedWrites).toBe(1);
  });

  // Reverify once after a detail-read 401 and hide its stale route on repeated denial.
  it('reverifies once and hides issue detail after repeated detail 401', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return response(401, {});
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
    root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
    await waitFor(() => host.requests.filter((request) => request.path === '/api/v4/user').length === 2);
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    expect(host.requests.filter((request) => request.path === '/api/v4/user')).toHaveLength(2);
    expect(host.storedWrites).toBe(1);
  });

  // Keep one automatic auth check available despite successful issue reads between MR failures.
  it('does not replenish the automatic auth retry budget after an unrelated successful issue read', async () => {
    let userChecks = 0;
    let issueReads = 0;
    let mergeRequestReads = 0;
    let resolveSecondMergeRequest!: (result: GuestRequestResult) => void;
    let resolveThirdVerification!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') {
        userChecks += 1;
        if (userChecks === 3) return new Promise((resolve) => { resolveThirdVerification = resolve; });
        return response(200, { id: 73, username: 'maya' });
      }
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') {
        issueReads += 1;
        return response(200, [issueResponse()]);
      }
      if (request.path === '/api/v4/projects' && request.query?.search) return response(500, {});
      if (request.path === '/api/v4/projects/812/merge_requests') {
        mergeRequestReads += 1;
        if (mergeRequestReads === 1) return response(401, {});
        if (mergeRequestReads === 2) return new Promise((resolve) => { resolveSecondMergeRequest = resolve; });
        return response(200, [mergeRequestResponse()]);
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Trigger the first MR denial and let its single automatic account verification succeed.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => Boolean(resolveSecondMergeRequest) && issueReads === 2);

    // Preserve a visible explicit Retry action while the second MR denial is pending.
    enterSearch('deployment');
    await waitFor(() => root.querySelector<HTMLElement>('#error-box')?.hidden === false);
    resolveSecondMergeRequest(response(401, {}));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(userChecks).toBe(2);

    // A user Retry may begin one new bounded recovery cycle.
    root.querySelector<HTMLButtonElement>('#retry-button')!.click();
    await waitFor(() => userChecks === 3 && Boolean(resolveThirdVerification));
    expect(host.requests.filter((request) => request.path === '/api/v4/user')).toHaveLength(3);
  });

  // Advance pages by request count and remove identities repeated at a page boundary.
  it('loads issue pages in order and deduplicates global and project-local IDs', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') {
        const page = Number(request.query?.page);
        if (page === 1) return response(200, Array.from({ length: 20 }, (_, index) => issueResponse({
          id: 900 + index,
          iid: 10 + index,
          title: `Issue ${index + 1}`,
          web_url: `https://gitlab.example.com/platform/infra/deploy/-/issues/${10 + index}`,
        })));
        return response(200, [
          issueResponse({ id: 900, iid: 50, title: 'Duplicate global ID', web_url: 'https://gitlab.example.com/platform/infra/deploy/-/issues/50' }),
          issueResponse({ id: 999, iid: 10, title: 'Duplicate project IID' }),
          issueResponse({ id: 1000, iid: 30, title: 'Issue 21', web_url: 'https://gitlab.example.com/platform/infra/deploy/-/issues/30' }),
        ]);
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    await waitFor(() => root.querySelectorAll('#issues-list [data-issue-iid]').length === 20);
    root.querySelector<HTMLButtonElement>('#load-more-issues-button')!.click();
    await waitFor(() => root.querySelectorAll('#issues-list [data-issue-iid]').length === 21);

    expect(host.requests.filter((request) => request.path === '/api/v4/projects/812/issues').map((request) => request.query?.page))
      .toEqual(['1', '2']);
    expect(root.querySelectorAll('#issues-list [data-issue-iid="10"]')).toHaveLength(1);
    expect(root.querySelector('#issues-list')?.textContent).toContain('Issue 21');
  });

  // Ignore a list response when the active directory changes during its request.
  it('discards issue pages returned for an old directory', async () => {
    let resolveIssues!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return new Promise((resolve) => { resolveIssues = resolve; });
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/issues'));

    host.changeDirectory('/tmp/changed-directory');
    resolveIssues(response(200, [issueResponse()]));
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'No project chosen for this session');

    expect(root.querySelector('[data-issue-iid="17"]')).toBeNull();
    expect(root.querySelector('#issue-heading')?.textContent).not.toBe('Fix deployment flow');
  });

  // Allow an unknown-directory session choice to browse without exposing worktree creation.
  it('lets a session-only association browse issues but disables worktree creation', async () => {
    host.ready('/tmp/unregistered-session');
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');
    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
    root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');

    expect(root.querySelector<HTMLButtonElement>('#start-worktree-button')?.hidden).toBe(true);
    expect(root.querySelector('#worktree-blocker')?.hasAttribute('hidden')).toBe(false);
    expect(host.startedSessions).toHaveLength(0);
    expect(host.storedWrites).toBe(0);
  });

  // Persist one recovery record before startSession and never send prompt text.
  // A denied preflight must revoke browsing without creating or retrying a worktree.
  it('revokes account scope on worktree preflight 401 without starting a session', async () => {
    let userChecks = 0;
    let resolveReverification!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') {
        userChecks += 1;
        if (userChecks === 2) return response(401, {});
        if (userChecks === 3) return new Promise((resolve) => { resolveReverification = resolve; });
        return response(200, { id: 73, username: 'maya' });
      }
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return response(200, issueResponse());
      if (request.path === '/api/v4/projects/812/merge_requests') return response(200, [mergeRequestResponse({ title: 'Old scoped MR' })]);
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Establish both browse scopes before the worktree preflight fails.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => root.textContent?.includes('Old scoped MR') === true);
    findButton(/^issues$/i)!.click();
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
    root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');
    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => userChecks >= 2);

    // Do not expose old account data or dispatch a start while verification is pending.
    expect(userChecks).toBe(3);
    await waitFor(() => root.querySelector<HTMLElement>('#issue-detail')?.hidden === true);
    expect(root.querySelector('#association-value')?.textContent).not.toBe('platform/infra/deploy');
    expect(findButton(/Old scoped MR/)).toBeNull();
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    expect(host.startedSessions).toHaveLength(0);

    // Verification may restore browsing, but must not restart creation automatically.
    resolveReverification(response(200, { id: 73, username: 'maya' }));
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');
    expect(host.startedSessions).toHaveLength(0);
  });

  it('reverifies a selected issue and starts one linked worktree session without text', async () => {
    await prepareAssociatedProject();
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
    root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');
    host.startSessionResult = { sessionId: 'created-session', directory: '/repos/openchamber/.worktrees/created-issue', sent: 'skipped', linked: false };

    const startButton = root.querySelector<HTMLButtonElement>('#start-worktree-button')!;
    startButton.click();
    startButton.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Created');

    expect(host.startedSessions).toHaveLength(1);
    expect(host.startedSessions[0]).toEqual({
      providerId: GITLAB_VARIANT_ID,
      id: 'gitlab-self-managed:issue:73:812:17',
      title: 'Fix deployment flow',
      url: gitLabIssue.webUrl,
      kind: 'issue',
      data: expect.objectContaining({ v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl, recoveryAttemptId: expect.any(String) }),
      projectId: 'workspace-1',
      worktree: true,
      navigation: 'preserve',
    });
    expect(host.startedSessions[0]).not.toHaveProperty('text');
    expect(host.events.indexOf(`set:${RECOVERY_KEY}`)).toBeLessThan(host.events.indexOf('startSession'));
    expect(root.querySelector('#recovery-message')?.textContent).toContain('did not confirm the issue link');
    expect(root.querySelector('#worktree-error')?.textContent).toBe('');
  });

  // Retain the project-scoped list when the focused session has no verified issue link.
  it('keeps the loaded project issue list after switching to an unlinked session', async () => {
    await prepareIssueDetail();
    const unlinkedSession = {
      id: 'unlinked-session', title: 'Unlinked', projectId: 'workspace-1', directory: '/repos/openchamber',
      parentId: null, createdAt: 1, updatedAt: 1, archivedAt: null, worktree: null,
      activity: 'idle' as const, outcome: null, busy: false, items: [],
    } as SessionSnapshot;

    host.focusSession(unlinkedSession);
    await waitFor(() => root.querySelector<HTMLElement>('#issue-detail')?.hidden === true);

    expect(root.querySelector('[data-issue-iid="17"]')).toBeTruthy();
    expect(root.querySelector<HTMLElement>('#issues-empty')?.hidden).toBe(true);
  });

  // Keep a pending project-list request valid across a focused-session switch.
  it('renders the initial issue page after switching sessions while it is pending', async () => {
    let resolveIssues!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return new Promise((resolve) => { resolveIssues = resolve; });
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();
    await waitFor(() => Boolean(resolveIssues));

    host.focusSession({
      id: 'unlinked-session', title: 'Unlinked', busy: false,
    });
    resolveIssues(response(200, [issueResponse()]));
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));

    expect(root.querySelector<HTMLElement>('#issues-empty')?.hidden).toBe(true);
    expect(root.querySelector('#issues-list')?.textContent).toContain('Fix deployment flow');
  });

  // Report retained partial worktree creation without retrying or creating another one.
  it('reports a retained worktree after bootstrap failure and does not retry automatically', async () => {
    await prepareAssociatedProject();
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
    root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');
    host.startSessionResult = {
      sessionId: null,
      sent: 'skipped',
      directory: '/repos/openchamber/.worktrees/issue-17',
      worktree: { directory: '/repos/openchamber/.worktrees/issue-17', name: 'issue-17', branch: 'issue-17', status: 'ready' },
      failure: 'bootstrap-failed',
    };

    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Record retained');

    expect(host.startedSessions).toHaveLength(1);
    expect(root.querySelector('#recovery-message')?.textContent).toContain('setup did not finish');
  });

  // Store a successful result before opening its session and preserve the originating page until asked.
  it('persists successful creation before auto-opening and keeps the record available', async () => {
    await prepareIssueDetail();
    host.startSessionResult = {
      sessionId: 'created-session',
      directory: '/repos/openchamber/.worktrees/issue-17',
      sent: 'skipped',
      linked: true,
    };

    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => host.openedSessions.length === 1);

    const saved = storedRecovery();
    expect(saved?.outcome).toEqual({
      kind: 'created', sessionId: 'created-session', directory: '/repos/openchamber/.worktrees/issue-17', linked: true, sent: 'skipped',
    });
    expect(host.events.indexOf('startSession')).toBeLessThan(host.events.lastIndexOf(`set:${RECOVERY_KEY}`));
    expect(host.events.lastIndexOf(`set:${RECOVERY_KEY}`)).toBeLessThan(host.events.indexOf('openSession'));
    expect(host.openedSessions).toEqual(['created-session']);
    expect(root.querySelector('#issue-heading')?.textContent).toBe('Fix deployment flow');
  });

  // Restore the durable lock after remount and refuse another start even from a fresh issue detail.
  it('keeps an unresolved attempt locked after timeout and panel remount', async () => {
    await prepareIssueDetail();
    host.startSessionError = new Error('host request timed out');
    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Outcome unknown');
    expect(storedRecovery()?.outcome).toEqual({ kind: 'unresolved' });
    expect(host.startedSessions).toHaveLength(1);

    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.ready();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Outcome unknown');
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
    root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');

    expect(root.querySelector<HTMLButtonElement>('#start-worktree-button')?.hidden).toBe(true);
    expect(host.startedSessions).toHaveLength(1);
  });

  // Keep the controller-wide operation lock while an attempt is being armed across context changes.
  it('does not allow a second start while the first recovery arm is pending', async () => {
    await prepareIssueDetail();
    let finishWrite!: () => void;
    let recoveryWrites = 0;
    const originalSet = host.storage.set;
    host.storage.set = async (key, value) => {
      if (key === RECOVERY_KEY) {
        recoveryWrites += 1;
        if (!finishWrite) await new Promise<void>((resolve) => { finishWrite = resolve; });
      }
      await originalSet(key, value);
    };

    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => Boolean(finishWrite));
    const detailRequests = host.requests.filter((request) => request.path === '/api/v4/projects/812/issues/17').length;
    host.ready('/repos/openchamber');
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
    root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
    await waitFor(() => host.requests.filter((request) => request.path === '/api/v4/projects/812/issues/17').length > detailRequests
      && root.querySelector<HTMLElement>('#issue-detail-status')?.hidden === true
      && root.querySelector<HTMLElement>('#issue-content')?.hidden === false);
    expect(root.querySelector<HTMLButtonElement>('#start-worktree-button')?.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('#start-worktree-button')?.click();
    expect(host.startedSessions).toHaveLength(0);
    expect(recoveryWrites).toBe(1);
    finishWrite();
    await waitFor(() => storedRecovery()?.outcome.kind === 'unresolved');

    expect(host.startedSessions).toHaveLength(0);
    expect(recoveryWrites).toBe(1);
    expect(root.querySelector('#recovery-message')?.textContent).toContain('context changed before dispatch');
  });

  // Invalidate preflight when focus changes during arming without releasing its global lock.
  it('does not dispatch when focus changes while the recovery arm is pending', async () => {
    await prepareIssueDetail();
    let finishWrite!: () => void;
    const originalSet = host.storage.set;
    host.storage.set = async (key, value) => {
      if (key === RECOVERY_KEY && !finishWrite) await new Promise<void>((resolve) => { finishWrite = resolve; });
      await originalSet(key, value);
    };

    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => Boolean(finishWrite));
    host.focusSession({
      id: 'new-session', title: 'New session', busy: false,
    });
    finishWrite();
    await waitFor(() => storedRecovery()?.outcome.kind === 'unresolved');

    expect(host.startedSessions).toHaveLength(0);
    expect(root.querySelector('#recovery-message')?.textContent).toContain('context changed before dispatch');
  });

  // Keep the project issue list visible when focus changes after startSession was dispatched.
  it('preserves the issue list when focus changes during a dispatched start', async () => {
    await prepareIssueDetail();
    let resolveStart!: (result: StartSessionResult) => void;
    host.startSession = async (request) => {
      host.events.push('startSession');
      host.startedSessions.push(request);
      return new Promise((resolve) => { resolveStart = resolve; });
    };

    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => Boolean(resolveStart));
    host.focusSession({
      id: 'new-session', title: 'New session', busy: false,
    });
    expect(root.querySelector('[data-issue-iid="17"]')).toBeTruthy();

    resolveStart({ sessionId: 'created-session', directory: '/repos/openchamber/.worktrees/created-issue', sent: 'skipped', linked: true });
    await waitFor(() => storedRecovery()?.outcome.kind === 'created');
    expect(root.querySelector('[data-issue-iid="17"]')).toBeTruthy();
    expect(host.startedSessions).toHaveLength(1);
  });

  // Recover an outcome committed before storage lost its acknowledgement without leaving it unresolved.
  it('recognizes a persisted start outcome after the storage acknowledgement is lost', async () => {
    await prepareIssueDetail();
    let loseAcknowledgement = true;
    const originalSet = host.storage.set;
    host.storage.set = async (key, value) => {
      await originalSet(key, value);
      const attemptedOutcome = key === RECOVERY_KEY && typeof value === 'object' && value !== null
        && !Array.isArray(value) && (value as Record<string, JsonValue>).outcome !== undefined
        && ((value as Record<string, JsonValue>).outcome as Record<string, JsonValue>).kind !== 'unresolved';
      if (attemptedOutcome && loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('acknowledgement lost');
      }
    };

    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Outcome unknown');
    expect(storedRecovery()?.outcome.kind).toBe('created');

    root.querySelector<HTMLButtonElement>('#check-recovery-button')!.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Created');
    expect(storedRecovery()?.outcome).toEqual({
      kind: 'created', sessionId: 'created-session', directory: '/repos/openchamber/.worktrees/created-issue', linked: true, sent: 'skipped',
    });
    expect(host.startedSessions).toHaveLength(1);
  });

  // Keep timeout checks fail-closed when complete snapshots contain no exact tagged session.
  it('does not unlock or replay after an empty timeout outcome check', async () => {
    await prepareIssueDetail();
    host.startSessionError = new Error('host request timed out');
    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Outcome unknown');

    root.querySelector<HTMLButtonElement>('#check-recovery-button')!.click();
    await waitFor(() => root.querySelector('#recovery-message')?.textContent.includes('No single exact') === true);

    expect(storedRecovery()?.outcome).toEqual({ kind: 'unresolved' });
    expect(root.querySelector<HTMLButtonElement>('#start-worktree-button')?.hidden).toBe(true);
    expect(host.startedSessions).toHaveLength(1);
  });

  // Promote only the timed-out attempt's exact tagged session and open it only through the explicit action.
  it('reconciles the exact attempt marker and opens its session without starting another worktree', async () => {
    await prepareIssueDetail();
    host.startSessionError = new Error('host request timed out');
    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => host.startedSessions.length === 1);
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Outcome unknown');
    const request = host.startedSessions[0]!;
    const directory = '/repos/openchamber/.worktrees/issue-17';
    host.worktreesSnapshot = {
      ...worktrees,
      worktrees: [{ directory, name: 'issue-17', branch: 'issue-17', status: 'ready' }],
    };
    host.sessionsSnapshot = {
      kind: 'sessions',
      projectId: 'workspace-1',
      state: 'ready',
      coverage: [{ directory, state: 'ready' }],
      sessions: [{
        id: 'reconciled-session', title: 'Issue 17', projectId: 'workspace-1', directory,
        parentId: null, createdAt: 1, updatedAt: 1, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{ id: request.id, data: request.data }],
      }],
    };

    root.querySelector<HTMLButtonElement>('#check-recovery-button')!.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Created');
    expect(storedRecovery()?.outcome).toEqual({
      kind: 'created', sessionId: 'reconciled-session', directory, linked: true, sent: 'unknown',
    });
    expect(host.openedSessions).toHaveLength(0);

    root.querySelector<HTMLButtonElement>('#open-recovery-session-button')!.click();
    await waitFor(() => host.openedSessions.length === 1);
    expect(host.openedSessions).toEqual(['reconciled-session']);
    expect(host.startedSessions).toHaveLength(1);
  });

  // Persist creation when context changes during start but never steal focus back to that session.
  it('suppresses automatic navigation after the initiating directory changes', async () => {
    await prepareIssueDetail();
    let resolveStart!: (result: StartSessionResult) => void;
    host.startSession = async (request) => {
      host.events.push('startSession');
      host.startedSessions.push(request);
      return new Promise((resolve) => { resolveStart = resolve; });
    };
    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => host.startedSessions.length === 1);
    host.changeDirectory('/tmp/other-project');
    expect(root.querySelector<HTMLElement>('#release-recovery')?.hidden).toBe(true);
    resolveStart({
      sessionId: 'created-session', directory: '/repos/openchamber/.worktrees/issue-17', sent: 'skipped', linked: true,
    });
    await waitFor(() => storedRecovery()?.outcome.kind === 'created');

    expect(host.openedSessions).toHaveLength(0);
    expect(storedRecovery()?.outcome.kind).toBe('created');
  });

  // Retry a failed open through openSession alone and preserve the record on both attempts.
  it('retries failed session navigation without replaying worktree creation', async () => {
    await prepareIssueDetail();
    host.openSessionError = new Error('host navigation unavailable');
    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Created');
    expect(host.openedSessions).toEqual(['created-session']);
    expect(root.querySelector('#recovery-message')?.textContent).toContain('could not open it');

    host.openSessionError = null;
    root.querySelector<HTMLButtonElement>('#open-recovery-session-button')!.click();
    await waitFor(() => host.openedSessions.length === 2);
    expect(host.openedSessions).toEqual(['created-session', 'created-session']);
    expect(host.startedSessions).toHaveLength(1);
    expect(storedRecovery()?.outcome.kind).toBe('created');
  });

  // Keep release gated on confirmation and retain the lock if host deletion is not acknowledged.
  it('preserves the recovery lock when confirmed release fails', async () => {
    await prepareIssueDetail();
    host.startSessionError = new Error('host request timed out');
    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Outcome unknown');
    host.storageDeleteError = new Error('private storage detail');

    root.querySelector<HTMLInputElement>('#release-recovery-confirm')!.click();
    root.querySelector<HTMLButtonElement>('#release-recovery-button')!.click();
    await waitFor(() => root.querySelector('#recovery-message')?.textContent.includes('could not confirm recovery release') === true);

    expect(storedRecovery()?.outcome).toEqual({ kind: 'unresolved' });
    expect(root.querySelector<HTMLButtonElement>('#start-worktree-button')?.hidden).toBe(true);
    expect(host.storageDeletes).toBe(1);
  });

  // A recovery storage read error disables creation until the user explicitly retries the read.
  it('keeps creation disabled after a recovery read error until retry succeeds', async () => {
    await writeAssociation(host.storage, {
      projectId: 'workspace-1', accountId: 73, variant: GITLAB_VARIANT_ID,
    }, { id: 812, path: 'platform/infra/deploy' });
    host.storageReadError = new Error('private storage details');
    host.ready();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Read failed');
    await waitFor(() => Boolean(root.querySelector('[data-issue-iid="17"]')));
    root.querySelector<HTMLButtonElement>('[data-issue-iid="17"]')!.click();
    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');
    expect(root.querySelector<HTMLButtonElement>('#start-worktree-button')?.hidden).toBe(true);

    host.storageReadError = null;
    root.querySelector<HTMLButtonElement>('#retry-recovery-button')!.click();
    await waitFor(() => root.querySelector<HTMLElement>('#recovery-banner')?.hidden === true);
    expect(root.querySelector<HTMLButtonElement>('#start-worktree-button')?.hidden).toBe(false);
    expect(host.startedSessions).toHaveLength(0);
  });

  // Keep a recorded result locked when persistence fails, then retry that write before snapshots.
  it('retries persistence of a known start result before checking host snapshots', async () => {
    await prepareIssueDetail();
    const originalSet = host.storage.set;
    let failOutcomeWrite = true;
    host.storage.set = async (key, value) => {
      const outcomeKind = key === RECOVERY_KEY && value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, JsonValue>).outcome && typeof (value as Record<string, JsonValue>).outcome === 'object'
          ? ((value as Record<string, JsonValue>).outcome as Record<string, JsonValue>).kind
          : null
        : null;
      if (key === RECOVERY_KEY && outcomeKind === 'created' && failOutcomeWrite) throw new Error('private storage error');
      await originalSet(key, value);
    };
    host.startSessionResult = {
      sessionId: 'created-session', directory: '/repos/openchamber/.worktrees/issue-17', sent: 'no-model', linked: true,
    };
    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Outcome unknown');
    expect(storedRecovery()?.outcome).toEqual({ kind: 'unresolved' });

    failOutcomeWrite = false;
    root.querySelector<HTMLButtonElement>('#check-recovery-button')!.click();
    await waitFor(() => root.querySelector('#recovery-phase')?.textContent === 'Created');
    expect(storedRecovery()?.outcome).toEqual({
      kind: 'created', sessionId: 'created-session', directory: '/repos/openchamber/.worktrees/issue-17', linked: true, sent: 'no-model',
    });
    expect(host.startedSessions).toHaveLength(1);
  });

  // Do not dispatch after the context changes while the pre-dispatch recovery write is pending.
  it('leaves an acknowledged lock without dispatch when context changes during arming', async () => {
    await prepareIssueDetail();
    const originalSet = host.storage.set;
    let finishWrite!: () => void;
    host.storage.set = async (key, value) => {
      if (key === RECOVERY_KEY) {
        host.events.push(`set:${key}`);
        await new Promise<void>((resolve) => { finishWrite = resolve; });
        host.storedValues.set(key, value);
        return;
      }
      await originalSet(key, value);
    };

    root.querySelector<HTMLButtonElement>('#start-worktree-button')!.click();
    await waitFor(() => host.events.includes(`set:${RECOVERY_KEY}`));
    host.changeDirectory('/tmp/unregistered-after-arm');
    finishWrite();
    await waitFor(() => storedRecovery()?.outcome.kind === 'unresolved');

    expect(host.startedSessions).toHaveLength(0);
    expect(root.querySelector('#recovery-message')?.textContent).toContain('context changed before dispatch');
  });

  // Verify a focused issue only when ready session coverage carries exact extension metadata.
  it('opens a session-linked issue only from a complete matching session snapshot', async () => {
    const itemId = 'gitlab-self-managed:issue:73:812:17';
    host.sessionsSnapshot = {
      kind: 'sessions',
      projectId: 'workspace-1',
      state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{ id: itemId, data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl } }],
      }],
    };
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
    await prepareAssociatedProject();
    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');

    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(false);
    expect(root.querySelector<HTMLButtonElement>('#back-to-issues')?.hidden).toBe(true);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17')).toBe(true);
  });

  // Prove a malformed explicit MR suppresses inferred discovery while a separate issue link is checked.
  it('does not infer a related MR from a malformed explicit session item', async () => {
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [
          {
            id: 'gitlab-self-managed:issue:73:812:17',
            data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl },
          },
          { id: 'gitlab-self-managed:merge_request:bad', data: {} },
        ],
      }],
    };
    await prepareAssociatedProject();
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17'));

    expect(host.requests.some((request) => request.path.includes('/related_merge_requests'))).toBe(false);
    expect(host.requests.some((request) => request.path.includes('/merge_requests/'))).toBe(false);
  });

  // Ignore a successful issue response after the focused session changes to another record.
  it('does not restore an old session issue after switching focus', async () => {
    let resolveIssue!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return new Promise((resolve) => { resolveIssue = resolve; });
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'old-session', title: 'Old session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{ id: 'gitlab-self-managed:issue:73:812:17', data: {
          v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl,
        } }],
      }],
    };
    await prepareAssociatedProject();
    host.focusSession({ id: 'old-session', title: 'Old session', busy: false });
    await waitFor(() => Boolean(resolveIssue));

    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'new-session', title: 'New session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 3, updatedAt: 4, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null, items: [],
      }],
    };
    host.focusSession({ id: 'new-session', title: 'New session', busy: false });
    await waitFor(() => root.querySelector<HTMLElement>('#session-link-status')?.hidden === true);
    resolveIssue(response(200, issueResponse()));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    expect(root.querySelector('#account-value')?.textContent).toBe('maya');
  });

  // Ignore an old session 401 without clearing or re-verifying the active account.
  it('does not let an old session 401 revoke the current account', async () => {
    let resolveIssue!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return new Promise((resolve) => { resolveIssue = resolve; });
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'old-session', title: 'Old session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{ id: 'gitlab-self-managed:issue:73:812:17', data: {
          v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl,
        } }],
      }],
    };
    await prepareAssociatedProject();
    host.focusSession({ id: 'old-session', title: 'Old session', busy: false });
    await waitFor(() => Boolean(resolveIssue));

    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'new-session', title: 'New session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 3, updatedAt: 4, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null, items: [],
      }],
    };
    host.focusSession({ id: 'new-session', title: 'New session', busy: false });
    await waitFor(() => root.querySelector<HTMLElement>('#session-link-status')?.hidden === true);
    resolveIssue(response(401, {}));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(host.requests.filter((request) => request.path === '/api/v4/user')).toHaveLength(1);
    expect(root.querySelector('#account-value')?.textContent).toBe('maya');
    expect(root.querySelector('#association-value')?.textContent).toBe('platform/infra/deploy');
  });

  // Remove the session route when the provider no longer confirms its exact issue identity.
  it('invalidates a session-linked route when the refreshed issue ID or URL changes', async () => {
    const mismatchedIssues = [
      issueResponse({ id: 902 }),
      issueResponse({ web_url: 'https://gitlab.example.com/platform/infra/deploy/-/issues/17?moved=1' }),
    ];

    for (const mismatchedIssue of mismatchedIssues) {
      let freshIssue: Record<string, unknown> = issueResponse();
      host = new MockHost(async (request) => {
        if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
        if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
        if (request.path === '/api/v4/projects/812/issues/17') return response(200, freshIssue);
        return response(404, {});
      });
      mounted?.destroy();
      mounted = mountGitLabPanel(host, root);
      host.sessionsSnapshot = {
        kind: 'sessions', projectId: 'workspace-1', state: 'ready',
        coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
        sessions: [{
          id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
          parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
          activity: 'idle', outcome: null,
          items: [{
            id: 'gitlab-self-managed:issue:73:812:17',
            data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl },
          }],
        }],
      };
      host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
      await prepareAssociatedProject();
      await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');

      freshIssue = mismatchedIssue;
      const detailReadsBeforeSnapshot = host.requests.filter((request) => request.path === '/api/v4/projects/812/issues/17').length;
      root.querySelector<HTMLButtonElement>('#refresh-issue-context')!.click();
      await waitFor(() => host.requests.filter((request) => request.path === '/api/v4/projects/812/issues/17').length > detailReadsBeforeSnapshot);
      await waitFor(() => root.querySelector<HTMLElement>('#issue-detail')?.hidden === true);

      expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    }
  });

  // Reconcile the focused session against later project snapshots without another focus event.
  it('updates the verified linked issue when session coverage arrives after a session switch', async () => {
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'first-session', title: 'First session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null, items: [],
      }],
    };
    host.focusSession({ id: 'first-session', title: 'First session', busy: false });
    await prepareAssociatedProject();

    host.focusSession({ id: 'current-session', title: 'Current session', busy: false });
    host.pushSessions({
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'current-session', title: 'Current session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 3, updatedAt: 4, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{
          id: 'gitlab-self-managed:issue:73:812:17',
          data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl },
        }],
      }],
    });

    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(false);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17')).toBe(true);
  });

  // Clear the focused issue route when the host switches to a session without its identity.
  it('clears a verified issue detail after switching to an unlinked session', async () => {
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{ id: 'gitlab-self-managed:issue:73:812:17', data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl } }],
      }],
    };
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
    await prepareAssociatedProject();
    await waitFor(() => root.querySelector('#issue-heading')?.textContent === 'Fix deployment flow');

    host.pushSessions({
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'other-session', title: 'Other session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 3, updatedAt: 4, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null, items: [],
      }],
    });
    host.focusSession({ id: 'other-session', title: 'Other session', busy: false });

    await waitFor(() => root.querySelector<HTMLElement>('#issue-detail')?.hidden === true);
    expect(root.querySelector('#issue-heading')?.textContent).toBe('Fix deployment flow');
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
  });

  // Keep the saved mapping and neutral list when an issue item names another GitLab project.
  it('does not route to an issue when session metadata conflicts with the association', async () => {
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{ id: 'gitlab-self-managed:issue:73:813:17', data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 813, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl } }],
      }],
    };
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
    await prepareAssociatedProject();
    await waitFor(() => root.querySelector<HTMLElement>('#issues-view')?.hidden === false);

    expect(root.querySelector('#association-value')?.textContent).toBe('platform/infra/deploy');
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    expect(host.storedWrites).toBe(1);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17')).toBe(false);
  });

  // Do not infer a current issue link from a loading or uncovered sessions snapshot.
  it('keeps the normal list route when session snapshot coverage is incomplete', async () => {
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'loading',
      coverage: [{ directory: '/repos/openchamber', state: 'loading' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{ id: 'gitlab-self-managed:issue:73:812:17', data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl } }],
      }],
    };
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
    await prepareAssociatedProject();

    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17')).toBe(false);
  });

  // Prefer an exact session merge-request link and verify it against GitLab before focus.
  it('opens only the explicitly linked merge request after verifying its fresh identity', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return response(200, issueResponse());
      if (request.path === '/api/v4/projects/812/merge_requests/39') {
        return response(200, mergeRequestResponse({ state: 'closed' }));
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareIssueDetail();

    // Keep the extension-owned item shape independent of any SDK-defined item kind.
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Merge request session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{
          id: 'gitlab-self-managed:merge_request:73:812:39',
          data: {
            v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812,
            iid: 39, mergeRequestId: 1901,
            webUrl: 'https://gitlab.example.com/platform/infra/deploy/-/merge_requests/39',
          },
        }],
      }],
    };
    host.focusSession({ id: 'focused-session', title: 'Merge request session', busy: false });
    host.pushSessions();

    // Wait for the fresh request and the real merge-request detail view.
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests/39')
      && [...root.querySelectorAll('article')].some((article) => !article.hidden
        && article.querySelector('h1, h2, h3')?.textContent === 'Ship forked deployment fix'));

    const visibleArticles = [...root.querySelectorAll('article')].filter((article) => !article.hidden);
    expect(visibleArticles.some((article) => article.textContent?.includes('Merge request details'))).toBe(true);
    expect(visibleArticles.some((article) => article.textContent?.includes('Fix deployment flow'))).toBe(false);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17/related_merge_requests')).toBe(false);
  });

  // Focus one visible opened related merge request without overstating what the link proves.
  it('focuses exactly one opened related merge request after checking all related pages', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return response(200, issueResponse());
      if (request.path === '/api/v4/projects/812/issues/17/related_merge_requests') {
        return response(200, request.query?.page === '1' ? [mergeRequestResponse()] : []);
      }
      if (request.path === '/api/v4/projects/812/merge_requests/39') return response(200, mergeRequestResponse());
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{
          id: 'gitlab-self-managed:issue:73:812:17',
          data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl },
        }],
      }],
    };
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
    await prepareAssociatedProject();

    // Require both the bounded page traversal and the verified detail before asserting provenance.
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests/39')
      && [...root.querySelectorAll('article')].some((article) => !article.hidden
        && article.querySelector('h1, h2, h3')?.textContent === 'Ship forked deployment fix'));

    const relatedRequests = host.requests.filter((request) => request.path === '/api/v4/projects/812/issues/17/related_merge_requests');
    expect(relatedRequests).toHaveLength(2);
    expect(relatedRequests[0]).toMatchObject({ query: { page: '1', per_page: '50' } });
    expect(relatedRequests[1]).toMatchObject({ query: { page: '2', per_page: '50' } });
    expect(root.textContent?.toLowerCase()).toContain('related');
    expect(root.textContent?.toLowerCase()).not.toContain('only related');
    expect([...root.querySelectorAll('article')].some((article) => !article.hidden
      && article.textContent?.includes('Merge request details'))).toBe(true);
  });

  // Leave the verified issue in place when a later page makes related-MR results ambiguous.
  it('does not choose an arbitrary related merge request when a later page has another target', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return response(200, issueResponse());
      if (request.path === '/api/v4/projects/812/issues/17/related_merge_requests') {
        return response(200, request.query?.page === '1'
          ? [mergeRequestResponse()]
          : [mergeRequestResponse({
            id: 2902, iid: 40, project_id: 813, target_project_id: 813,
            title: 'Cross-target candidate',
            web_url: 'https://gitlab.example.com/platform/other/-/merge_requests/40',
          })]);
      }
      if (request.path === '/api/v4/projects/812/merge_requests/39') return response(200, mergeRequestResponse());
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{
          id: 'gitlab-self-managed:issue:73:812:17',
          data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl },
        }],
      }],
    };
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
    await prepareAssociatedProject();

    // Wait until both related pages have been examined and the issue detail is settled.
    await waitFor(() => host.requests.filter((request) => request.path === '/api/v4/projects/812/issues/17/related_merge_requests').length >= 2
      && root.querySelector<HTMLElement>('article[aria-labelledby="issue-heading"]')?.hidden === false);

    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests/39')).toBe(false);
    expect(root.querySelector<HTMLElement>('article[aria-labelledby="issue-heading"]')?.hidden).toBe(false);
    expect(root.textContent).toContain('Fix deployment flow');
    expect(root.textContent).not.toContain('Ship forked deployment fix');
  });

  // Treat malformed explicit metadata as a failed link, not permission to infer a related MR.
  it('does not run related-MR discovery for a relevant but mismatched explicit MR item', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return response(200, issueResponse());
      if (request.path === '/api/v4/projects/812/issues/17/related_merge_requests') return response(200, [mergeRequestResponse()]);
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [
          {
            id: 'gitlab-self-managed:issue:73:812:17',
            data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl },
          },
          {
            id: 'gitlab-self-managed:merge_request:73:812:39',
            data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 813, iid: 39, mergeRequestId: 1901, webUrl: 'https://gitlab.example.com/platform/other/-/merge_requests/39' },
          },
        ],
      }],
    };
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
    await prepareAssociatedProject();

    // Retain only the independently verified issue and reject implicit fallback discovery.
    await waitFor(() => root.querySelector<HTMLElement>('article[aria-labelledby="issue-heading"]')?.hidden === false);

    expect(root.textContent).toContain('Fix deployment flow');
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17/related_merge_requests')).toBe(false);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests/39')).toBe(false);
  });

  // Reject an issue identity whose encoded item ID contradicts its metadata account.
  it('does not fetch issue details or related merge requests for contradictory account metadata', async () => {
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{
          id: 'gitlab-self-managed:issue:73:812:17',
          data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 74, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl },
        }],
      }],
    };
    await prepareAssociatedProject();
    const priorSessionReads = host.sessionsReads;
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });

    // Wait for the session evidence read to finish without requiring a brief checking flash.
    await waitFor(() => host.sessionsReads > priorSessionReads);
    await waitFor(() => root.querySelector<HTMLElement>('#session-link-status')?.hidden === true);

    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17')).toBe(false);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17/related_merge_requests')).toBe(false);
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#merge-request-detail')?.hidden).toBe(true);
  });

  // Keep an independently verified issue visible and explain why its attached MR is unavailable.
  it('shows a safe attached-MR verification failure for a malformed explicit item', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/issues/17') return response(200, issueResponse());
      if (request.path === '/api/v4/projects/812/issues/17/related_merge_requests') return response(200, [mergeRequestResponse()]);
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Issue session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [
          {
            id: 'gitlab-self-managed:issue:73:812:17',
            data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812, iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl },
          },
          { id: 'gitlab-self-managed:merge_request:bad', data: {} },
        ],
      }],
    };
    await prepareAssociatedProject();
    host.focusSession({ id: 'focused-session', title: 'Issue session', busy: false });
    await waitFor(() => root.querySelector<HTMLElement>('#issue-detail')?.hidden === false
      && root.querySelector<HTMLElement>('#issue-content')?.hidden === false);

    const visibleStatusText = [...root.querySelectorAll<HTMLElement>('[role="status"],[role="alert"]')]
      .filter((element) => {
        let ancestor: HTMLElement | null = element;
        while (ancestor && root.contains(ancestor)) {
          if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true') return false;
          ancestor = ancestor.parentElement;
        }
        return true;
      })
      .map((element) => element.textContent ?? '')
      .join(' ');
    const refresh = root.querySelector<HTMLButtonElement>('#refresh-issue-context');
    expect(visibleStatusText).toMatch(/(?:attached|linked).{0,80}merge request|merge request.{0,80}(?:attached|linked)/is);
    expect(visibleStatusText).toMatch(/could not.{0,40}verif|unable to.{0,40}verif|verification.{0,40}(?:failed|unavailable)/is);
    expect(visibleStatusText).not.toContain('No open related merge request appeared');
    expect(refresh?.hidden).toBe(false);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17/related_merge_requests')).toBe(false);
    expect(root.textContent).not.toContain('safe fixture refusal');
  });

  // Offer a session-link retry after a linked MR cannot be freshly verified.
  it('rechecks an unavailable explicit MR and opens only its verified linked detail', async () => {
    let detailStatus = 404;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, []);
      if (request.path === '/api/v4/projects/812/merge_requests/39') {
        return response(detailStatus, detailStatus === 200 ? mergeRequestResponse() : { error: 'safe fixture refusal' });
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Merge request session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{
          id: 'gitlab-self-managed:merge_request:73:812:39',
          data: {
            v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812,
            iid: 39, mergeRequestId: 1901,
            webUrl: 'https://gitlab.example.com/platform/infra/deploy/-/merge_requests/39',
          },
        }],
      }],
    };
    await prepareAssociatedProject();
    host.focusSession({ id: 'focused-session', title: 'Merge request session', busy: false });
    await waitFor(() => host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests/39'));
    await new Promise((resolve) => setTimeout(resolve, 5));

    const visibleText = [...root.querySelectorAll<HTMLElement>('p,[role="status"],[role="alert"]')]
      .filter((element) => {
        let ancestor: HTMLElement | null = element;
        while (ancestor && root.contains(ancestor)) {
          if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true') return false;
          ancestor = ancestor.parentElement;
        }
        return true;
      })
      .map((element) => element.textContent ?? '')
      .join(' ');
    const refresh = findButton(/(?:recheck|refresh).*(?:session|link|context)|(?:session|link|context).*(?:recheck|refresh)/i);
    expect(visibleText).toMatch(/(?:attached|linked).{0,80}merge request|merge request.{0,80}(?:attached|linked)/is);
    expect(visibleText).toMatch(/could not.{0,40}verif|unable to.{0,40}verif|verification.{0,40}(?:failed|unavailable)/is);
    expect(refresh).toBeTruthy();
    expect(refresh?.id).not.toBe('refresh-merge-requests-button');
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    expect(root.textContent).not.toContain('safe fixture refusal');
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/issues/17')).toBe(false);

    // Recheck through the session-link action, then allow only a verified linked detail.
    detailStatus = 200;
    const requestCountBeforeRefresh = host.requests.filter((request) => request.path === '/api/v4/projects/812/merge_requests/39').length;
    const writesBeforeRefresh = host.storedWrites;
    const deletesBeforeRefresh = host.storageDeletes;
    refresh!.click();
    await waitFor(() => host.requests.filter((request) => request.path === '/api/v4/projects/812/merge_requests/39').length > requestCountBeforeRefresh
      && root.querySelector<HTMLElement>('#merge-request-detail')?.hidden === false
      && root.querySelector('#merge-request-heading')?.textContent === 'Ship forked deployment fix');

    expect(root.querySelector('#merge-request-detail-label')?.textContent).toBe('Linked to this session');
    expect(root.querySelector<HTMLElement>('#back-to-merge-requests')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    expect(host.requests.some((request) => request.path.includes('/related_merge_requests'))).toBe(false);
    expect(host.startedSessions).toHaveLength(0);
    expect(host.events).not.toContain('startSession');
    expect(host.storedWrites).toBe(writesBeforeRefresh);
    expect(host.storageDeletes).toBe(deletesBeforeRefresh);
  });

  // Keep auxiliary merge-request reads behind the tab the user opens.
  it('loads fork-owned pipelines and jobs only after opening Pipelines & jobs', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') return response(200, [mergeRequestResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests/39') return response(200, mergeRequestResponse());
      if (request.path === '/api/v4/projects/812/merge_requests/39/pipelines') {
        return response(200, [{ id: 501, project_id: 913, ref: 'feature/deploy', status: 'success' }]);
      }
      if (request.path === '/api/v4/projects/913/pipelines/501/jobs') {
        return response(200, [{ id: 701, name: 'test', status: 'success' }]);
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Open the real merge-request detail and wait until its Overview is stable.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => Boolean(findButton(/ship forked deployment fix/i)));
    findButton(/ship forked deployment fix/i)!.click();
    await waitFor(() => root.querySelector('#merge-request-heading')?.textContent === 'Ship forked deployment fix');
    expect(root.textContent).toContain('Merge request details');
    expect(host.requests.some((request) => request.path.endsWith('/pipelines'))).toBe(false);
    expect(host.requests.some((request) => request.path.endsWith('/discussions'))).toBe(false);
    expect(host.requests.some((request) => request.path.endsWith('/jobs'))).toBe(false);

    // Load pipelines only after the user selects their visible tab.
    const pipelinesTab = findButton(/^pipelines & jobs$/i);
    expect(pipelinesTab).not.toBeNull();
    pipelinesTab!.click();
    await waitFor(() => Boolean(findButton(/501/)));
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests/39/pipelines')).toBe(true);

    // Load jobs from the selected pipeline's owning fork project, not the target project.
    findButton(/501/)!.click();
    await waitFor(() => root.textContent?.includes('test') === true);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/913/pipelines/501/jobs')).toBe(true);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/pipelines/501/jobs')).toBe(false);
  });

  // Render provider discussion content as text without replacing the real Overview.
  it('loads selected merge-request discussions on demand and renders notes as text', async () => {
    const maliciousNote = '<img src=x onerror=alert(1)> review note';
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') return response(200, [mergeRequestResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests/39') return response(200, mergeRequestResponse());
      if (request.path === '/api/v4/projects/812/merge_requests/39/discussions') {
        return response(200, [{ id: 'thread-1', notes: [{ id: 801, body: maliciousNote, author: { username: 'reviewer' } }] }]);
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Open a browsed MR and wait for its actual Overview before using the tabs.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => Boolean(findButton(/ship forked deployment fix/i)));
    findButton(/ship forked deployment fix/i)!.click();
    await waitFor(() => root.querySelector('#merge-request-heading')?.textContent === 'Ship forked deployment fix');
    expect(root.textContent).toContain('Merge request details');
    expect(host.requests.some((request) => request.path.endsWith('/discussions'))).toBe(false);

    // The discussion request must follow the selected MR, and provider text must stay inert.
    const discussionsTab = findButton(/^discussions$/i);
    expect(discussionsTab).not.toBeNull();
    discussionsTab!.click();
    await waitFor(() => root.textContent?.includes(maliciousNote) === true);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests/39/discussions')).toBe(true);
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('Ship forked deployment fix');

    // Returning to Overview and then the list must preserve the MR rather than discussion state.
    const overviewTab = findButton(/^overview$/i);
    expect(overviewTab).not.toBeNull();
    overviewTab!.click();
    expect(root.textContent).toContain('Merge request details');
    findButton(/back to merge requests/i)!.click();
    await waitFor(() => Boolean(findButton(/ship forked deployment fix/i)));
    expect(root.textContent).toContain('Ship forked deployment fix');
  });

  // Keep the explicit MR link authoritative when its session also carries a verified issue.
  it('loads the explicit session MR discussion when a verified issue is also attached', async () => {
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, []);
      if (request.path === '/api/v4/projects/812/issues/17') return response(200, issueResponse());
      if (request.path === '/api/v4/projects/812/merge_requests/39') return response(200, mergeRequestResponse());
      if (request.path === '/api/v4/projects/812/merge_requests/39/discussions') {
        return response(200, [{ id: 'linked-thread', notes: [{ id: 802, body: 'Verified linked discussion', author: { username: 'reviewer' } }] }]);
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'focused-session', title: 'Merge request session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{
          id: 'gitlab-self-managed:merge_request:73:812:39',
          data: {
            v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812,
            iid: 39, mergeRequestId: 1901,
            webUrl: 'https://gitlab.example.com/platform/infra/deploy/-/merge_requests/39',
          },
        }, {
          id: 'gitlab-self-managed:issue:73:812:17',
          data: {
            v: 1, variant: GITLAB_VARIANT_ID, accountId: 73, projectId: 812,
            iid: 17, issueId: 901, webUrl: gitLabIssue.webUrl,
          },
        }],
      }],
    };
    await prepareAssociatedProject();
    host.focusSession({ id: 'focused-session', title: 'Merge request session', busy: false });
    await waitFor(() => root.querySelector('#merge-request-heading')?.textContent === 'Ship forked deployment fix');
    expect(host.requests.filter((request) => request.path === '/api/v4/projects/812/merge_requests/39')).toHaveLength(1);
    expect(root.querySelector<HTMLElement>('#merge-request-detail')?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    expect(findButton(/open in new worktree/i)).toBeNull();

    // The explicit MR, not related-MR inference or the attached issue, authorizes this read.
    const discussionsTab = findButton(/^discussions$/i);
    expect(discussionsTab).not.toBeNull();
    discussionsTab!.click();
    await waitFor(() => root.textContent?.includes('Verified linked discussion') === true);
    expect(host.requests.some((request) => request.path === '/api/v4/projects/812/merge_requests/39/discussions')).toBe(true);
    expect(host.requests.filter((request) => /\/merge_requests\/\d+\/(?:pipelines|discussions)$/.test(request.path)))
      .toEqual([expect.objectContaining({ path: '/api/v4/projects/812/merge_requests/39/discussions' })]);
    expect(host.requests.some((request) => request.path.includes('/related_merge_requests'))).toBe(false);
    expect(host.requests.some((request) => /\/pipelines\/\d+\/jobs$/.test(request.path))).toBe(false);
    expect(host.startedSessions).toHaveLength(0);
  });

  // Reject a late section 401 after navigation leaves the request's merge-request scope.
  it('ignores a deferred discussion 401 after returning to the merge-request list', async () => {
    let resolveDiscussions!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') return response(200, [mergeRequestResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests/39') return response(200, mergeRequestResponse());
      if (request.path === '/api/v4/projects/812/merge_requests/39/discussions') {
        return new Promise((resolve) => { resolveDiscussions = resolve; });
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Start a discussion read from a browsed MR, then leave that detail before it resolves.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => Boolean(findButton(/ship forked deployment fix/i)));
    findButton(/ship forked deployment fix/i)!.click();
    await waitFor(() => root.querySelector('#merge-request-heading')?.textContent === 'Ship forked deployment fix');
    const discussionsTab = findButton(/^discussions$/i);
    expect(discussionsTab).not.toBeNull();
    discussionsTab!.click();
    await waitFor(() => Boolean(resolveDiscussions));
    findButton(/back to merge requests/i)!.click();
    await waitFor(() => Boolean(findButton(/ship forked deployment fix/i)));
    const completedDiscussionReads = host.completedRequests.filter((request) =>
      request.path === '/api/v4/projects/812/merge_requests/39/discussions').length;
    resolveDiscussions(response(401, {}));
    await waitFor(() => host.completedRequests.filter((request) =>
      request.path === '/api/v4/projects/812/merge_requests/39/discussions').length > completedDiscussionReads);
    await flushMicrotasks();

    // Confirm processing the stale 401 did not revoke the still-current account or list.
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');
    expect(root.querySelector('#association-value')?.textContent).toBe('platform/infra/deploy');
    expect(root.textContent).toContain('Ship forked deployment fix');
    expect(root.querySelector<HTMLElement>('#merge-request-detail')?.hidden).toBe(true);
  });

  // Keep all activity reads disabled while detail identity or session evidence is unresolved.
  it('does not load MR activity while the overview is pending or session focus is invalid', async () => {
    let resolveOverview!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') return response(200, [mergeRequestResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests/39') {
        return new Promise((resolve) => { resolveOverview = resolve; });
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Do not authorize auxiliary requests from a selected row before its overview verifies.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => Boolean(findButton(/ship forked deployment fix/i)));
    findButton(/ship forked deployment fix/i)!.click();
    await waitFor(() => Boolean(resolveOverview));
    expect(host.requests.some((request) => /\/merge_requests\/\d+\/(?:pipelines|discussions)$/.test(request.path))).toBe(false);
    resolveOverview(response(200, mergeRequestResponse()));
    await waitFor(() => root.querySelector('#merge-request-heading')?.textContent === 'Ship forked deployment fix');
    const staleDiscussionsTab = findButton(/^discussions$/i);
    expect(staleDiscussionsTab).not.toBeNull();

    // A contradictory session identity must not authorize activity for the former browse route.
    host.sessionsSnapshot = {
      kind: 'sessions', projectId: 'workspace-1', state: 'ready',
      coverage: [{ directory: '/repos/openchamber', state: 'ready' }],
      sessions: [{
        id: 'invalid-session', title: 'Invalid MR session', projectId: 'workspace-1', directory: '/repos/openchamber',
        parentId: null, createdAt: 1, updatedAt: 2, archivedAt: null, worktree: null,
        activity: 'idle', outcome: null,
        items: [{
          id: 'gitlab-self-managed:merge_request:73:812:39',
          data: { v: 1, variant: GITLAB_VARIANT_ID, accountId: 74, projectId: 812, iid: 39, mergeRequestId: 1901,
            webUrl: 'https://gitlab.example.com/platform/infra/deploy/-/merge_requests/39' },
        }],
      }],
    };
    const sessionReads = host.sessionsReads;
    host.focusSession({ id: 'invalid-session', title: 'Invalid MR session', busy: false });
    await waitFor(() => host.sessionsReads > sessionReads);
    await flushMicrotasks();
    staleDiscussionsTab!.click();
    await flushMicrotasks();
    expect(host.requests.some((request) => /\/merge_requests\/\d+\/(?:pipelines|discussions)$/.test(request.path))).toBe(false);
  });

  // Revoke every account resource after a current activity authorization failure, with one retry cycle.
  it('revokes account resources after an activity 401 and performs only one bounded verification retry', async () => {
    let userChecks = 0;
    let resolveReverification!: (result: GuestRequestResult) => void;
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') {
        userChecks += 1;
        return userChecks === 2
          ? new Promise((resolve) => { resolveReverification = resolve; })
          : response(200, { id: 73, username: 'maya' });
      }
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') return response(200, [mergeRequestResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests/39') return response(200, mergeRequestResponse());
      if (request.path === '/api/v4/projects/812/merge_requests/39/discussions') return response(401, {});
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();
    await waitFor(() => root.textContent?.includes('Fix deployment flow') === true);

    // Start one current activity read and keep account reverification pending.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => Boolean(findButton(/ship forked deployment fix/i)));
    findButton(/ship forked deployment fix/i)!.click();
    await waitFor(() => root.querySelector('#merge-request-heading')?.textContent === 'Ship forked deployment fix');
    const discussionsTab = findButton(/^discussions$/i);
    expect(discussionsTab).not.toBeNull();
    discussionsTab!.click();
    await waitFor(() => Boolean(resolveReverification));
    expect(userChecks).toBe(2);
    expect(root.querySelector('#account-value')?.textContent).toBe('Not connected');
    expect(root.querySelector('#association-value')?.textContent).not.toBe('platform/infra/deploy');
    expect(root.querySelector<HTMLElement>('#issue-detail')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('#merge-request-detail')?.hidden).toBe(true);

    // Restore only the verified account and prove recovery does not start a second retry cycle.
    resolveReverification(response(200, { id: 73, username: 'maya' }));
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy'
      && root.textContent?.includes('Fix deployment flow') === true);
    expect(host.requests.filter((request) => request.path === '/api/v4/user')).toHaveLength(2);

    // Fail a second current activity request after recovery; it must not start another automatic verification.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => Boolean(findButton(/ship forked deployment fix/i)));
    findButton(/ship forked deployment fix/i)!.click();
    await waitFor(() => root.querySelector<HTMLElement>('#merge-request-content')?.hidden === false
      && root.querySelector('#merge-request-heading')?.textContent === 'Ship forked deployment fix');
    findButton(/^discussions$/i)!.click();
    await waitFor(() => host.completedRequests.filter((request) =>
      request.path === '/api/v4/projects/812/merge_requests/39/discussions').length === 2);
    await flushMicrotasks();

    expect(userChecks).toBe(2);
    expect(host.requests.filter((request) => request.path === '/api/v4/user')).toHaveLength(2);
    expect(root.querySelector('#account-value')?.textContent).toBe('Not connected');
    expect(root.querySelector('#association-value')?.textContent).not.toBe('platform/infra/deploy');
  });

  // Distinguish successive A detail visits so late activity cannot repopulate A after A-to-B-to-A.
  it('ignores a deferred activity result from the first visit after an A-to-B-to-A route switch', async () => {
    let discussionAReads = 0;
    let resolveFirstA!: (result: GuestRequestResult) => void;
    const mergeRequestB = mergeRequestResponse({
      id: 1902, iid: 40, title: 'Second merge request',
      web_url: 'https://gitlab.example.com/platform/infra/deploy/-/merge_requests/40',
    });
    host = new MockHost(async (request) => {
      if (request.path === '/api/v4/user') return response(200, { id: 73, username: 'maya' });
      if (request.path === '/api/v4/projects/812') return response(200, { id: 812, path_with_namespace: 'platform/infra/deploy' });
      if (request.path === '/api/v4/projects/812/issues') return response(200, [issueResponse()]);
      if (request.path === '/api/v4/projects/812/merge_requests') return response(200, [mergeRequestResponse(), mergeRequestB]);
      if (request.path === '/api/v4/projects/812/merge_requests/39') return response(200, mergeRequestResponse());
      if (request.path === '/api/v4/projects/812/merge_requests/40') return response(200, mergeRequestB);
      if (request.path === '/api/v4/projects/812/merge_requests/39/discussions') {
        discussionAReads += 1;
        if (discussionAReads === 1) return new Promise((resolve) => { resolveFirstA = resolve; });
        return response(200, [{ id: 'fresh-a', notes: [{ id: 901, body: 'Fresh A discussion', author: { username: 'reviewer' } }] }]);
      }
      if (request.path === '/api/v4/projects/812/merge_requests/40/discussions') {
        return response(200, [{ id: 'thread-b', notes: [{ id: 902, body: 'B discussion', author: { username: 'reviewer' } }] }]);
      }
      return response(404, {});
    });
    mounted?.destroy();
    mounted = mountGitLabPanel(host, root);
    await prepareAssociatedProject();

    // Leave the first A request pending, then move through B and return to A.
    findButton(/^merge requests$/i)!.click();
    await waitFor(() => Boolean(findButton(/ship forked deployment fix/i)));
    findButton(/ship forked deployment fix/i)!.click();
    await waitFor(() => root.querySelector('#merge-request-heading')?.textContent === 'Ship forked deployment fix');
    const discussionsTab = findButton(/^discussions$/i);
    expect(discussionsTab).not.toBeNull();
    discussionsTab!.click();
    await waitFor(() => Boolean(resolveFirstA));
    findButton(/back to merge requests/i)!.click();
    await waitFor(() => Boolean(findButton(/second merge request/i)));
    findButton(/second merge request/i)!.click();
    await waitFor(() => root.querySelector('#merge-request-heading')?.textContent === 'Second merge request');
    findButton(/^discussions$/i)!.click();
    await waitFor(() => root.textContent?.includes('B discussion') === true);
    findButton(/back to merge requests/i)!.click();
    await waitFor(() => Boolean(findButton(/ship forked deployment fix/i)));
    findButton(/ship forked deployment fix/i)!.click();
    await waitFor(() => root.querySelector('#merge-request-heading')?.textContent === 'Ship forked deployment fix');
    findButton(/^discussions$/i)!.click();
    await waitFor(() => root.textContent?.includes('Fresh A discussion') === true);

    // Wait for the first bridge response and all resulting controller continuations.
    const completedAReads = host.completedRequests.filter((request) =>
      request.path === '/api/v4/projects/812/merge_requests/39/discussions').length;
    resolveFirstA(response(200, [{ id: 'stale-a', notes: [{ id: 900, body: 'Stale A discussion', author: { username: 'reviewer' } }] }]));
    await waitFor(() => host.completedRequests.filter((request) =>
      request.path === '/api/v4/projects/812/merge_requests/39/discussions').length > completedAReads);
    await flushMicrotasks();

    // A late response from the first visit must not replace the current A section.
    expect(root.textContent).toContain('Fresh A discussion');
    expect(root.textContent).not.toContain('Stale A discussion');
  });
});
