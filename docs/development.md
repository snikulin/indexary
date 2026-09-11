# Development process

## Supported environment

Linux on x86-64 is the supported development environment and eventual deployment target. Other platforms are best effort until the project deliberately expands its support contract.

The browser smoke test uses the host Chromium executable at `/usr/bin/chromium`; set `CHROMIUM_PATH` to another Chromium-compatible executable when the supported Linux installation places it elsewhere. Browser binaries are a documented host prerequisite rather than an implicit dependency lifecycle download.

The same Playwright journey is run explicitly in current Firefox before a
daily-use release. See [the accessibility checks](accessibility.md) for browser
commands and the focused manual keyboard checklist. WebKit remains best effort.

The development environment pins Node.js, the JavaScript package manager, and project tools. JavaScript dependencies are fully locked. A small number of host prerequisites may be documented rather than isolated.

`mise` manages tool versions, project environment variables, and the public task interface. Both `mise.toml` and `mise.lock` are committed, and locked installation is used whenever the toolchain is verified. Routine environment activation does not install host packages or configure host services.

Reconsider `devenv` if the project acquires complex native dependencies, several stateful development services, or a requirement to reproduce the development and production dependency closure through Nix.

Node.js 24 LTS is the initial runtime line. `pnpm` 12 is the package manager, installed and exactly pinned by `mise`; Corepack is not part of the bootstrap path. The repository commits `pnpm-lock.yaml`, and every automated installation uses frozen-lockfile mode.

The repository is a pnpm workspace with `apps/web` and `apps/server`. Shared packages are introduced only for a concrete, named boundary; there is no generic `shared` package.

Dependency lifecycle scripts are denied by default and enabled through a reviewed, committed allowlist. Dependency versions must normally have been published for at least 24 hours before installation; exceptions are explicit repository changes.

The current allowlist contains only `esbuild`, whose install script selects and verifies the platform binary used by the pinned Vite, Vitest, and tsx toolchain. `strictDepBuilds` makes the frozen installation fail if another dependency introduces an unreviewed lifecycle script.

## Task interface

The stable project interface is:

- `mise run dev`: run against the fixture Knowledge Base;
- `mise run dev:kb -- <path>`: explicitly run against a personal Knowledge Base;
- `mise run test`: run the test suites;
- `mise run build`: create an optimized application build;
- `mise run check`: run the complete local quality gate;
- `mise run perf:index`: verify the generated v1 indexing and search support target;
- `mise run smoke:kb`, with an existing non-empty `INDEXARY_KB_PATH`: run the
  content-safe manual personal Knowledge Base smoke with a byte-for-byte
  boundary check;
- `mise run release`: build optimized outputs and assemble a clean git commit as
  an immutable per-user release;
- `mise run smoke:release -- <release-directory>`: exercise the bundled runtime
  both directly outside the checkout and under an isolated transient systemd
  user service;
- `mise run install:service -- <release> <absolute-kb> [port]`: perform the
  initial install, enable, start, restart, and verify the persistent user
  service; later releases must use the safe deployment workflow;
- `mise run deploy`: from one clean commit, run the complete gate, build and
  isolate a candidate, activate it with brief restart downtime, verify it
  locally, and automatically restore the preceding release on failure;
- `mise run deploy:rehearse-rollback`: inject a controlled post-activation
  failure and prove the preceding service becomes ready again;
- `mise run deployment:status` and `mise run recover:deployment`: inspect or
  recover an interrupted transaction without exposing machine-local content;
- `mise run verify:service`: verify the active release, service state, local
  application behavior, structured journal, and read-only boundary again.

Package-level scripts and granular checks are workspace implementation details, not a second public task interface.

`mise run check` comprises formatting verification, linting, type checking,
focused server and web tests, assembled Fastify integration tests against real
temporary files and SQLite FTS5, an optimized application build, and the short
Playwright smoke. It also verifies production XDG placement, unit/config
rendering, release manifests, atomic selection, service orchestration seams, and
that the deployed server package contains production dependencies without
source or test trees. The named package scripts make every part visible in the
gate output. Personal Knowledge Bases, Firefox confirmation, full release
assembly, transient-systemd smoke, and performance benchmarks are deliberately
outside this non-personal quality gate.

Release assembly requires a completely clean checkout, the pinned Node
24.21.0 Linux x64 runtime selected by `mise`, and existing optimized web/server
outputs. The public `mise run release` task provides those outputs and rejects a
dirty or unidentifiable source state. It does not select or start the result.
Use `mise run smoke:release` for isolated artifact evidence before installing
it. See [operations.md](operations.md) before running the persistent installation
task.

The deployment command also requires a clean identifiable commit and invokes
the complete `mise run check` itself before it is allowed to stage a release.
Its deterministic production tests use isolated XDG roots and fake service
orchestration to cover quality-gate, staging, candidate, activation, restart,
readiness, post-check, interruption, rollback, locking, containment, and
retention failures. Candidate and post-activation smoke additionally exercise
the Home Document state, root catalog, search, and a one-byte material response.
The terminal deployment state is explicitly `locally-verified`; no deployment
test or command configures Tailscale or completes the Issue #15 human checkpoint.

## Development data

Automated tests and the default development command use a small synthetic Knowledge Base committed as test fixtures. Access to a personal Knowledge Base, such as `~/vault`, is always an explicit opt-in intended for manual integration testing.

Personal Knowledge Base contents must not be copied into the repository, build artifacts, test snapshots, CI inputs, or diagnostic output by default.

Tests verify that Indexary leaves the fixture Knowledge Base byte-for-byte unchanged. The v1 write boundary is enforced by application interfaces and tests rather than an operating-system filesystem sandbox.

Fixture development and development against a personal Knowledge Base may run simultaneously. They use different ports and cache namespaces so their derived indexes cannot collide.

The fixture instance uses port `4173` and profile `fixture`, ordinary personal
development uses port `4174` and profile `personal`, and the manual personal
smoke uses port `4175` and profile `personal-smoke`. The cache identity also
includes a non-reversible Knowledge Base identifier, so concurrent instances do
not share a catalog even when profiles are accidentally reused across different
roots.

The derived catalog and full-text search database is stored under
`$XDG_CACHE_HOME/indexary/catalog-v4/<profile>/<knowledge-base-id>` (or the
platform cache fallback when `XDG_CACHE_HOME` is unset). The format version,
profile, and a non-reversible identifier derived from the canonical Knowledge
Base path form the index identity; no Indexary-owned database or absolute
Knowledge Base path is stored inside the Knowledge Base or routine health
output. `INDEXARY_CACHE_ROOT` or `--cache-root` may select an alternate cache
root for isolated tests and diagnostics.

Compatible indexes are opened and reconciled against a metadata fingerprint of
the current filesystem before the instance becomes ready. An unchanged warm
index is reused without reparsing Documents; changed, invalid, and corrupt
indexes are built as separate candidates, validated, and atomically selected. A
first build remains live but not ready. Once a usable index exists, readiness
reports an aggregate degraded count and whether the Home Document is available;
a missing Home Document does not make the rest of the Knowledge Base unready.

`mise run perf:index` generates a non-personal workload of 10,000 Documents and
10,000,000,000 bytes of sparse Source Material, then checks the 30-second cold
index, 200-millisecond representative search, event-loop delay, and read-only
targets. A known synchronous stall first calibrates the event-loop monitor so a
silently ineffective measurement fails the benchmark. The benchmark is
intentionally outside the routine quality gate.

The recorded 2026-09-11 run on the supported Linux x86-64 environment (Node
24.21.0, Intel Core i9-13900H) completed cold indexing in 6.16 seconds and warm
reconciliation in 584.90 milliseconds, with a 15.61 millisecond slowest
representative search and 157.63 millisecond maximum observed event-loop delay.
The calibration observed 90.48 milliseconds of a deliberate 100-millisecond
stall. Interruption evidence preserved the preceding catalog, removed one
abandoned candidate, recovered all 2,001 generated Documents, and left the
generated Knowledge Base unchanged. Those measurements keep index work
in-process behind the Knowledge Base module boundary.

The complete checkout evidence and the personal confirmation procedure are in
[daily-use-checkout.md](daily-use-checkout.md). No personal path, Document name,
content, metadata value, material, browser trace, screenshot, or visited URL is
recorded by that procedure.

## Change flow

The sole developer normally commits directly to `main` after `mise run check` succeeds. Branches are optional tools for risky or long-running experiments; pull requests and a long-lived integration branch are not required.

Git commits identify working states during active initial development. Semantic versions and release tags begin with the first distributable release, when they communicate something meaningful to a user.

## Deferred automation

Initial development has no GitHub Actions workflow, required status check, branch protection, or mandatory pull request. This is a deliberate process choice for a single developer, not a limitation of the GitHub Free plan.

Reconsider this workflow when any of the following occurs:

- a second developer begins contributing regularly;
- the first distributable release is prepared;
- an independent clean-environment check becomes valuable enough to outweigh the added process.
