import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  atomicSelectRelease,
  fingerprintTree,
  installService,
  renderEnvironmentFile,
  renderSystemdUnit,
  resolveXdgPaths,
  validateRelease,
} from "./production.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeReadOnlyTree(directory) {
  async function makeWritable(current) {
    let entries;
    try {
      entries = await import("node:fs/promises").then(({ readdir }) =>
        readdir(current, { withFileTypes: true }),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await makeWritable(path.join(current, entry.name));
      }
    }
    await chmod(current, 0o700).catch(() => undefined);
  }
  await makeWritable(directory);
  await rm(directory, { recursive: true, force: true });
}

async function createReleaseFixture(
  paths,
  releaseId = "20260911T120000000Z-0123456789ab",
) {
  const release = path.join(paths.releasesRoot, releaseId);
  await mkdir(path.join(release, "runtime/bin"), { recursive: true });
  await mkdir(path.join(release, "app/server/dist"), { recursive: true });
  await mkdir(path.join(release, "app/web/dist"), { recursive: true });
  await writeFile(path.join(release, "runtime/bin/node"), "runtime\n", {
    mode: 0o555,
  });
  await writeFile(path.join(release, "app/server/dist/cli.js"), "server\n", {
    mode: 0o444,
  });
  await writeFile(path.join(release, "app/web/dist/index.html"), "web\n", {
    mode: 0o444,
  });
  const files = [
    {
      path: "app/server/dist/cli.js",
      type: "file",
      mode: 0o444,
      size: 7,
      sha256:
        "4ad28e4a6461bd64b920f72f86c0d16edc544c4a1f26060518ebb900025d496a",
    },
    {
      path: "app/web/dist/index.html",
      type: "file",
      mode: 0o444,
      size: 4,
      sha256:
        "4ded89b3f9f03689b7032b92a091e742e1205e2a54277e52b32498d9fcdf3642",
    },
    {
      path: "runtime/bin/node",
      type: "file",
      mode: 0o555,
      size: 8,
      sha256:
        "fae9d8f386d67956867dedef7c89476199a4a25ee9ffe13560a6bfae7ae6c407",
    },
  ];
  await writeFile(
    path.join(release, "release.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        releaseId,
        createdAt: "2026-09-11T12:00:00.000Z",
        gitCommit: "0123456789abcdef0123456789abcdef01234567",
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
  return release;
}

test("XDG installation paths keep release, state, cache, and configuration separate", () => {
  assert.deepEqual(
    resolveXdgPaths({
      HOME: "/home/operator",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_STATE_HOME: "/xdg/state",
      XDG_CACHE_HOME: "/xdg/cache",
    }),
    {
      dataRoot: "/xdg/data/indexary",
      releasesRoot: "/xdg/data/indexary/releases",
      currentLink: "/xdg/data/indexary/current",
      configurationDirectory: "/xdg/config/indexary",
      environmentFile: "/xdg/config/indexary/environment",
      userUnitDirectory: "/xdg/config/systemd/user",
      unitFile: "/xdg/config/systemd/user/indexary.service",
      stateRoot: "/xdg/state/indexary",
      cacheRoot: "/xdg/cache",
    },
  );
  assert.throws(
    () =>
      resolveXdgPaths({ HOME: "/home/operator", XDG_DATA_HOME: "relative" }),
    /absolute/,
  );
});

test("persistent runtime configuration is private, absolute, fixed, and safely quoted", () => {
  const environment = renderEnvironmentFile({
    knowledgeBasePath: '/knowledge base/with "quotes"/$value\\leaf',
    cacheRoot: "/cache root",
    webRoot: "/data root/indexary/current/app/web/dist",
    releaseId: "20260911T120000000Z-0123456789ab",
  });
  assert.equal(
    environment,
    'INDEXARY_KNOWLEDGE_BASE="/knowledge base/with \\"quotes\\"/\\$value\\\\leaf"\n' +
      'INDEXARY_HOST="127.0.0.1"\n' +
      'INDEXARY_PORT="4176"\n' +
      'INDEXARY_PROFILE="production"\n' +
      'INDEXARY_CACHE_ROOT="/cache root"\n' +
      'INDEXARY_WEB_ROOT="/data root/indexary/current/app/web/dist"\n' +
      'INDEXARY_RELEASE_ID="20260911T120000000Z-0123456789ab"\n',
  );
  assert.throws(
    () =>
      renderEnvironmentFile({
        knowledgeBasePath: "relative",
        cacheRoot: "/cache",
        webRoot: "/web",
        releaseId: "release",
      }),
    /absolute/,
  );
  assert.throws(
    () =>
      renderEnvironmentFile({
        knowledgeBasePath: "/knowledge\nbase",
        cacheRoot: "/cache",
        webRoot: "/web",
        releaseId: "release",
      }),
    /newline/,
  );
});

test("rendered user unit directly tracks the bundled runtime and restarts failures", () => {
  const unit = renderSystemdUnit({
    environmentFile: "/config root/indexary/environment",
    currentLink: "/data root/indexary/current",
  });
  assert.match(unit, /^Type=exec$/m);
  assert.match(
    unit,
    /^EnvironmentFile=\/config\\x20root\/indexary\/environment$/m,
  );
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^TimeoutStopSec=20s$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.match(
    unit,
    /^ExecStart="\/data root\/indexary\/current\/runtime\/bin\/node" "\/data root\/indexary\/current\/app\/server\/dist\/cli\.js"$/m,
  );
  assert.doesNotMatch(
    unit,
    /(?:^|\s)(?:node|pnpm|corepack|mise|sh|bash)(?:\s|$)/m,
  );
  assert.doesNotMatch(unit, /ProtectSystem|RootDirectory|User=/);
});

test("current release selection is atomic and rejects external targets", async (context) => {
  const root = await temporaryDirectory("indexary-current-test-");
  context.after(() => removeReadOnlyTree(root));
  const paths = resolveXdgPaths({
    HOME: root,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  });
  const first = await createReleaseFixture(paths);
  await atomicSelectRelease(paths, first);
  assert.equal(
    await readlink(paths.currentLink),
    `releases/${path.basename(first)}`,
  );

  const outside = path.join(root, "outside");
  await mkdir(outside);
  await assert.rejects(() => atomicSelectRelease(paths, outside), /release/);
});

test("installation configures, starts, restarts, and verifies without changing the Knowledge Base", async (context) => {
  const root = await temporaryDirectory("indexary-install-test-");
  context.after(() => removeReadOnlyTree(root));
  const paths = resolveXdgPaths({
    HOME: root,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  });
  const release = await createReleaseFixture(paths);
  const knowledgeBase = path.join(root, "knowledge-base");
  await mkdir(knowledgeBase);
  await writeFile(path.join(knowledgeBase, "index.md"), "# Fixture\n");
  const before = await fingerprintTree(knowledgeBase);
  const commands = [];
  const invocations = [];

  await installService(
    {
      paths,
      releaseDirectory: release,
      knowledgeBasePath: knowledgeBase,
    },
    {
      runCommand: async (command, arguments_) => {
        commands.push([command, ...arguments_]);
        if (command === "loginctl") {
          return { stdout: "yes\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
      verifyManagedService: async () => {
        const invocationId = `invocation-${invocations.length + 1}`;
        invocations.push(invocationId);
        return { invocationId, mainPid: 1234 + invocations.length };
      },
      verifyStoppedInvocation: async (invocationId) => {
        assert.equal(invocationId, "invocation-1");
      },
    },
  );

  assert.equal(await fingerprintTree(knowledgeBase), before);
  assert.equal(
    await readlink(paths.currentLink),
    `releases/${path.basename(release)}`,
  );
  assert.equal((await stat(paths.environmentFile)).mode & 0o777, 0o600);
  assert.match(
    await readFile(paths.environmentFile, "utf8"),
    /INDEXARY_HOST="127\.0\.0\.1"/,
  );
  assert.doesNotMatch(
    await readFile(paths.unitFile, "utf8"),
    /pnpm|mise|corepack/,
  );
  assert.deepEqual(commands, [
    ["systemctl", "--user", "show-environment"],
    [
      "loginctl",
      "show-user",
      String(process.getuid()),
      "--property=Linger",
      "--value",
    ],
    ["systemd-analyze", "--user", "verify", paths.unitFile],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "indexary.service"],
    ["systemctl", "--user", "restart", "indexary.service"],
  ]);
  assert.deepEqual(invocations, ["invocation-1", "invocation-2"]);
  const installation = JSON.parse(
    await readFile(path.join(paths.stateRoot, "installation.json"), "utf8"),
  );
  assert.equal(installation.releaseId, path.basename(release));
  assert.equal(Object.values(installation).includes(knowledgeBase), false);

  await assert.rejects(
    () =>
      installService(
        {
          paths,
          releaseDirectory: release,
          knowledgeBasePath: knowledgeBase,
        },
        {
          runCommand: async () => {
            throw new Error("No host command should run twice.");
          },
        },
      ),
    /initial service installation is already complete/,
  );
});

test("release validator checks the complete immutable payload", async (context) => {
  const root = await temporaryDirectory("indexary-release-test-");
  context.after(() => removeReadOnlyTree(root));
  const paths = resolveXdgPaths({
    HOME: root,
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  });
  const release = await createReleaseFixture(paths);
  const manifest = await validateRelease(release);
  assert.equal(manifest.releaseId, path.basename(release));

  await chmod(path.join(release, "app/server/dist"), 0o755);
  await chmod(path.join(release, "app/server/dist/cli.js"), 0o644);
  await writeFile(path.join(release, "app/server/dist/cli.js"), "changed\n");
  await assert.rejects(() => validateRelease(release), /immutable payload/);
});

test("production dependency closure contains dist and omits package sources and tests", async (context) => {
  const root = await temporaryDirectory("indexary-deploy-test-");
  context.after(() => removeReadOnlyTree(root));
  const destination = path.join(root, "server");
  await execute("pnpm", ["--filter", "@indexary/server", "build"], {
    cwd: repositoryRoot,
  });
  await execute(
    "pnpm",
    [
      "--filter",
      "@indexary/server",
      "deploy",
      "--prod",
      "--frozen-lockfile",
      destination,
    ],
    { cwd: repositoryRoot },
  );
  assert.equal(
    (await lstat(path.join(destination, "dist/cli.js"))).isFile(),
    true,
  );
  await assert.rejects(() => lstat(path.join(destination, "src")), /ENOENT/);
  await assert.rejects(() => lstat(path.join(destination, "test")), /ENOENT/);
  await assert.rejects(
    () => lstat(path.join(destination, "tsconfig.json")),
    /ENOENT/,
  );

  const fastifyLink = await lstat(
    path.join(destination, "node_modules/fastify"),
  );
  assert.equal(fastifyLink.isSymbolicLink(), true);
  const target = await readlink(path.join(destination, "node_modules/fastify"));
  assert.equal(
    path.resolve(destination, "node_modules", target).startsWith(destination),
    true,
  );
});
