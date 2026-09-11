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
- `mise run perf:index`: verify the generated v1 indexing and search support target.

Package-level scripts and granular checks are workspace implementation details, not a second public task interface.

`mise run check` comprises formatting verification, linting, type checking, unit tests, server integration tests against fixtures, an optimized application build, and a short browser smoke test. Personal Knowledge Bases, extended browser suites, and performance benchmarks are outside this quality gate.

## Development data

Automated tests and the default development command use a small synthetic Knowledge Base committed as test fixtures. Access to a personal Knowledge Base, such as `~/vault`, is always an explicit opt-in intended for manual integration testing.

Personal Knowledge Base contents must not be copied into the repository, build artifacts, test snapshots, CI inputs, or diagnostic output by default.

Tests verify that Indexary leaves the fixture Knowledge Base byte-for-byte unchanged. The v1 write boundary is enforced by application interfaces and tests rather than an operating-system filesystem sandbox.

Fixture development and development against a personal Knowledge Base may run simultaneously. They use different ports and cache namespaces so their derived indexes cannot collide.

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
first build remains live but not ready, and readiness reports only an aggregate
degraded count.

`mise run perf:index` generates a non-personal workload of 10,000 Documents and
10,000,000,000 bytes of sparse Source Material, then checks the 30-second cold
index, 200-millisecond representative search, event-loop delay, and read-only
targets. A known synchronous stall first calibrates the event-loop monitor so a
silently ineffective measurement fails the benchmark. The benchmark is
intentionally outside the routine quality gate.

The recorded 2026-09-11 run on the supported Linux x86-64 environment (Node
24.21.0, Intel Core i9-13900H) completed cold indexing in 6.95 seconds and warm
reconciliation in 550.94 milliseconds, with a 14.63 millisecond slowest
representative search and 157.65 millisecond maximum observed event-loop delay.
The calibration observed 90.57 milliseconds of a deliberate 100-millisecond
stall. Those measurements keep index work in-process behind the Knowledge Base
module boundary.

## Change flow

The sole developer normally commits directly to `main` after `mise run check` succeeds. Branches are optional tools for risky or long-running experiments; pull requests and a long-lived integration branch are not required.

Git commits identify working states during active initial development. Semantic versions and release tags begin with the first distributable release, when they communicate something meaningful to a user.

## Deferred automation

Initial development has no GitHub Actions workflow, required status check, branch protection, or mandatory pull request. This is a deliberate process choice for a single developer, not a limitation of the GitHub Free plan.

Reconsider this workflow when any of the following occurs:

- a second developer begins contributing regularly;
- the first distributable release is prepared;
- an independent clean-environment check becomes valuable enough to outweigh the added process.
