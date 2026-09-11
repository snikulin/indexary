# Daily-use checkout evidence

This is the reproducible evidence boundary for the first delivery gate. It uses
only the committed synthetic Knowledge Base and generated temporary data unless
the owner explicitly opts into the separate personal confirmation.

## Automated gate

Run from a clean checkout with the locked toolchain:

```sh
mise install
mise run check
mise run perf:index
```

`mise run check` verifies formatting and linting, TypeScript types, focused
parser/link/configuration and React tests, assembled Fastify tests using the real
filesystem and SQLite FTS5, the optimized same-origin build, and the short
Playwright Atlas journey. One outer fingerprint covers the committed fixture
before and after the whole gate.

The covered read-only surface includes startup indexing, Document rendering,
uncapped folder navigation, deterministic links and backlinks, Source Materials
and Attachments including byte ranges, full-text and tag search, live external
updates, compatible cache reuse, incompatible/corrupt cache replacement, and
interrupted-candidate recovery. Tests also retain per-scenario before/after tree
captures where they mutate only temporary copies to simulate external changes.

Security regressions cover non-canonical traversal and absolute paths, external
and cyclic symbolic links, unsafe and encoded URL schemes, malformed search
grammar, malformed YAML and unreadable Documents, material replacement with an
external link, malformed and multi-range headers, suffix/open-ended ranges, and
unsatisfiable or empty-file ranges. Responses and coarse events are checked not
to expose outside content or private path data.

`mise run perf:index` generates and removes its own non-personal workload. It
contains 10,000 Documents and 10 GB of sparse Source Material and checks cold
indexing below 30 seconds, representative search below 200 milliseconds,
event-loop delay below 200 milliseconds, warm reconciliation, interrupted
replacement recovery, and an unchanged generated Knowledge Base. The latest
measured supported-host result is recorded in [development.md](development.md).

## Explicit personal confirmation

This step is manual because selecting representative content without the owner
would violate the privacy boundary. Do not run it unless `INDEXARY_KB_PATH` was
explicitly set to the intended Knowledge Base. The task never guesses or scans
for one.

```sh
test -n "${INDEXARY_KB_PATH:-}"
mise run smoke:kb
```

While the process runs, use the browser only—do not create screenshots, traces,
fixtures, copied diagnostics, or issue comments—and confirm:

1. The application root shows the intended Home Document state.
2. Open a folder and a Document, use Back and Forward, and use `Ctrl/Cmd+K` to
   find and open a representative search result.
3. Follow one resolved relationship and one backlink when the selected Documents
   provide them.
4. Open one representative Source Material or Attachment when available.
5. In an external editor, make a reversible change to the already selected
   Document, observe the live update, then restore the file to its exact original
   bytes.
6. Stop the task with `Ctrl+C`. Treat the smoke as passed only when the wrapper
   reports that the Knowledge Base is unchanged.

The task uses profile `personal-smoke` and port `4175`, isolated from fixture
development (`fixture`, `4173`) and ordinary personal development (`personal`,
`4174`). It prints only generic progress and the loopback service message; it
does not persist paths, Document or material names, content, metadata values,
visited browser URLs, screenshots, traces, or diagnostics.

## Production boundary

Passing this evidence makes the checkout packaging-ready. It does not create or
activate an immutable release, install a systemd user service, configure
Tailscale Serve, or prove rollback. Those actions belong to the pending personal
production milestone and its human checkpoint.
