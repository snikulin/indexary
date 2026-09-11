# Operations

## Runtime configuration

Runtime configuration follows `command-line option > environment variable > safe default` precedence. The Knowledge Base path has no default and must be supplied explicitly as an option or through `INDEXARY_KNOWLEDGE_BASE`. Indexary does not assume that `~/vault` exists and does not scan the home directory for a Knowledge Base.

The server binds to `127.0.0.1` by default and accepts overrides through `INDEXARY_HOST` and `INDEXARY_PORT` or their command-line equivalents. Machine-local environment values are never committed to the repository.

## Derived data

Rebuildable indexes and other disposable data live below `$XDG_CACHE_HOME/indexary`. Logs and non-disposable operational state, if introduced, live below `$XDG_STATE_HOME/indexary`. Indexary never writes derived data into the Knowledge Base.

Each Knowledge Base and runtime profile has an independent cache namespace so fixture development and development against a personal Knowledge Base cannot accidentally share incompatible indexes.

An index namespace includes its format version. Compatible application builds reuse an existing index; a build that changes the format creates a new namespace rather than migrating the preceding one in place. Obsolete namespaces are disposable and may be removed after the current build has successfully created and opened its index.

At startup Indexary validates every required schema object, the selected index
identity, and SQLite integrity, then compares the stored filesystem fingerprint
with current metadata before reporting readiness. An unchanged compatible index
is reused directly. A changed, corrupt, or incompatible index is replaced only
after a separate candidate has been fully built and successfully opened.
Abandoned candidates are removed on the next startup; they are never
authoritative. Isolated content failures increase the path-free degraded count
while usable Documents remain available.

## Logging

Operational logs may identify a problematic document by its path relative to the Knowledge Base and may describe the error type. They do not include document contents, frontmatter values, or the absolute Knowledge Base root by default.

## Daily-use checkout operating mode

The first delivery gate is a feature-complete daily-use application run from the
checkout. `mise run dev` uses the fixture, while
`mise run dev:kb -- <path>` explicitly starts the working instance against a
personal Knowledge Base. They use separate ports and cache profiles and can run
concurrently.

Before the production checkpoint, the owner performs the explicit
`mise run smoke:kb` checklist with an existing non-empty `INDEXARY_KB_PATH`, as
documented in [daily-use-checkout.md](daily-use-checkout.md). The wrapper records
no personal identifiers and compares the complete selected tree before and
after the manual session. The operator must restore the bytes of the deliberately
external test edit before ending the session.

Production remains a separate, pending milestone. There is no systemd unit,
versioned release directory, deployment task, automatic activation, Tailscale
Serve configuration, or rollback mechanism yet. A developer returns to an
earlier working state through normal git history. The checkout gate must not be
described or operated as an always-on installation.

Reconsider a separate installed instance and deployment process when any of the following occurs:

- Indexary must remain available without an active development process;
- another user needs a stable installation;
- a distributable release is prepared.
