export interface PanelState {
  account: string | null;
  directory: string | null;
  repository: string | null;
  association: { id: number; path: string } | null;
  projects: Array<{ id: number; path: string }>;
  selectedId: number | null;
  busy: boolean;
  searching: boolean;
  status: string;
  error: string | null;
  canSave: boolean;
  canRemove: boolean;
  isUnknown: boolean;
}

export interface PanelActions {
  search(query: string): void;
  save(projectId: number): void;
  remove(): void;
  retry(): void;
}

export function createPanel(root: HTMLElement, actions: PanelActions): { render(state: PanelState): void; destroy(): void } {
  // Mount a compact settings-like layout once so host updates do not interrupt the search field.
  root.innerHTML = `
    <div class="panel">
      <header class="panel-header">
        <h1>GitLab project</h1>
        <p>Choose the GitLab project for this local repository.</p>
      </header>
      <section class="context" aria-label="Connection and local repository">
        <div class="context-line"><span>Account</span><strong id="account-value"></strong></div>
        <div class="context-line"><span>Local repository</span><strong id="repository-value"></strong></div>
        <div class="context-line"><span>Directory</span><span id="directory-value" class="directory-value"></span></div>
        <p class="settings-note">Manage the connection and configured host in <strong>Settings → Integrations</strong>.</p>
      </section>
      <section class="association" id="association-wrap" aria-label="Current project association" hidden>
        <div class="section-label" id="association-label">Current association</div>
        <div class="association-line"><strong id="association-value"></strong><span id="remove-slot"></span></div>
      </section>
      <section class="project-picker" aria-labelledby="project-heading">
        <div class="section-heading"><h2 id="project-heading">Find a project</h2><span id="searching-indicator" hidden>Searching…</span></div>
        <input id="project-search" class="project-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search projects…" aria-label="Search GitLab projects by name or full namespace" aria-controls="project-results" aria-describedby="search-hint" />
        <p id="search-hint" class="helper">Search by project name or full namespace. Arrow keys and Enter choose a result.</p>
        <div id="project-results" class="project-results" role="group" aria-label="GitLab projects"></div>
        <div id="error-box" class="error-box" role="alert" hidden><span id="error-text"></span><button id="retry-button" class="quiet-button" type="button">Retry</button></div>
        <p id="save-hint" class="helper"></p>
      </section>
      <p id="panel-status" class="panel-status" role="status" aria-live="polite"></p>
    </div>`;

  const get = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;
  const account = get<HTMLElement>('account-value');
  const repository = get<HTMLElement>('repository-value');
  const directory = get<HTMLElement>('directory-value');
  const associationWrap = get<HTMLElement>('association-wrap');
  const associationLabel = get<HTMLElement>('association-label');
  const associationValue = get<HTMLElement>('association-value');
  const removeSlot = get<HTMLElement>('remove-slot');
  const removeButton = document.createElement('button');
  removeButton.id = 'remove-button';
  removeButton.type = 'button';
  removeButton.className = 'quiet-button';
  removeSlot.append(removeButton);
  const searchInput = get<HTMLInputElement>('project-search');
  const searchingIndicator = get<HTMLElement>('searching-indicator');
  const results = get<HTMLElement>('project-results');
  const errorBox = get<HTMLElement>('error-box');
  const errorText = get<HTMLElement>('error-text');
  const retryButton = get<HTMLButtonElement>('retry-button');
  const saveHint = get<HTMLElement>('save-hint');
  const status = get<HTMLElement>('panel-status');
  let current: PanelState | null = null;
  let query = '';

  // Forward edits while preserving the input and its focus across controller renders.
  const onInput = () => {
    query = searchInput.value;
    actions.search(query);
  };
  const onRemove = () => {
    if (current?.canRemove && !current.busy) actions.remove();
  };
  const onRetry = () => actions.retry();
  const onSearchKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' || !current?.projects.some(project => current?.canSave && !current?.busy)) return;
    event.preventDefault();
    results.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };
  const onResultsKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(results.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    (buttons[next] ?? (next < 0 ? searchInput : buttons[buttons.length - 1]))?.focus();
  };
  searchInput.addEventListener('input', onInput);
  searchInput.addEventListener('keydown', onSearchKeydown);
  results.addEventListener('keydown', onResultsKeydown);
  removeButton.addEventListener('click', onRemove);
  retryButton.addEventListener('click', onRetry);

  return {
    render(state) {
      current = state;

      // Show verified context and distinguish saved associations from session-only choices.
      account.textContent = state.account ?? 'Not connected';
      repository.textContent = state.repository ?? 'Not detected';
      directory.textContent = state.directory ?? 'Unknown';
      associationWrap.hidden = !state.association;
      associationLabel.textContent = state.isUnknown ? 'Choice for this session' : 'Current association';
      associationValue.textContent = state.association?.path ?? '';
      removeButton.textContent = state.isUnknown ? 'Clear choice' : 'Remove';
      removeButton.disabled = !state.canRemove || state.busy;

      // Keep results and actions synchronized with the controller without rendering project paths as HTML.
      searchingIndicator.hidden = !state.searching;
      const activeId = document.activeElement instanceof HTMLElement && results.contains(document.activeElement)
        ? document.activeElement.dataset.projectId : null;
      results.replaceChildren();
      if (!state.projects.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-results';
        empty.textContent = state.searching ? 'Searching projects…' : state.error ? 'Projects are unavailable.'
          : query.trim() ? 'No matching projects. Try another name or namespace.' : 'Search to find a GitLab project.';
        results.append(empty);
      } else {
        for (const project of state.projects) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'project-row';
          button.dataset.projectId = String(project.id);
          button.setAttribute('aria-pressed', String(project.id === state.selectedId));
          button.disabled = !state.canSave || state.busy;
          const path = document.createElement('span');
          path.className = 'project-path';
          path.textContent = project.path;
          const action = document.createElement('span');
          action.className = 'project-action';
          action.textContent = project.id === state.selectedId ? 'Selected' : state.isUnknown ? 'Use for this session' : 'Choose';
          button.append(path, action);
          button.addEventListener('click', () => {
            if (current?.canSave && !current.busy) actions.save(project.id);
          });
          results.append(button);
        }
      }
      if (activeId) results.querySelector<HTMLButtonElement>(`[data-project-id="${activeId}"]`)?.focus();
      errorBox.hidden = !state.error;
      errorText.textContent = state.error ?? '';
      retryButton.disabled = state.busy;
      saveHint.textContent = state.isUnknown
        ? 'This directory is not registered. A choice applies to this session only.'
        : 'Choosing a project saves it for this local repository and its worktrees.';
      status.textContent = state.status || (state.searching ? 'Searching projects…' : state.busy ? 'Working…' : '');
      status.hidden = !status.textContent;
    },
    destroy() {
      // Release event handlers before removing the panel.
      searchInput.removeEventListener('input', onInput);
      searchInput.removeEventListener('keydown', onSearchKeydown);
      results.removeEventListener('keydown', onResultsKeydown);
      removeButton.removeEventListener('click', onRemove);
      retryButton.removeEventListener('click', onRetry);
      root.replaceChildren();
      current = null;
    },
  };
}
