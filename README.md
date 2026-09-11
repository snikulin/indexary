# Indexary

**An open-source, local-first web interface for exploring filesystem-based knowledge bases.**

> Project status: architecture and product definition. Implementation has not started yet.

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
- Zod or TypeBox for request and response validation

The validation library will be selected during implementation.

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

## License

Indexary is licensed under the [GNU General Public License v3.0](LICENSE).
