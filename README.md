# OpenChamber GitLab extension

This extension associates an OpenChamber local repository or registered worktree with a GitLab project visible to the connected account. Project search is read-only. Associations use isolated native extension storage and are scoped by local repository ID, numeric GitLab account ID, and a fixed self-managed variant. The user's GitLab profile `web_url` is not the authoritative API host or an instance variant.

The GitLab access token stays in OpenChamber's protected integration storage. The extension never reads or stores the token and never calls `fetch`; API requests use the host's `host.request` bridge, which supplies bearer authorization, enforces the configured HTTPS origin, and does not follow redirects.

The manifest requests the SDK's `sessions` capability because OpenChamber gates registered project and worktree snapshots behind it. The extension calls only `listProjects` and `listWorktrees`; it does not request session snapshots or conversation content.

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

## Configure a self-managed GitLab host

`https://gitlab.invalid` is a safe placeholder, not a usable GitLab address. Before installation, replace `openchamber.contributes.integration.token.apiOrigin` in `package.json` with that instance's bare HTTPS origin (for example, `https://gitlab.example.net`). Changing only this manifest value does not require rebuilding `panel/main.js`; if distributing a ZIP, recreate the ZIP with the edited manifest. Do not include a path, query, token, or credentials in the origin. Create a GitLab personal access token (PAT) with the `api` scope and enter it only through the protected credential field in OpenChamber Settings → Integrations. Do not put a token in `package.json`, the panel, or these instructions. The panel relies on the native integration settings for host information rather than displaying a second, potentially stale host value.

The configured API origin is immutable after installation; editing it in place is unsupported. To replace the GitLab host, use this order:

1. Remove the installed GitLab extension in Settings → Extensions.
2. Configure the bare HTTPS origin in `package.json` and, if using a ZIP, package the edited files again.
3. Reinstall the updated extension.
4. Reconnect GitLab in Settings → Integrations with a token for the new host.
5. Reopen the panel and reselect the GitLab project association. Removing the extension clears its isolated native storage, including prior mappings.

Disabling or disconnecting the integration, updating the installed extension, or editing its installed origin does not replace the configured host. Remove and reinstall as above instead; this clears existing mappings. The host does not follow API redirects, so configure the final HTTPS origin directly. If the self-managed GitLab server uses a private CA, ensure that the actual OpenChamber backend or runtime executing `host.request` trusts that CA. Browser-only certificate trust is insufficient. Do not disable TLS validation or use HTTP. Transport, TLS, redirect, authorization, and missing-project failures are reported without exposing token or response contents.

## Association behavior

- The panel resolves a directory only by exact equality with ready OpenChamber project and worktree snapshots. Incomplete or ambiguous snapshots disable actions.
- A directory not present in complete snapshots is marked unknown. Selecting a project for it applies only to the current panel session and is never persisted.
- Registered projects and their worktrees share a mapping. Changing the connected GitLab account selects a different storage scope; replacing the installed host clears extension storage and requires a new selection.
- Search results use GitLab's full `path_with_namespace` and stable numeric project IDs. A selected project is fetched again by ID before the association is saved.
