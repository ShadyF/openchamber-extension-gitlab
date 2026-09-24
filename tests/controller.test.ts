import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { GuestConnection, GuestProjectsSnapshot, GuestRequest, GuestRequestResult, GuestWorktreesSnapshot, HostClient, HostReadyContext, JsonValue } from '@openchamber/sdk';
import { HostRequestError } from '@openchamber/sdk';
import { Window } from 'happy-dom';
import { mountGitLabPanel, type GitLabPanelHost } from '../src/controller.js';
import { writeAssociation } from '../src/association.js';
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

function response(status: number, value: unknown): GuestRequestResult {
  return { status, body: JSON.stringify(value) };
}

// Model only the host contract used by the mounted panel, with controllable API responses.
class MockHost implements GitLabPanelHost {
  readonly requests: GuestRequest[] = [];
  readonly storedValues = new Map<string, JsonValue>();
  readonly readyListeners: Array<(context: HostReadyContext) => void> = [];
  readonly directoryListeners: Array<(directory: string | null) => void> = [];
  readonly connectionListeners: Array<(connection: GuestConnection) => void> = [];
  readonly requestHandler: (request: GuestRequest) => Promise<GuestRequestResult>;
  storedWrites = 0;
  storageDeletes = 0;
  directory = '/repos/openchamber';
  connection: GuestConnection = { connected: true, account: 'maya' };
  projectsSnapshot = projects;
  worktreesSnapshot = worktrees;

  readonly storage: HostClient['storage'] = {
    // Read and write scoped values through the same in-memory namespace.
    get: async (key) => this.storedValues.get(key),
    set: async (key, value) => {
      this.storedWrites += 1;
      this.storedValues.set(key, value);
    },

    // Track removals so tests can prove which actions reached persistent storage.
    delete: async (key) => {
      this.storageDeletes += 1;
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

      return response(404, {});
    });
  }

  // Record every request at the same mocked host bridge used by the controller.
  async request(request: GuestRequest): Promise<GuestRequestResult> {
    this.requests.push(request);
    return this.requestHandler(request);
  }

  // Return the current registered local repositories snapshot.
  async listProjects(): Promise<GuestProjectsSnapshot> {
    return this.projectsSnapshot;
  }

  // Return ready worktree records for the requested registered repository.
  async listWorktrees(projectId: string): Promise<GuestWorktreesSnapshot> {
    return { ...this.worktreesSnapshot, projectId };
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

  // Deliver a host-ready snapshot to all mounted controller listeners.
  ready(directory: string | null = this.directory, connection = this.connection): void {
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

// Dispatch input the same way a mounted panel receives a user search.
function enterSearch(query: string): void {
  const input = root.querySelector<HTMLInputElement>('#project-search')!;
  input.value = query;
  input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
}

// Exercise the real panel DOM against a mocked OpenChamber host bridge.
describe('mounted GitLab panel controller', () => {
  // Mount a fresh document and host so each visible-state assertion is isolated.
  beforeEach(() => {
    browser = new Window();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document });
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: browser.HTMLElement });
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

    expect(host.requests.map((request) => request.path)).toEqual([
      '/api/v4/user',
      '/api/v4/projects',
      '/api/v4/projects/812',
      '/api/v4/user',
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

    expect(root.querySelector('#repository-value')?.textContent).toBe('OpenChamber');
    expect(root.querySelector('#directory-value')?.textContent).toBe('/repos/openchamber/.worktrees/fix');
    expect(host.requests.map((request) => request.path)).toEqual(['/api/v4/user', '/api/v4/projects/812']);
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

    expect(root.querySelector('#association-wrap')?.hasAttribute('hidden')).toBe(true);
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

    expect(root.querySelector('#association-wrap')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('#error-text')?.textContent).toContain('could not find this project');
    expect(host.requests.map((request) => request.path)).toEqual(['/api/v4/user', '/api/v4/projects/812']);
  });

  // Keep an unregistered session choice visible without writing it to host storage.
  it('keeps unknown-directory choices session-only and clears them without storage writes', async () => {
    host.ready('/tmp/unregistered-session');
    await waitFor(() => root.querySelector('#account-value')?.textContent === 'maya');
    expect(root.querySelector('#save-hint')?.textContent).toContain('session only');
    expect(root.querySelector('#panel-status')?.textContent).toContain('not registered in OpenChamber');

    enterSearch('deploy');
    await waitFor(() => Boolean(root.querySelector('#project-results button')));
    root.querySelector<HTMLButtonElement>('#project-results button')!.click();
    await waitFor(() => root.querySelector('#association-value')?.textContent === 'platform/infra/deploy');

    expect(root.querySelector('#association-label')?.textContent).toBe('Choice for this session');
    expect(root.querySelector('#panel-status')?.textContent).toContain('session only');
    expect(host.storedWrites).toBe(0);

    root.querySelector<HTMLButtonElement>('#remove-button')!.click();
    await waitFor(() => root.querySelector('#association-wrap')?.hasAttribute('hidden') === true);
    expect(host.storageDeletes).toBe(0);
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
    expect(root.querySelector('#association-wrap')?.hasAttribute('hidden')).toBe(true);
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

    expect(root.querySelector('#association-wrap')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('#project-results button')).toBeNull();
    expect(host.requests.map((request) => request.path)).toEqual([
      '/api/v4/user',
      '/api/v4/projects',
      '/api/v4/projects/812',
      '/api/v4/user',
    ]);
    expect(host.storedWrites).toBe(1);
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
    expect(root.querySelector('#association-wrap')?.hasAttribute('hidden')).toBe(true);
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
    await waitFor(() => root.querySelector('#panel-status')?.textContent.includes('not registered in OpenChamber') === true);

    expect(host.storedWrites).toBe(0);
    expect(root.querySelector('#association-wrap')?.hasAttribute('hidden')).toBe(true);
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
});
