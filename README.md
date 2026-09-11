# Indexary

**An open-source, local-first web interface for exploring filesystem-based knowledge bases.**

> Project status: the complete read-only Atlas is verified for daily use from this
> checkout. Immutable per-user releases and the systemd user-service lifecycle are
> implemented. Safe deploy/rollback, Tailscale activation, and the human production
> checkpoint remain pending.

## Overview

Indexary is a lightweight web interface for browsing and searching personal knowledge stored as ordinary files. It is a presentation and discovery layer: it does not own the knowledge base, introduce a proprietary storage format, or depend on a specific vault application.

Markdown documents, frontmatter, links, folders, and attachments remain the source of truth. Any local tool can modify them, while Indexary reflects those changes in its interface.

## Initial scope

The first version is intentionally read-only. Editing and knowledge maintenance happen outside the application, initially through Hermes Agent.

The interface is expected to provide:

- navigation through folders and documents;
- full-text search;
- rendered Markdown;
- document metadata and tags;
- links and backlinks;
- attachment browsing;
- automatic refresh when source files change.

## Architecture

```text
Browser
   │
   ▼
React application
   │  HTTP + SSE
   ▼
Fastify server
   ├── filesystem-based knowledge base
   └── rebuildable search and metadata index
```

Architectural principles:

- The filesystem is the source of truth.
- Any database or search index is derived and can be rebuilt.
- The frontend does not access the filesystem directly.
- The initial API is read-only.
- External file changes are detected by the server and propagated to the interface.
- The production frontend and API are served from the same origin.
- The project remains independent of Hermes, Obsidian, and any particular vault layout.

## Technology stack

### Frontend

- React
- TypeScript
- Vite
- shadcn/ui
- Tailwind CSS
- TanStack Router
- TanStack Query

### Backend

- Node.js
- TypeScript
- Fastify
- TypeBox for request and response validation

## Access model

Indexary is intended to run on a user-controlled machine.

- The application server listens on localhost by default.
- Remote access is provided through Tailscale rather than a publicly exposed application port.
- The preferred deployment model is Fastify bound to `127.0.0.1`, with Tailscale Serve providing HTTPS access inside the user's tailnet.

Authentication and public internet deployment are outside the initial scope.

## Non-goals for the first version

- Built-in document editing
- A proprietary note or database format
- Multi-user collaboration
- Public publishing
- Synchronization between devices
- AI chat or semantic search
- A plugin system
- Replacing existing knowledge-management tools

## Future direction

Possible later capabilities include semantic search, additional filesystem-based formats, multiple knowledge sources, configurable metadata views, and agent-oriented integration points. These should remain optional layers over user-owned data.

## Project documentation

- [Domain language](CONTEXT.md)
- [Development process](docs/development.md)
- [Initial operating model](docs/operations.md)
- [Architecture decisions](docs/adr/)

## Development

Install the pinned toolchain with `mise install`, then use the public task interface:

- `mise run dev` starts the synthetic fixture on loopback;
- `mise run dev:kb -- <path>` starts against one explicitly selected personal Knowledge Base;
- `mise run test` runs unit and assembled-server integration tests;
- `mise run build` creates the optimized same-origin application;
- `mise run check` runs formatting, linting, types, focused tests, assembled Fastify
  integration tests, the optimized build, and the short browser smoke;
- `mise run perf:index` checks the generated 10,000-Document support target;
- `mise run smoke:kb`, with an existing non-empty `INDEXARY_KB_PATH`, starts
  the privacy-safe manual personal smoke and verifies that the selected
  Knowledge Base has the same bytes after the session;
- `mise run release` assembles a clean commit as an immutable release containing
  the exact Node 24 Linux x64 runtime and production application;
- `mise run smoke:release -- <release-directory>` checks that release directly
  outside the checkout and through an isolated transient systemd user service;
- `mise run install:service -- <release> <absolute-kb> [port]` installs and
  verifies the persistent user service;
- `mise run verify:service` rechecks the installed service and the byte-for-byte
  read-only boundary.

Dependency installation is frozen by the lockfile, and every public task that can touch the
synthetic Knowledge Base verifies that its tree remains byte-for-byte unchanged.
The [daily-use checkout evidence](docs/daily-use-checkout.md) records the
reproducible gate and the content-safe manual personal checklist.
The [operations guide](docs/operations.md) describes the installed XDG layout,
host prerequisites, diagnostics, and the boundary before deployment and private
network cutover.

## License

Indexary is licensed under the [GNU General Public License v3.0](LICENSE).
