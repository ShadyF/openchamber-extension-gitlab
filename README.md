# OpenChamber GitLab extension

This extension associates an OpenChamber local repository or registered worktree with a GitLab project visible to the connected account. It browses that project's open issues and merge requests and can start an issue-linked worktree session for a registered repository. Project, issue, and merge-request browsing are read-only. Associations use isolated native extension storage and are scoped by local repository ID, numeric GitLab account ID, and a fixed self-managed variant. The user's GitLab profile `web_url` is not the authoritative API host or an instance variant.

The GitLab access token stays in OpenChamber's protected integration storage. The extension never reads or stores the token and never calls `fetch`; API requests use the host's `host.request` bridge, which supplies bearer authorization, enforces the configured HTTPS origin, and does not follow redirects.

The manifest requests the SDK's `sessions` capability for registered project and worktree snapshots, session snapshots used to verify issue links, and issue-linked session/worktree creation and navigation. It does not request conversation-content permission. Starting a worktree does not send a model prompt or automatically start an agent turn.

## Build and test

Use Bun 1.3.14 with the repository's Dev Container. Set `WORKSPACE` to the absolute path of your checkout; the path will vary by environment:

```sh
WORKSPACE=/absolute/path/to/openchamber-extension-gitlab
devcontainer up --workspace-folder "$WORKSPACE"
devcontainer exec --workspace-folder "$WORKSPACE" bun install --frozen-lockfile
devcontainer exec --workspace-folder "$WORKSPACE" bun run typecheck
devcontainer exec --workspace-folder "$WORKSPACE" bun test
devcontainer exec --workspace-folder "$WORKSPACE" bun run build
```

The build creates the tracked classic IIFE at `panel/main.js` and validates the OpenChamber manifest and package entry. Do not ship `node_modules` or the development-only TypeScript sources.

## Compatibility verification

The maintainer reports manually passing the earlier issue #16 flow checks in OpenChamber web v2.0.0 and desktop v2.0.0. This historical, maintainer-reported release gate is not independent automated verification and does not validate the newer Issues, Setup, or worktree flow. The manifest's `>=2.0.0` engine floor reflects that report.

## Configure a self-managed GitLab host

`https://gitlab.invalid` is a safe placeholder, not a usable GitLab address. Before installation, replace `openchamber.contributes.integration.token.apiOrigin` in `package.json` with that instance's bare HTTPS origin (for example, `https://gitlab.example.net`). Changing only this manifest value does not require rebuilding `panel/main.js`; if distributing a ZIP, recreate the ZIP with the edited manifest. Do not include a path, query, token, or credentials in the origin. For the current read-only GitLab calls, create a personal access token (PAT) with `read_api` for project and issue data and `read_user` for documented `/user` verification, then enter it only through the protected credential field in OpenChamber Settings → Integrations. An existing `api`-scoped token also works but grants more access than this slice needs; future merge-request creation would require write-capable access. Do not put a token in `package.json`, the panel, or these instructions. The panel relies on the native integration settings for host information rather than displaying a second, potentially stale host value.

The configured API origin is immutable after installation; editing it in place is unsupported. To replace the GitLab host, use this order:

1. Remove the installed GitLab extension in Settings → Extensions.
2. Configure the bare HTTPS origin in `package.json` and, if using a ZIP, package the edited files again.
3. Reinstall the updated extension.
4. Reconnect GitLab in Settings → Integrations with a token for the new host.
5. Reopen the panel and reselect the GitLab project association. Removing the extension clears its isolated native storage, including prior mappings.

Disabling or disconnecting the integration, updating the installed extension, or editing its installed origin does not replace the configured host. Remove and reinstall as above instead; this clears existing mappings. The host does not follow API redirects, so configure the final HTTPS origin directly. If the self-managed GitLab server uses a private CA, ensure that the actual OpenChamber backend or runtime executing `host.request` trusts that CA. Browser-only certificate trust is insufficient. Do not disable TLS validation or use HTTP. Transport, TLS, redirect, authorization, and missing-project failures are reported without exposing token or response contents.

Replacing an installed extension with a ZIP is not an atomic update: it clears extension storage and permission grants. Recheck the GitLab connection and grant permissions again if prompted; do not assume authentication or associations survive replacement.

## Association behavior

- The panel resolves a directory only by exact equality with ready OpenChamber project and worktree snapshots. Incomplete or ambiguous snapshots disable actions.
- A directory not present in complete snapshots is marked unknown. Selecting a project for it applies only to the current panel session and is never persisted.
- Registered projects and their worktrees share a mapping. Changing the connected GitLab account selects a different storage scope; replacing the installed host clears extension storage and requires a new selection.
- Search results use GitLab's full `path_with_namespace` and stable numeric project IDs. A selected project is fetched again by ID before the association is saved.

## Browse issues and start a worktree

Connect GitLab in Settings → Integrations, then open the panel. If no project is associated, Setup offers a project chooser; without a connection, Setup asks you to connect first. Select a project to browse its open issues, load more pages, and open an issue's detail. Issue text is displayed as text, not executed as HTML. A verified issue link in the active session brings that issue into focus.

For a registered repository, select **Open in new worktree** from an issue. The extension asks OpenChamber to create a session with the issue attached, then opens the confirmed session. It does not send an opening message or start the agent. Unknown directories can browse issues with a session-only project choice, but cannot start a worktree.

Merge-request detail has **Overview**, **Pipelines & jobs**, and **Discussions** sections. Pipelines and their jobs are fetched with bounded requests; jobs are requested using the pipeline's returned project ID. Discussions load on demand and support bounded pagination. Each activity section—Pipelines & jobs and Discussions—handles loading, empty, unavailable, truncated, and error states independently, with retry where applicable. Activity is authorized only for the matching verified merge request visible in the workspace. The views are read-only; they do not provide job logs or artifacts, merge-request creation or review actions, branch push, GitLab.com multi-host support, or the PR Review Magic Prompt. An explicit session merge-request link stored by the extension takes focus when verified. When a session is verified as linked to an issue, the extension checks GitLab's related-merge-requests endpoint across bounded pages; exactly one visible opened result is shown as related, not explicitly linked. Ambiguous or incomplete results and API or permission failures leave the issue in focus. Results can include merge requests mentioned in issue comments, and cannot prove that no inaccessible matches exist. If worktree creation times out or only partly succeeds, a persistent recovery record blocks another attempt. Check the recorded outcome before trying again; manually releasing the record can permit a duplicate if the earlier attempt finishes later.
