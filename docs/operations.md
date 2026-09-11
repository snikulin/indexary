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

The production command emits one JSON object per lifecycle event. Its fixed
fields are timestamp, level, event, and service; it does not log requests,
runtime paths, Knowledge Base paths, Document names, content, or metadata
values. The installer and verifier inspect only the current systemd invocation
and report generic failures instead of replaying response bodies or journal
contents.

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

## Immutable release

The supported production target is Linux x86-64 with a running systemd user
manager and lingering already enabled for the owner. The installer checks both
conditions but never changes lingering or other administrator-owned state. Root,
a separate Unix account, containers, an operating-system filesystem sandbox,
ambient Node, pnpm, Corepack, a login shell, and a development terminal are not
part of runtime operation.

From a clean commit, build a release with:

```sh
mise run release
```

The command returns machine-readable JSON containing the release identity and
directory. A release identity combines a UTC timestamp and git commit prefix;
`release.json` records the full commit, exact Node/SQLite platform identity, and
a checksum and mode for every payload file. The release contains the complete
Node 24.21.0 Linux x64 distribution, optimized server and web output, and only
production server dependencies. It is validated for contained dependency links
and checkout independence before its files and directories become non-writable.

Before persistent installation, exercise a release against the synthetic
Knowledge Base:

```sh
mise run smoke:release -- /absolute/release/directory
```

This starts the bundled runtime with a hostile minimal `PATH` and a working
directory outside the checkout, then repeats liveness, readiness, same-origin,
restart, journal, and graceful-stop checks through a uniquely named transient
systemd user service. Temporary cache data and the transient unit are removed;
the persistent `indexary.service` and `current` selector are untouched. The
fixture is fingerprinted before and after.

## Installed layout

The installation honors XDG base-directory variables, with standard per-user
fallbacks when they are unset:

```text
$XDG_DATA_HOME/indexary/
  releases/<timestamp>-<commit>/
    release.json
    runtime/
    app/server/{package.json,dist,node_modules}
    app/web/dist/
  current -> releases/<timestamp>-<commit>
$XDG_CONFIG_HOME/indexary/environment
$XDG_CONFIG_HOME/systemd/user/indexary.service
$XDG_STATE_HOME/indexary/installation.json
$XDG_CACHE_HOME/indexary/catalog-v4/...
```

Release data and the atomic `current` selector live under the data home.
Machine-local configuration is mode `0600` outside releases. Non-disposable
installation evidence lives under the state home. Rebuildable catalogs remain
under the cache home and therefore survive release changes without becoming
part of an immutable artifact.

## Persistent user service

Installation is an intentional persistent host mutation. Supply the Knowledge
Base as an explicit absolute path; shell expansion of a user-specific value must
happen before the task receives it:

```sh
mise run install:service -- /absolute/release/directory /absolute/knowledge-base [port]
```

The fixed defaults are `127.0.0.1`, port `4176`, and profile `production`. An
optional port remains fixed in the persisted environment. The task validates
the release and unit, fingerprints the complete Knowledge Base, atomically
selects the release, reloads the user manager, and runs `enable --now`. It then
verifies precise `Type=exec` process tracking, the bundled executable,
liveness, readiness, same-origin frontend behavior, and structured journald
events. A deliberate `systemctl --user restart` proves graceful shutdown and a
new managed invocation. Success is reported only if the Knowledge Base still
has the exact pre-installation bytes.

The installed unit invokes only absolute paths below `current`, uses
`Restart=on-failure`, and is enabled for `default.target`. It does not invoke a
shell or any development tool. Standard host operations remain available:

```sh
systemctl --user status indexary.service
systemctl --user restart indexary.service
systemctl --user stop indexary.service
journalctl --user-unit=indexary.service SYSLOG_IDENTIFIER=indexary
mise run verify:service
```

The last task performs bounded local health and same-origin checks, validates
the active runtime and current invocation's structured journal, and fingerprints
the Knowledge Base before and after. Liveness is
`http://127.0.0.1:4176/api/health/live` and readiness is
`http://127.0.0.1:4176/api/health/ready` unless the persisted port differs.

## Pending production boundary

Issue #13 supplies release and user-service mechanics only. There is not yet one
safe deployment command, candidate activation, automatic rollback, or release
retention; those are the scope of Issue #14. Neither release, installation,
smoke, nor verification invokes `tailscale` or changes Tailscale Serve. Private
tailnet policy, the persistent Serve route, any external Home Document rename,
and the first-production declaration remain the human checkpoint in Issue #15.
