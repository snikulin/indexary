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
$XDG_CACHE_HOME/indexary/catalog-v5/...
```

Release data and the atomic `current` selector live under the data home.
Machine-local configuration is mode `0600` outside releases. Non-disposable
installation evidence lives under the state home. Rebuildable catalogs remain
under the cache home and therefore survive release changes without becoming
part of an immutable artifact.

## Persistent user service

Initial installation is an intentional persistent host mutation. Supply the
Knowledge Base as an explicit absolute path; shell expansion of a user-specific
value must happen before the task receives it:

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

Readiness becomes successful once the derived catalog is usable. Its
`homeDocument` field is `available` or `unavailable`; the latter preserves the
explicit non-fatal state until the owner supplies `/index.md` outside Indexary
at the human production checkpoint.

After successful initial installation, this task refuses to select another
release. Subsequent release activation uses the safe deployment and rollback
workflow below.

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

## Safe manual deployment and rollback

Run the one normal deployment command from a clean commit:

```sh
mise run deploy
```

The command refuses dirty or unidentifiable source state. It runs the complete
local quality gate before staging anything, then assembles an immutable release
whose manifest identifies that exact commit and complete bundled runtime. It
starts the candidate with its bundled Node executable on an unused loopback
port, a unique runtime profile, and a disposable cache namespace. Candidate
smoke requires privacy-safe liveness and readiness, the Home Document response
or explicit unavailable state, same-origin HTML, the root catalog, a meaningful
search result, and a one-byte range from an available Source Material or
Attachment. Values selected during smoke remain in memory and are never printed.

Only after candidate smoke succeeds does deployment record an activation intent
and atomically replace `current`. It updates the private external environment,
reports the start of brief restart downtime, restarts `indexary.service`, and
requires the managed process to use the selected bundled runtime. Readiness and
the complete local application smoke must pass within bounded time. This is a
single-service restart: there is no blue/green deployment, automatic updater,
ambient runtime, or public listener.

Successful completion is recorded as `locally-verified`, and its lifecycle
event is `deployment-locally-verified`. These names describe the deployment
transaction itself: the persistent tailnet route is verified separately because
it is host configuration outside the release lifecycle.

Every transaction is recorded atomically at
`$XDG_STATE_HOME/indexary/deployment.json`; it contains release identities and
phase status. While candidate smoke is active it also contains the disposable
candidate cache path, loopback port, and process ID plus Linux process start
time so interruption recovery can distinguish PID reuse. It never contains
Knowledge Base paths, Document names, content, metadata, or material
identifiers. Only one deployment lock may exist. A handled
interruption or any gate/staging/candidate/activation/restart/readiness/post-smoke
failure restores the recorded preceding release, rewrites its release identity
in private configuration, restarts it, and requires it to become ready. The
candidate process group and disposable candidate cache are always stopped and
removed.

Exercise real rollback after at least one predecessor exists:

```sh
mise run deploy:rehearse-rollback
```

This uses the same workflow and injects failure only after the candidate has
been activated and locally verified. A successful rehearsal deliberately exits
nonzero after restoring the exact preceding selector and proving that the
service is ready. It does not damage an artifact, cache, or the Knowledge Base.

An interrupted invocation is safe to rerun: `mise run deploy` first recovers
any unfinished transaction. These commands provide an explicit inspection and
recovery path when operating manually:

```sh
mise run deployment:status
mise run recover:deployment
mise run verify:service
```

If automatic rollback itself cannot finish, stop and run the reported recovery
command; do not edit `current` by hand. Status output includes only safe release
identities and one next action. Abandoned contained staging directories are
removed on the next safe run; an unknown or symbolic-link target is refused.

After a deployment is locally verified and the Knowledge Base fingerprint
remains identical, retention keeps the active release and its two successful
predecessors. Pruning validates every exact child of `releases/`, never follows
symbolic links, and never touches configuration, transaction state, the active
production cache, or a candidate cache.

## Continuous private production

The installed user unit is enabled for `default.target`, restarts on failure,
and runs independently of an interactive login when systemd user lingering is
enabled. Inspect these host guarantees without revealing application data:

```sh
systemctl --user is-enabled indexary.service
systemctl --user is-active indexary.service
loginctl show-user "$USER" -p Linger
mise run verify:service
```

The expected results are `enabled`, `active`, and `Linger=yes`. If lingering is
disabled, enable it once with `loginctl enable-linger "$USER"`; this is host
configuration rather than part of an Indexary release.

Configure the private HTTPS route once, outside the deployment lifecycle:

```sh
tailscale serve --bg --yes http://127.0.0.1:4176
tailscale serve status
```

Run both commands on the machine that hosts the Indexary service and Knowledge
Base. Serve configuration is node-local: running `tailscale serve status` on a
client device reports that client's unrelated routes, not the Indexary route.

Use Tailscale Serve, never Funnel. Tailnet policy must restrict the node and
application to the owner; Indexary continues to bind only to loopback and adds
no application authentication. Because every release keeps the same loopback
port, normal deployment and rollback preserve the Serve route without invoking
`tailscale` or rewriting its state.

After initial setup, verify the private URL from a real owner client. Exercise
the Home Document, folder navigation, a direct Document route, search, tag
filtering, a link or backlink, one Source Material or Attachment, and one live
external change. Restore the external test edit, run `mise run verify:service`,
and confirm that the Knowledge Base fingerprint is unchanged. Record only the
release identity and pass/fail outcomes; never record private URLs, paths,
filenames, content, or metadata values.
