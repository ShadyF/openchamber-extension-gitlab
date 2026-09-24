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
  // Keep the search field mounted across updates so typing and focus are not interrupted.
  root.innerHTML = `
    <div class="panel">
      <header class="masthead">
        <div class="brand"><span class="brand-mark" aria-hidden="true">◆</span><span>GitLab <span class="brand-light">/ OpenChamber</span></span></div>
        <span class="eyebrow">Project association</span>
      </header>
      <section class="intro" aria-labelledby="panel-heading">
        <div class="step">01 <span aria-hidden="true">/</span> CONNECT</div>
        <h1 id="panel-heading">Choose a GitLab project<span class="heading-accent">.</span></h1>
        <p>Link this local repository to its GitLab project for issues and merge requests.</p>
      </section>
      <section class="context-card" aria-label="Current context">
        <div class="context-row"><span class="context-label">Connected account</span><strong id="account-value" class="context-value"></strong></div>
        <div class="context-row"><span class="context-label">Local repository</span><strong id="repository-value" class="context-value"></strong></div>
        <div class="context-row"><span class="context-label">Directory</span><span id="directory-value" class="context-value path-value"></span></div>
      </section>
      <p class="connection-help">Connect an account or view the configured GitLab host in <strong>Settings → Integrations</strong>.</p>
      <section class="selection" aria-labelledby="project-heading">
        <div class="section-title"><span class="step">02 <span aria-hidden="true">/</span> SELECT</span><h2 id="project-heading">GitLab project</h2></div>
        <div id="association-wrap" class="association-wrap" hidden><span class="small-label" id="association-label">Current association</span><div class="association-row"><strong id="association-value" class="association-value"></strong><button type="button" id="remove-button" class="text-button">Remove</button></div></div>
        <label class="search-label" for="project-search">Search by project name or full namespace</label>
        <div class="search-wrap"><span class="search-icon" aria-hidden="true">⌕</span><input id="project-search" type="search" placeholder="e.g. team / platform / app" autocomplete="off" spellcheck="false" aria-controls="project-results" aria-describedby="search-hint" /><span id="searching-indicator" class="searching-indicator" hidden>Searching…</span></div>
        <p id="search-hint" class="hint">Use ↑ and ↓ to move through results, then Enter to choose.</p>
        <div id="project-results" class="results" aria-label="GitLab projects"></div>
        <div id="error-box" class="error-box" role="alert" hidden><span id="error-text"></span><button type="button" id="retry-button" class="text-button">Retry</button></div>
        <p id="save-hint" class="save-hint"></p>
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
  const removeButton = get<HTMLButtonElement>('remove-button');
  const search = get<HTMLInputElement>('project-search');
  const searchingIndicator = get<HTMLElement>('searching-indicator');
  const results = get<HTMLElement>('project-results');
  const errorBox = get<HTMLElement>('error-box');
  const errorText = get<HTMLElement>('error-text');
  const retryButton = get<HTMLButtonElement>('retry-button');
  const saveHint = get<HTMLElement>('save-hint');
  const status = get<HTMLElement>('panel-status');
  let current: PanelState | null = null;

  // Route all UI events through the supplied actions; the host owns persistence and search.
  const onSearch = () => actions.search(search.value);
  const onRemove = () => {
    if (current?.canRemove) actions.remove();
  };
  const onRetry = () => actions.retry();
  const onSearchKeydown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      const first = results.querySelector<HTMLButtonElement>('button');
      if (first) { event.preventDefault(); first.focus(); }
    }
  };
  const onResultsKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(results.querySelectorAll<HTMLButtonElement>('button'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = index + (event.key === 'ArrowDown' ? 1 : -1);
    (buttons[next] ?? (next < 0 ? search : buttons[buttons.length - 1]))?.focus();
  };
  search.addEventListener('input', onSearch);
  search.addEventListener('keydown', onSearchKeydown);
  results.addEventListener('keydown', onResultsKeydown);
  removeButton.addEventListener('click', onRemove);
  retryButton.addEventListener('click', onRetry);

  return {
    render(state) {
      current = state;

      // Show only confirmed context; never infer a host or imply an unknown directory is permanent.
      account.textContent = state.account ?? 'Not connected';
      repository.textContent = state.repository ?? 'Not detected';
      directory.textContent = state.directory ?? 'Unknown directory';
      associationWrap.hidden = !state.association;
      associationLabel.textContent = state.isUnknown ? 'Choice for this session' : 'Current association';
      associationValue.textContent = state.association?.path ?? '';
      removeButton.textContent = state.isUnknown ? 'Clear choice' : 'Remove';
      removeButton.disabled = !state.canRemove || state.busy;
      searchingIndicator.hidden = !state.searching;
      errorBox.hidden = !state.error;
      errorText.textContent = state.error ?? '';
      retryButton.disabled = state.busy;
      status.textContent = state.status || (state.searching ? 'Searching projects…' : state.busy ? 'Working…' : '');
      status.hidden = !status.textContent;

      // Rebuild only the result buttons, using text nodes for untrusted project paths.
      const activeId = document.activeElement instanceof HTMLElement && results.contains(document.activeElement)
        ? document.activeElement.dataset.projectId : null;
      results.replaceChildren();
      if (!state.projects.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-results';
        empty.textContent = state.searching ? 'Looking for projects…' : state.error ? 'Projects are unavailable.' : search.value.trim() ? 'No matching projects. Try a different name or namespace.' : 'Start typing to find a GitLab project.';
        results.append(empty);
      } else {
        for (const project of state.projects) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'result-button';
          button.dataset.projectId = String(project.id);
          button.setAttribute('aria-pressed', String(project.id === state.selectedId));
          button.disabled = !state.canSave || state.busy;
          button.setAttribute('aria-label', `${state.isUnknown ? 'Use for this session' : 'Save association with'}: ${project.path}`);
          const path = document.createElement('span');
          path.className = 'result-path';
          path.textContent = project.path;
          const choice = document.createElement('span');
          choice.className = 'result-choice';
          choice.setAttribute('aria-hidden', 'true');
          choice.textContent = project.id === state.selectedId ? 'Selected ✓' : state.isUnknown ? 'Use for this session ↗' : 'Save ↗';
          button.append(path, choice);
          button.addEventListener('click', () => {
            if (current?.canSave && !current.busy) actions.save(project.id);
          });
          results.append(button);
        }
      }
      if (activeId) results.querySelector<HTMLButtonElement>(`[data-project-id="${activeId}"]`)?.focus();

      // Explain whether a project choice will persist beyond this session.
      saveHint.textContent = state.isUnknown
        ? 'This directory is not registered. Choosing a project uses it for this session only.'
        : 'Choose a project to save it for this local repository and its worktrees.';
    },
    destroy() {
      // Remove event handlers before clearing the panel so remounting cannot duplicate actions.
      search.removeEventListener('input', onSearch);
      search.removeEventListener('keydown', onSearchKeydown);
      results.removeEventListener('keydown', onResultsKeydown);
      removeButton.removeEventListener('click', onRemove);
      retryButton.removeEventListener('click', onRetry);
      root.replaceChildren();
      current = null;
    },
  };
}
