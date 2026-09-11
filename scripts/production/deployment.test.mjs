import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";

import {
  acquireDeploymentLock,
  deployRelease,
  deploymentStatus,
  pruneSuccessfulReleases,
  recoverDeployment,
  resolveCurrentRelease,
  verifyDeploymentApplication,
} from "./deployment.mjs";
import {
  atomicSelectRelease,
  renderEnvironmentFile,
  resolveXdgPaths,
  validateRelease,
} from "./production.mjs";

const sourceCommit = "abcdef0123456789abcdef0123456789abcdef01";
const ids = [
  "20260911T100000000Z-000000000001",
  "20260911T110000000Z-000000000002",
  "20260911T120000000Z-000000000003",
  "20260911T130000000Z-000000000004",
  "20260911T140000000Z-abcdef012345",
];

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeReadOnlyTree(directory) {
  async function makeWritable(current) {
    const metadata = await lstat(current).catch(() => undefined);
    if (metadata === undefined || metadata.isSymbolicLink()) {
      return;
    }
    if (metadata.isDirectory()) {
      await chmod(current, 0o700).catch(() => undefined);
      for (const entry of await import("node:fs/promises").then(({ readdir }) =>
        readdir(current, { withFileTypes: true }),
      )) {
        await makeWritable(path.join(current, entry.name));
      }
    } else {
      await chmod(current, 0o600).catch(() => undefined);
    }
  }
  await makeWritable(directory);
  await rm(directory, { recursive: true, force: true });
}

function testPaths(root) {
  return resolveXdgPaths({
    HOME: root,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  });
}

async function createRelease(paths, releaseId, gitCommit = sourceCommit) {
  const release = path.join(paths.releasesRoot, releaseId);
  const payloads = new Map([
    ["app/server/dist/cli.js", "server\n"],
    ["app/web/dist/index.html", "web\n"],
    ["runtime/bin/node", "runtime\n"],
  ]);
  for (const [relative, contents] of payloads) {
    await mkdir(path.dirname(path.join(release, relative)), {
      recursive: true,
    });
    await writeFile(path.join(release, relative), contents);
  }
  const files = [...payloads]
    .map(([relative, contents]) => ({
      path: relative,
      type: "file",
      mode: relative === "runtime/bin/node" ? 0o555 : 0o444,
      size: Buffer.byteLength(contents),
      sha256: sha256(contents),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  await chmod(path.join(release, "runtime/bin/node"), 0o555);
  await chmod(path.join(release, "app/server/dist/cli.js"), 0o444);
  await chmod(path.join(release, "app/web/dist/index.html"), 0o444);
  await writeFile(
    path.join(release, "release.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        releaseId,
        createdAt: "2026-09-11T12:00:00.000Z",
        gitCommit,
        runtime: {
          version: "v24.21.0",
          platform: "linux",
          arch: "x64",
          sqlite: "3.53.4",
        },
        application: {
          server: "app/server/dist/cli.js",
          web: "app/web/dist/index.html",
        },
        files,
      },
      null,
      2,
    )}\n`,
    { mode: 0o444 },
  );
  for (const directory of [
    path.join(release, "runtime/bin"),
    path.join(release, "runtime"),
    path.join(release, "app/server/dist"),
    path.join(release, "app/server"),
    path.join(release, "app/web/dist"),
    path.join(release, "app/web"),
    path.join(release, "app"),
    release,
  ]) {
    await chmod(directory, 0o555);
  }
  await validateRelease(release);
  return {
    releaseDirectory: release,
    manifest: JSON.parse(await readFile(path.join(release, "release.json"))),
  };
}

async function installFixture(paths, activeRelease) {
  const knowledgeBase = path.join(
    path.dirname(paths.dataRoot),
    "knowledge-base",
  );
  await mkdir(knowledgeBase, { recursive: true });
  await writeFile(path.join(knowledgeBase, "index.md"), "# Synthetic\n");
  await mkdir(paths.configurationDirectory, { recursive: true });
  await mkdir(paths.stateRoot, { recursive: true });
  await atomicSelectRelease(paths, activeRelease.releaseDirectory);
  await writeFile(
    paths.environmentFile,
    renderEnvironmentFile({
      knowledgeBasePath: knowledgeBase,
      cacheRoot: paths.cacheRoot,
      webRoot: path.join(paths.currentLink, "app/web/dist"),
      releaseId: activeRelease.manifest.releaseId,
      port: 4176,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(paths.stateRoot, "installation.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      releaseId: activeRelease.manifest.releaseId,
      service: "indexary.service",
    })}\n`,
    { mode: 0o600 },
  );
  return knowledgeBase;
}

function fakeDependencies(candidate, events, overrides = {}) {
  return {
    runCommand: async (command, arguments_) => {
      if (command === "git" && arguments_[0] === "status") {
        events.push("git-status");
        return { stdout: "", stderr: "" };
      }
      if (command === "git" && arguments_[0] === "rev-parse") {
        events.push("git-revision");
        return { stdout: `${sourceCommit}\n`, stderr: "" };
      }
      if (command === "mise") {
        events.push("quality-gate");
        return { stdout: "", stderr: "" };
      }
      if (command === "systemctl") {
        events.push("service-restart");
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    buildImmutableRelease: async () => {
      events.push("release-built");
      return candidate;
    },
    verifyCandidate: async ({ cacheRoot, port }) => {
      events.push("candidate-smoke");
      assert.match(cacheRoot, /deployment-candidates\/candidate-/);
      assert.equal(port, 49_123);
    },
    unusedLoopbackPort: async () => 49_123,
    verifyManagedService: async () => {
      events.push("managed-ready");
      return { invocationId: "1".repeat(32), mainPid: 1234 };
    },
    verifyApplication: async () => {
      events.push("post-activation-smoke");
    },
    report: (event) => events.push(event.event),
    ...overrides,
  };
}

async function setupDeployment(context, prefix = "indexary-deploy-") {
  const root = await temporaryDirectory(prefix);
  context.after(() => removeReadOnlyTree(root));
  const paths = testPaths(root);
  const previous = await createRelease(paths, ids[3]);
  const candidate = await createRelease(paths, ids[4]);
  const knowledgeBase = await installFixture(paths, previous);
  return { root, paths, previous, candidate, knowledgeBase };
}

test("deployment gates, isolates, activates, verifies, records, and retains three successful releases", async (context) => {
  const root = await temporaryDirectory("indexary-deploy-success-");
  context.after(() => removeReadOnlyTree(root));
  const paths = testPaths(root);
  const releases = [];
  for (const id of ids) {
    releases.push(await createRelease(paths, id));
  }
  const previous = releases[3];
  const candidate = releases[4];
  await installFixture(paths, previous);
  await writeFile(
    path.join(paths.stateRoot, "successful-releases.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      releaseIds: ids.slice(0, 4),
    })}\n`,
  );
  const abandoned = path.join(
    paths.releasesRoot,
    `.20260911T090000000Z-000000000000.staging-${"1".repeat(8)}-${"1".repeat(4)}-${"1".repeat(4)}-${"1".repeat(4)}-${"1".repeat(12)}`,
  );
  await mkdir(abandoned);
  await writeFile(path.join(abandoned, "partial"), "partial\n");
  const events = [];

  const result = await deployRelease(
    { paths, sourceRoot: root },
    fakeDependencies(candidate, events),
  );

  assert.equal(result.status, "verified");
  assert.equal(result.releaseId, candidate.manifest.releaseId);
  assert.equal(
    await readlink(paths.currentLink),
    `releases/${candidate.manifest.releaseId}`,
  );
  assert.match(
    await readFile(paths.environmentFile, "utf8"),
    new RegExp(`INDEXARY_RELEASE_ID="${candidate.manifest.releaseId}"`),
  );
  assert.deepEqual(result.retention.retained, ids.slice(2));
  assert.deepEqual(result.retention.pruned.sort(), ids.slice(0, 2));
  assert.equal(await lstat(abandoned).catch(() => undefined), undefined);
  const transaction = JSON.parse(
    await readFile(path.join(paths.stateRoot, "deployment.json"), "utf8"),
  );
  assert.equal(transaction.status, "verified");
  assert.equal(transaction.previousReleaseId, previous.manifest.releaseId);
  assert.equal(transaction.candidateReleaseId, candidate.manifest.releaseId);
  assert.ok(events.indexOf("quality-gate") < events.indexOf("release-built"));
  assert.ok(
    events.indexOf("candidate-smoke") <
      events.indexOf("brief-downtime-starting"),
  );
  assert.ok(
    events.indexOf("service-restart") < events.indexOf("managed-ready"),
  );
  assert.equal(events.includes("deployment-verified"), true);
  assert.equal((await stat(paths.environmentFile)).mode & 0o777, 0o600);
});

test("deployment smoke covers privacy-safe health, Home Document, catalog, search, and a material range", async (context) => {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push(`${url.pathname}${url.search}`);
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/health/live") {
      json(200, { status: "live" });
    } else if (url.pathname === "/api/health/ready") {
      json(200, {
        status: "ready",
        homeDocument: "unavailable",
        degradedCount: 0,
      });
    } else if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html>");
    } else if (url.pathname === "/api/documents/home") {
      json(404, { code: "HOME_DOCUMENT_NOT_FOUND" });
    } else if (url.pathname === "/api/catalog") {
      json(200, {
        path: "",
        folders: [],
        documents: [{ path: "document.md", title: "Synthetic" }],
      });
    } else if (url.pathname === "/api/documents") {
      json(200, {
        path: "document.md",
        title: "Synthetic",
        searchableText: "Synthetic deployment document",
        revision: 7,
        materials: {
          sourceMaterials: [
            { id: "material-id", status: "available", size: 2 },
          ],
          attachments: [],
        },
      });
    } else if (url.pathname === "/api/search") {
      json(200, { results: [{ path: "document.md" }] });
    } else if (url.pathname === "/api/materials") {
      assert.equal(request.headers.range, "bytes=0-0");
      response.writeHead(206, {
        "content-length": "1",
        "content-range": "bytes 0-0/2",
      });
      response.end("x");
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  );
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const result = await verifyDeploymentApplication(address.port);

  assert.deepEqual(result, { homeDocument: "unavailable", degradedCount: 0 });
  for (const route of [
    "/api/health/live",
    "/api/health/ready",
    "/",
    "/api/documents/home",
    "/api/catalog",
    "/api/documents?path=document.md",
    "/api/search?q=Synthetic",
    "/api/materials?document=document.md&id=material-id&revision=7",
  ]) {
    assert.equal(requests.includes(route), true, `missing request ${route}`);
  }
});

for (const failure of [
  "quality-gate",
  "staging",
  "candidate",
  "activation",
  "restart",
  "readiness",
  "post-check",
]) {
  test(`a ${failure} failure restores and restarts the exact preceding release`, async (context) => {
    const { root, paths, previous, candidate } = await setupDeployment(
      context,
      `indexary-${failure}-`,
    );
    const events = [];
    let injected = false;
    const dependencies = fakeDependencies(candidate, events);
    const originalRun = dependencies.runCommand;
    dependencies.runCommand = async (command, arguments_, options) => {
      if (failure === "quality-gate" && command === "mise" && !injected) {
        injected = true;
        throw new Error("injected gate failure");
      }
      if (failure === "restart" && command === "systemctl" && !injected) {
        const active = await resolveCurrentRelease(paths);
        if (active.releaseId === candidate.manifest.releaseId) {
          injected = true;
          throw new Error("injected restart failure");
        }
      }
      return originalRun(command, arguments_, options);
    };
    if (failure === "staging") {
      dependencies.buildImmutableRelease = async () => {
        injected = true;
        throw new Error("injected staging failure");
      };
    }
    if (failure === "candidate") {
      dependencies.verifyCandidate = async () => {
        injected = true;
        throw new Error("injected candidate failure");
      };
    }
    if (failure === "activation") {
      dependencies.atomicSelectRelease = async (selectedPaths, release) => {
        if (
          path.basename(release) === candidate.manifest.releaseId &&
          !injected
        ) {
          injected = true;
          throw new Error("injected activation failure");
        }
        return atomicSelectRelease(selectedPaths, release);
      };
    }
    if (failure === "readiness") {
      dependencies.verifyManagedService = async () => {
        const active = await resolveCurrentRelease(paths);
        if (active.releaseId === candidate.manifest.releaseId && !injected) {
          injected = true;
          throw new Error("injected readiness failure");
        }
        events.push("managed-ready");
        return { invocationId: "1".repeat(32), mainPid: 1234 };
      };
    }
    if (failure === "post-check") {
      dependencies.verifyApplication = async () => {
        const active = await resolveCurrentRelease(paths);
        if (active.releaseId === candidate.manifest.releaseId && !injected) {
          injected = true;
          throw new Error("injected post-check failure");
        }
        events.push("post-activation-smoke");
      };
    }

    await assert.rejects(
      () => deployRelease({ paths, sourceRoot: root }, dependencies),
      /injected/,
    );
    assert.equal(injected, true);
    assert.equal(
      await readlink(paths.currentLink),
      `releases/${previous.manifest.releaseId}`,
    );
    assert.match(
      await readFile(paths.environmentFile, "utf8"),
      new RegExp(`INDEXARY_RELEASE_ID="${previous.manifest.releaseId}"`),
    );
    const transaction = JSON.parse(
      await readFile(path.join(paths.stateRoot, "deployment.json"), "utf8"),
    );
    assert.equal(transaction.status, "rolled-back");
    assert.equal(events.includes("rollback-complete"), true);
    assert.equal(events.includes("service-restart"), true);
  });
}

test("controlled post-activation failure proves rollback and leaves the predecessor ready", async (context) => {
  const { root, paths, previous, candidate } = await setupDeployment(
    context,
    "indexary-rehearsal-",
  );
  const events = [];
  await assert.rejects(
    () =>
      deployRelease(
        { paths, sourceRoot: root, rehearseRollback: true },
        fakeDependencies(candidate, events),
      ),
    /Controlled post-activation failure/,
  );
  assert.equal(
    await readlink(paths.currentLink),
    `releases/${previous.manifest.releaseId}`,
  );
  assert.equal(events.filter((event) => event === "service-restart").length, 2);
  assert.equal(events.at(-1), "rollback-complete");
});

test("retention waits for the final Knowledge Base fingerprint", async (context) => {
  const { root, paths, previous, candidate, knowledgeBase } =
    await setupDeployment(context, "indexary-fingerprint-before-prune-");
  for (const id of ids.slice(0, 3)) {
    await createRelease(paths, id);
  }
  await writeFile(
    path.join(paths.stateRoot, "successful-releases.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      releaseIds: [...ids.slice(0, 3), previous.manifest.releaseId],
    })}\n`,
  );
  let changed = false;
  const dependencies = fakeDependencies(candidate, []);
  dependencies.verifyApplication = async () => {
    if (!changed) {
      changed = true;
      await writeFile(path.join(knowledgeBase, "index.md"), "# Changed\n");
    }
  };

  await assert.rejects(
    () => deployRelease({ paths, sourceRoot: root }, dependencies),
    /Knowledge Base differs/,
  );

  assert.equal(changed, true);
  assert.notEqual(
    await lstat(path.join(paths.releasesRoot, ids[0])).catch(() => undefined),
    undefined,
  );
  assert.equal(
    await readlink(paths.currentLink),
    `releases/${previous.manifest.releaseId}`,
  );
  const transaction = JSON.parse(
    await readFile(path.join(paths.stateRoot, "deployment.json"), "utf8"),
  );
  assert.equal(transaction.status, "rolled-back");
});

test("a handled signal after activation rolls back before reporting failure", async (context) => {
  const { root, paths, previous, candidate } = await setupDeployment(
    context,
    "indexary-signal-",
  );
  const events = [];
  let signal;
  await assert.rejects(
    () =>
      deployRelease(
        { paths, sourceRoot: root, isInterrupted: () => signal },
        fakeDependencies(candidate, events, {
          phase: async (name) => {
            if (name === "after-activation") {
              signal = "SIGTERM";
            }
          },
        }),
      ),
    /SIGTERM/,
  );
  assert.equal(
    await readlink(paths.currentLink),
    `releases/${previous.manifest.releaseId}`,
  );
});

for (const interruptedStatus of ["staged", "activated", "verifying"]) {
  test(`interrupted ${interruptedStatus} transaction is recovered to its recorded predecessor`, async (context) => {
    const { paths, previous, candidate } = await setupDeployment(
      context,
      `indexary-recover-${interruptedStatus}-`,
    );
    if (interruptedStatus !== "staged") {
      await atomicSelectRelease(paths, candidate.releaseDirectory);
      const configuration = await readFile(paths.environmentFile, "utf8");
      await writeFile(
        paths.environmentFile,
        configuration.replace(
          previous.manifest.releaseId,
          candidate.manifest.releaseId,
        ),
        { mode: 0o600 },
      );
    }
    await writeFile(
      path.join(paths.stateRoot, "deployment.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        transactionId: "11111111-1111-1111-1111-111111111111",
        status: interruptedStatus,
        previousReleaseId: previous.manifest.releaseId,
        candidateReleaseId: candidate.manifest.releaseId,
        startedAt: "2026-09-11T12:00:00.000Z",
        updatedAt: "2026-09-11T12:00:00.000Z",
        rehearsal: false,
      })}\n`,
      { mode: 0o600 },
    );
    const events = [];
    const result = await recoverDeployment(
      paths,
      fakeDependencies(candidate, events),
    );
    assert.equal(result.status, "rolled-back");
    assert.equal(
      await readlink(paths.currentLink),
      `releases/${previous.manifest.releaseId}`,
    );
    assert.equal((await deploymentStatus(paths)).action, "mise run deploy");
  });
}

test("a live deployment lock refuses concurrent work and a stale lock is recoverable", async (context) => {
  const root = await temporaryDirectory("indexary-lock-");
  context.after(() => removeReadOnlyTree(root));
  const paths = testPaths(root);
  const release = await acquireDeploymentLock(paths);
  await assert.rejects(
    () => acquireDeploymentLock(paths),
    /Another deployment/,
  );
  await release();
  await writeFile(
    path.join(paths.stateRoot, "deployment.lock"),
    `${JSON.stringify({ pid: 999_999_999, nonce: "stale" })}\n`,
  );
  const releaseRecovered = await acquireDeploymentLock(paths);
  await releaseRecovered();
  assert.equal(
    await lstat(path.join(paths.stateRoot, "deployment.lock")).catch(
      () => undefined,
    ),
    undefined,
  );
});

test("release selection and pruning reject external symbolic-link targets", async (context) => {
  const { root, paths, previous } = await setupDeployment(
    context,
    "indexary-containment-",
  );
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await rm(paths.currentLink);
  await symlink(outside, paths.currentLink);
  await assert.rejects(() => resolveCurrentRelease(paths), /contained release/);

  await atomicSelectRelease(paths, previous.releaseDirectory);
  const maliciousId = ids[0];
  await symlink(outside, path.join(paths.releasesRoot, maliciousId));
  await assert.rejects(
    () =>
      pruneSuccessfulReleases(paths, previous.manifest.releaseId, [
        previous.manifest.releaseId,
      ]),
    /non-directory target/,
  );
  assert.equal((await stat(outside)).isDirectory(), true);
});
