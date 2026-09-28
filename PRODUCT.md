# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The extension panel is web-rendered inside OpenChamber's web and desktop applications; it is not a standalone website.

## Users

Developers working in OpenChamber with local repositories or registered worktrees that correspond to GitLab projects. They need to connect their coding workspace to the right GitLab project and, in the broader product direction, use GitLab issues and merge requests as work context.

## Product Purpose

Make GitLab work available in the OpenChamber workflow without sending users to a separate extension interface. In current source, users can associate a visible GitLab project, browse its open issues and merge requests, start an issue-linked worktree session for a registered repository, and focus verified session merge-request links. Merge-request detail includes read-only Overview, Pipelines & jobs, and Discussions sections. For a verified issue-linked session, one visible opened related merge request may be focused and is labeled related rather than explicitly linked. Merge-request creation/review, branch push, job logs/artifacts, the PR Review Magic Prompt, and GitLab.com multi-host support remain future direction.

## Positioning

The association is anchored to OpenChamber's local repository and registered-worktree context, rather than asking users to manage a separate workspace mapping. A registered repository and its worktrees share the same association.

## Operating Context

- The user opens the extension in OpenChamber's right-side panel. GitLab credentials are configured through OpenChamber Settings → Integrations, not entered in the panel.
- The current extension targets one configured self-managed GitLab HTTPS origin per installation. Replacing that origin requires removing and reinstalling the extension, reconnecting the account, and selecting associations again.
- OpenChamber's project and worktree snapshots identify registered local repositories. An unknown directory can receive a panel-session-only choice, not a persistent association.
- Use **local repository** for the OpenChamber workspace, **GitLab project** for the GitLab repository and its issues and merge requests, **GitLab connection** for the authorized account and instance, and **project association** for the chosen default mapping. **Session context item** names a GitLab issue or merge request associated with an OpenChamber message or session; verified issue and merge-request focus are implemented.

## Capabilities and Constraints

- **Implemented in source:** Connected Setup and project association; an extracted associated-project workspace with a compact repository strip, GitLab work hierarchy, real paginated open-Issues list with Open/Issue/date metadata, project-scoped MR search with bounded pagination, and full-width issue/MR detail. MR detail has read-only Overview (title, state, description, branches, URL), Pipelines & jobs, and Discussions sections. Pipeline and discussion data load lazily with bounded pagination; jobs are requested from the pipeline's returned project ID. Each activity section has independent scope, loading, empty, unavailable, truncation, error, and retry behavior. Activity is authorized only for the matching verified MR visible in the workspace. Also implemented: Back navigation, visible Change project/Cancel; verified session-linked issue and MR focus; related-MR discovery after a verified issue link across bounded pages, focusing one visible opened result as related and falling back to the issue on ambiguity, incomplete results, or errors; issue-linked worktree creation for registered repositories without an automatic agent turn. No fake Filter or Assigned-to-you controls are present. Unknown directories can browse with a session-only choice but cannot create a worktree. One persistent recovery record blocks another creation after an uncertain or partial result until checked or manually released. Phase-2 source validation passes 206 tests across 12 files, typecheck, standard bundle, package validation, and `git diff --check`. Initial remote Browserless static production-DOM checks at 360/740 were parse-validated: 25 had no element clipping, while one long project identity clipped at 360. After a CSS-only wrapping fix, six targeted affected/control cases passed at 320/360/740; the full 26 cases were not rerun. These are source previews, not live OpenChamber/GitLab verification. The installed panel bundle matches current `panel/main.js` (SHA-256 `efccd04b2adc688d2febd3ea3bc27b29c5ded58d698486ca8aa16c1078bbbc5`), but this does not verify the ZIP enabled state, permission grants, GitLab connection, saved project association, connected issues or merge requests, worktree behavior, or live visual QA; replacing the ZIP would clear extension storage and permission grants, so deployment requires separate authorization and rollback planning.
- **Future direction, not current capability:** MR creation/review actions, branch push, job logs/artifacts, PR Review Magic Prompt, and GitLab.com multi-host support. The current manifest supports one configured self-managed HTTPS origin per installation; OpenChamber SDK v2.0.0 cannot register or invoke Magic Prompts.
- The token stays in OpenChamber's protected integration storage. The extension uses the host request bridge rather than direct browser requests and does not read or store the token. The `sessions` permission supports repository, worktree, and session snapshots and session creation/navigation; it does not grant conversation-content access.
- The interface must feel native to OpenChamber: use the host's panel conventions, theme behavior, and SDK UI controls where applicable. The OpenChamber Docker extension is an integration reference, not a requirement to copy its features or appearance.

## Brand Commitments

Use the OpenChamber GitLab extension name and fit its host product rather than establishing an unrelated standalone identity. Keep the interface's language direct and task-focused. The approved list-to-detail and Setup arrangement is recorded in `DESIGN.md` and prototype A; colors and typography follow OpenChamber's host theme rather than a separate visual identity.

## Evidence on Hand

- `README.md` describes current source behavior, security boundaries, installation constraints, and historical maintainer-reported manual checks in OpenChamber web and desktop v2.0.0. Those checks do not verify the newer Issues/MR/worktree flow.
- `CONTEXT.md` defines the product's repository, project, connection, association, and session-context terminology.
- `package.json`, `src/` (including `src/gitlab.ts`, `src/merge-request-activity.ts`, `src/controller.ts`, and `src/workspace.ts`), and `panel/` contain the current manifest, integration logic, and embedded panel. Phase-2 source validation passes 206 tests across 12 files, typecheck, standard bundle, package validation, and `git diff --check`. Initial remote Browserless static production-DOM checks at 360/740 were parse-validated: 25 had no element clipping and one long project identity clipped at 360. Six targeted affected/control cases passed after a CSS-only wrapping fix at 320/360/740; the full 26 cases were not rerun. These are source previews, not live-panel verification. No separate customer claims are established in this repository.

## Product Principles

- Make GitLab context available within the OpenChamber workflow, rather than creating a separate product experience.
- Follow the host's native integration and protect credentials through its established boundaries.
- Distinguish the local repository from the GitLab project and make the association explicit.
- Keep implemented capabilities and future GitLab workflows clearly separate until they are delivered.
