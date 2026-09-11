import { execFile, spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const unitTemplate = await readFile(
  path.join(repositoryRoot, "ops/systemd/indexary.service.template"),
  "utf8",
);

const RELEASE_SCHEMA_VERSION = 1;
const NODE_VERSION = "v24.21.0";
const NODE_PLATFORM = "linux";
const NODE_ARCHITECTURE = "x64";
const SERVICE_NAME = "indexary.service";
const SERVICE_HOST = "127.0.0.1";
const SERVICE_PORT = 4176;
const SERVICE_PROFILE = "production";
const RELEASE_ID_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export class ProductionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ProductionError";
  }
}

function requireSafeSingleLine(value, label) {
  if (value.includes("\0")) {
    throw new ProductionError(`${label} must not contain NUL.`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw new ProductionError(`${label} must not contain a newline.`);
  }
}

function requireAbsolute(value, label) {
  requireSafeSingleLine(value, label);
  if (!path.isAbsolute(value)) {
    throw new ProductionError(`${label} must be absolute.`);
  }
  return path.resolve(value);
}

function xdgValue(environment, name, fallback) {
  const configured = environment[name];
  if (configured === undefined || configured === "") {
    return fallback;
  }
  return requireAbsolute(configured, name);
}

export function resolveXdgPaths(environment = process.env) {
  const home = requireAbsolute(environment.HOME ?? "", "HOME");
  const dataHome = xdgValue(
    environment,
    "XDG_DATA_HOME",
    path.join(home, ".local/share"),
  );
  const configHome = xdgValue(
    environment,
    "XDG_CONFIG_HOME",
    path.join(home, ".config"),
  );
  const stateHome = xdgValue(
    environment,
    "XDG_STATE_HOME",
    path.join(home, ".local/state"),
  );
  const cacheHome = xdgValue(
    environment,
    "XDG_CACHE_HOME",
    path.join(home, ".cache"),
  );
  const dataRoot = path.join(dataHome, "indexary");
  const configurationDirectory = path.join(configHome, "indexary");
  const userUnitDirectory = path.join(configHome, "systemd/user");
  return {
    dataRoot,
    releasesRoot: path.join(dataRoot, "releases"),
    currentLink: path.join(dataRoot, "current"),
    configurationDirectory,
    environmentFile: path.join(configurationDirectory, "environment"),
    userUnitDirectory,
    unitFile: path.join(userUnitDirectory, SERVICE_NAME),
    stateRoot: path.join(stateHome, "indexary"),
    cacheRoot: cacheHome,
  };
}

function quoteEnvironmentValue(value) {
  requireSafeSingleLine(value, "Environment value");
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`")}"`;
}

export function renderEnvironmentFile({
  knowledgeBasePath,
  cacheRoot,
  webRoot,
  releaseId,
  port = SERVICE_PORT,
}) {
  const root = requireAbsolute(knowledgeBasePath, "Knowledge Base path");
  const cache = requireAbsolute(cacheRoot, "Cache root");
  const web = requireAbsolute(webRoot, "Web root");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProductionError(
      "Service port must be an integer from 1 to 65535.",
    );
  }
  requireSafeSingleLine(releaseId, "Release identity");
  const values = {
    INDEXARY_KNOWLEDGE_BASE: root,
    INDEXARY_HOST: SERVICE_HOST,
    INDEXARY_PORT: String(port),
    INDEXARY_PROFILE: SERVICE_PROFILE,
    INDEXARY_CACHE_ROOT: cache,
    INDEXARY_WEB_ROOT: web,
    INDEXARY_RELEASE_ID: releaseId,
  };
  return `${Object.entries(values)
    .map(([name, value]) => `${name}=${quoteEnvironmentValue(value)}`)
    .join("\n")}\n`;
}

function quoteUnitArgument(value) {
  requireSafeSingleLine(value, "Unit argument");
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "$$")
    .replaceAll("%", "%%")}"`;
}

function escapeUnitPath(value) {
  requireSafeSingleLine(value, "Unit path");
  let escaped = "";
  for (const byte of Buffer.from(value)) {
    const character = String.fromCodePoint(byte);
    if (/^[A-Za-z0-9_./:-]$/.test(character)) {
      escaped += character;
    } else if (character === "%") {
      escaped += "%%";
    } else {
      escaped += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return escaped;
}

export function renderSystemdUnit({ environmentFile, currentLink }) {
  const environment = requireAbsolute(environmentFile, "Environment file");
  const current = requireAbsolute(currentLink, "Current release selector");
  const substitutions = {
    "{{ENVIRONMENT_FILE}}": escapeUnitPath(environment),
    "{{NODE_EXECUTABLE}}": quoteUnitArgument(
      path.join(current, "runtime/bin/node"),
    ),
    "{{SERVER_ENTRYPOINT}}": quoteUnitArgument(
      path.join(current, "app/server/dist/cli.js"),
    ),
  };
  let rendered = unitTemplate;
  for (const [placeholder, value] of Object.entries(substitutions)) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  if (rendered.includes("{{")) {
    throw new ProductionError("The systemd unit template is incomplete.");
  }
  return rendered;
}

export async function fingerprintTree(root) {
  const hash = createHash("sha256");

  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      hash.update(`${relativePath}\0${metadata.mode}\0${metadata.size}\0`);
      if (entry.isSymbolicLink()) {
        hash.update(`link\0${await readlink(absolutePath)}\0`);
      } else if (entry.isDirectory()) {
        hash.update("directory\0");
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update("file\0");
        for await (const chunk of createReadStream(absolutePath)) {
          hash.update(chunk);
        }
      } else {
        hash.update("other\0");
      }
    }
  }

  await visit(requireAbsolute(root, "Fingerprint root"));
  return hash.digest("hex");
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function collectPayloadEntries(root) {
  const result = [];

  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (relativePath === "release.json") {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        result.push({
          path: relativePath,
          type: "file",
          mode: metadata.mode & 0o777,
          size: metadata.size,
          sha256: await hashFile(absolutePath),
        });
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        result.push({
          path: relativePath,
          type: "link",
          mode: metadata.mode & 0o777,
          target,
          sha256: createHash("sha256").update(target).digest("hex"),
        });
      } else {
        throw new ProductionError(
          "The release contains an unsupported filesystem entry.",
        );
      }
    }
  }

  await visit(root);
  return result;
}

async function verifyImmutableModes(root) {
  async function visit(current) {
    const metadata = await lstat(current);
    if (!metadata.isSymbolicLink() && (metadata.mode & 0o222) !== 0) {
      throw new ProductionError("The release immutable payload is writable.");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return;
    }
    for (const entry of await readdir(current)) {
      await visit(path.join(current, entry));
    }
  }
  await visit(root);
}

function validManifestShape(manifest) {
  return (
    manifest !== null &&
    typeof manifest === "object" &&
    manifest.schemaVersion === RELEASE_SCHEMA_VERSION &&
    typeof manifest.releaseId === "string" &&
    RELEASE_ID_PATTERN.test(manifest.releaseId) &&
    typeof manifest.createdAt === "string" &&
    !Number.isNaN(Date.parse(manifest.createdAt)) &&
    typeof manifest.gitCommit === "string" &&
    COMMIT_PATTERN.test(manifest.gitCommit) &&
    manifest.runtime?.version === NODE_VERSION &&
    manifest.runtime?.platform === NODE_PLATFORM &&
    manifest.runtime?.arch === NODE_ARCHITECTURE &&
    typeof manifest.runtime?.sqlite === "string" &&
    manifest.application?.server === "app/server/dist/cli.js" &&
    manifest.application?.web === "app/web/dist/index.html" &&
    Array.isArray(manifest.files)
  );
}

export async function validateRelease(releaseDirectory, expectedReleaseId) {
  const release = requireAbsolute(releaseDirectory, "Release directory");
  const releaseMetadata = await lstat(release).catch(() => undefined);
  if (
    releaseMetadata === undefined ||
    !releaseMetadata.isDirectory() ||
    releaseMetadata.isSymbolicLink()
  ) {
    throw new ProductionError("The selected release directory is invalid.");
  }
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(release, "release.json"), "utf8"),
    );
  } catch (error) {
    throw new ProductionError("The selected release manifest is invalid.", {
      cause: error,
    });
  }
  if (!validManifestShape(manifest)) {
    throw new ProductionError("The selected release manifest is invalid.");
  }
  if (manifest.releaseId !== (expectedReleaseId ?? path.basename(release))) {
    throw new ProductionError(
      "The release identity does not match its directory.",
    );
  }

  const actual = await collectPayloadEntries(release);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new ProductionError(
      "The release immutable payload does not match its manifest.",
    );
  }
  await verifyImmutableModes(release);
  for (const entry of actual) {
    if (entry.type !== "link") {
      continue;
    }
    const link = path.join(release, entry.path);
    const resolved = await realpath(link).catch(() => undefined);
    if (resolved === undefined || !isContained(release, resolved)) {
      throw new ProductionError(
        "The release contains an external or broken dependency link.",
      );
    }
  }
  for (const required of [
    "runtime/bin/node",
    "app/server/dist/cli.js",
    "app/web/dist/index.html",
  ]) {
    const metadata = await stat(path.join(release, required)).catch(
      () => undefined,
    );
    if (metadata === undefined || !metadata.isFile()) {
      throw new ProductionError(
        "The release production closure is incomplete.",
      );
    }
  }
  return manifest;
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // A rename on the supported Linux filesystem is already atomic. Directory
    // fsync is an additional durability measure where the filesystem permits it.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function atomicSelectRelease(paths, releaseDirectory) {
  const releasesRoot = requireAbsolute(paths.releasesRoot, "Release root");
  const release = requireAbsolute(releaseDirectory, "Release directory");
  const parent = path.dirname(release);
  if (parent !== releasesRoot) {
    throw new ProductionError(
      "The selected target is not an installed release.",
    );
  }
  await validateRelease(release);
  await mkdir(path.dirname(paths.currentLink), { recursive: true });
  const temporaryLink = path.join(
    path.dirname(paths.currentLink),
    `.current-${process.pid}-${randomUUID()}`,
  );
  const target = path.posix.join("releases", path.basename(release));
  await symlink(target, temporaryLink);
  try {
    await rename(temporaryLink, paths.currentLink);
    await fsyncDirectory(path.dirname(paths.currentLink));
  } catch (error) {
    await rm(temporaryLink, { force: true });
    throw error;
  }
}

async function writeAtomic(file, contents, mode) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}-${process.pid}-${randomUUID()}`,
  );
  await writeFile(temporary, contents, { mode, flag: "wx" });
  await chmod(temporary, mode);
  await rename(temporary, file);
  await fsyncDirectory(path.dirname(file));
}

export async function runCommand(command, arguments_, options = {}) {
  try {
    const result = await executeFile(command, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    throw new ProductionError("A required production command failed.", {
      cause: error,
    });
  }
}

function parseProperties(output) {
  return Object.fromEntries(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator === -1
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

async function fetchWithin(url, options = {}) {
  try {
    return await globalThis.fetch(url, {
      ...options,
      signal: globalThis.AbortSignal.timeout(2_000),
      redirect: "error",
    });
  } catch (error) {
    throw new ProductionError(
      "The managed service did not answer a local verification request.",
      {
        cause: error,
      },
    );
  }
}

async function eventually(action, timeoutMilliseconds = 60_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw (
    lastError ??
    new ProductionError("A bounded production verification timed out.")
  );
}

async function readJsonResponse(url, expectedStatus = 200) {
  const response = await fetchWithin(url);
  if (response.status !== expectedStatus) {
    throw new ProductionError(
      "The managed service returned an unexpected health status.",
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new ProductionError(
      "The managed service returned an invalid health response.",
      {
        cause: error,
      },
    );
  }
}

async function readInvocationEvents(
  invocationId,
  commandRunner,
  requiredEvents,
  unitName = SERVICE_NAME,
) {
  if (!/^[0-9a-f]{32}$/.test(invocationId)) {
    throw new ProductionError(
      "The managed service invocation identity is invalid.",
    );
  }
  return eventually(async () => {
    const journal = await commandRunner("journalctl", [
      `--user-unit=${unitName}`,
      `SYSLOG_IDENTIFIER=indexary`,
      `_SYSTEMD_INVOCATION_ID=${invocationId}`,
      "--output=cat",
      "--no-pager",
    ]);
    const lines = journal.stdout.split("\n").filter(Boolean);
    const events = lines.map((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new ProductionError(
          "The managed service journal is not structured JSON.",
          {
            cause: error,
          },
        );
      }
      const keys = Object.keys(event).sort();
      if (
        JSON.stringify(keys) !==
          JSON.stringify(["event", "level", "service", "timestamp"]) ||
        event.service !== "indexary" ||
        !["info", "error"].includes(event.level) ||
        typeof event.timestamp !== "string" ||
        typeof event.event !== "string"
      ) {
        throw new ProductionError(
          "The managed service journal event shape is invalid.",
        );
      }
      return event.event;
    });
    for (const required of requiredEvents) {
      if (!events.includes(required)) {
        throw new ProductionError(
          "The managed service journal is missing a lifecycle event.",
        );
      }
    }
    return events;
  }, 10_000);
}

export async function verifyManagedService(
  { paths, port = SERVICE_PORT, knowledgeBasePath },
  commandRunner = runCommand,
) {
  const statusResult = await commandRunner("systemctl", [
    "--user",
    "show",
    SERVICE_NAME,
    "--property=Type",
    "--property=MainPID",
    "--property=ActiveState",
    "--property=SubState",
    "--property=FragmentPath",
    "--property=InvocationID",
  ]);
  const properties = parseProperties(statusResult.stdout);
  const mainPid = Number(properties.MainPID);
  if (
    properties.Type !== "exec" ||
    properties.ActiveState !== "active" ||
    properties.SubState !== "running" ||
    properties.FragmentPath !== paths.unitFile ||
    !Number.isSafeInteger(mainPid) ||
    mainPid <= 0 ||
    !/^[0-9a-f]{32}$/.test(properties.InvocationID ?? "")
  ) {
    throw new ProductionError(
      "The user service process tracking state is invalid.",
    );
  }
  const executable = await realpath(`/proc/${mainPid}/exe`).catch(
    () => undefined,
  );
  const expectedExecutable = await realpath(
    path.join(paths.currentLink, "runtime/bin/node"),
  ).catch(() => undefined);
  if (executable === undefined || executable !== expectedExecutable) {
    throw new ProductionError(
      "The user service is not running the bundled runtime.",
    );
  }

  const base = `http://${SERVICE_HOST}:${port}`;
  await eventually(async () => {
    const live = await readJsonResponse(`${base}/api/health/live`);
    if (JSON.stringify(live) !== JSON.stringify({ status: "live" })) {
      throw new ProductionError(
        "The managed service liveness response is invalid.",
      );
    }
    const ready = await readJsonResponse(`${base}/api/health/ready`);
    if (
      ready?.status !== "ready" ||
      ready?.homeDocument !== "available" ||
      !Number.isSafeInteger(ready?.degradedCount)
    ) {
      throw new ProductionError(
        "The managed service readiness response is invalid.",
      );
    }
    const root = await fetchWithin(`${base}/`);
    if (
      root.status !== 200 ||
      !(root.headers.get("content-type") ?? "").includes("text/html")
    ) {
      throw new ProductionError(
        "The managed same-origin frontend is unavailable.",
      );
    }
  });
  await readInvocationEvents(properties.InvocationID, commandRunner, [
    "starting",
    "runtime-preflight-passed",
    "listening",
    "ready",
  ]);

  const journal = await commandRunner("journalctl", [
    "--user-unit=indexary.service",
    "SYSLOG_IDENTIFIER=indexary",
    `_SYSTEMD_INVOCATION_ID=${properties.InvocationID}`,
    "--output=cat",
    "--no-pager",
  ]);
  if (journal.stdout.includes(knowledgeBasePath)) {
    throw new ProductionError(
      "The managed service journal exposed private configuration.",
    );
  }
  return { invocationId: properties.InvocationID, mainPid };
}

export async function verifyStoppedInvocation(
  invocationId,
  commandRunner = runCommand,
  unitName = SERVICE_NAME,
) {
  await readInvocationEvents(
    invocationId,
    commandRunner,
    ["stopping", "stopped"],
    unitName,
  );
}

export async function installService(
  { paths, releaseDirectory, knowledgeBasePath, port = SERVICE_PORT },
  dependencies = {},
) {
  const commandRunner = dependencies.runCommand ?? runCommand;
  const serviceVerifier =
    dependencies.verifyManagedService ??
    ((options) => verifyManagedService(options, commandRunner));
  const stoppedVerifier =
    dependencies.verifyStoppedInvocation ??
    ((invocationId) => verifyStoppedInvocation(invocationId, commandRunner));
  const root = requireAbsolute(knowledgeBasePath, "Knowledge Base path");
  const rootMetadata = await stat(root).catch(() => undefined);
  if (rootMetadata === undefined || !rootMetadata.isDirectory()) {
    throw new ProductionError(
      "The explicitly selected Knowledge Base cannot be read.",
    );
  }
  const release = requireAbsolute(releaseDirectory, "Release directory");
  if (path.dirname(release) !== paths.releasesRoot) {
    throw new ProductionError(
      "The selected target is not an installed release.",
    );
  }
  const manifest = await validateRelease(release);
  const before = await fingerprintTree(root);
  let operationError;

  try {
    await commandRunner("systemctl", ["--user", "show-environment"]);
    const linger = await commandRunner("loginctl", [
      "show-user",
      String(process.getuid()),
      "--property=Linger",
      "--value",
    ]);
    if (linger.stdout.trim() !== "yes") {
      throw new ProductionError(
        "User lingering is required and must be enabled by the machine owner.",
      );
    }

    await mkdir(paths.configurationDirectory, { recursive: true, mode: 0o700 });
    await chmod(paths.configurationDirectory, 0o700);
    await mkdir(paths.userUnitDirectory, { recursive: true });
    await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
    await chmod(paths.stateRoot, 0o700);
    await mkdir(paths.cacheRoot, { recursive: true });
    await atomicSelectRelease(paths, release);
    await writeAtomic(
      paths.environmentFile,
      renderEnvironmentFile({
        knowledgeBasePath: root,
        cacheRoot: paths.cacheRoot,
        webRoot: path.join(paths.currentLink, "app/web/dist"),
        releaseId: manifest.releaseId,
        port,
      }),
      0o600,
    );
    await writeAtomic(paths.unitFile, renderSystemdUnit(paths), 0o644);
    await commandRunner("systemd-analyze", [
      "--user",
      "verify",
      paths.unitFile,
    ]);
    await commandRunner("systemctl", ["--user", "daemon-reload"]);
    await commandRunner("systemctl", [
      "--user",
      "enable",
      "--now",
      SERVICE_NAME,
    ]);
    const first = await serviceVerifier({
      paths,
      port,
      knowledgeBasePath: root,
    });
    await commandRunner("systemctl", ["--user", "restart", SERVICE_NAME]);
    const second = await serviceVerifier({
      paths,
      port,
      knowledgeBasePath: root,
    });
    if (
      first.mainPid === second.mainPid ||
      first.invocationId === second.invocationId
    ) {
      throw new ProductionError(
        "The managed service restart was not observed.",
      );
    }
    await stoppedVerifier(first.invocationId);
    await writeAtomic(
      path.join(paths.stateRoot, "installation.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          releaseId: manifest.releaseId,
          installedAt: new Date().toISOString(),
          service: SERVICE_NAME,
        },
        null,
        2,
      )}\n`,
      0o600,
    );
  } catch (error) {
    operationError = error;
  }

  const after = await fingerprintTree(root).catch(() => undefined);
  if (after === undefined || after !== before) {
    throw new ProductionError(
      "The Knowledge Base differs from its byte-for-byte pre-installation state.",
      { cause: operationError },
    );
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  return manifest;
}

function formatReleaseTimestamp(date) {
  return date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "")
    .replace("Z", "Z");
}

async function runtimeIdentity(nodeExecutable, workingDirectory = os.tmpdir()) {
  let output;
  try {
    ({ stdout: output } = await executeFile(
      nodeExecutable,
      [
        "--input-type=module",
        "--eval",
        "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.exec(\"CREATE VIRTUAL TABLE temp.probe USING fts5(value); DROP TABLE temp.probe;\"); db.close(); console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,sqlite:process.versions.sqlite}));",
      ],
      {
        cwd: workingDirectory,
        env: { PATH: "/nonexistent" },
        encoding: "utf8",
      },
    ));
  } catch (error) {
    throw new ProductionError(
      "The bundled runtime failed its SQLite FTS5 preflight.",
      {
        cause: error,
      },
    );
  }
  let identity;
  try {
    identity = JSON.parse(output.trim());
  } catch (error) {
    throw new ProductionError("The bundled runtime identity is invalid.", {
      cause: error,
    });
  }
  if (
    identity.version !== NODE_VERSION ||
    identity.platform !== NODE_PLATFORM ||
    identity.arch !== NODE_ARCHITECTURE ||
    typeof identity.sqlite !== "string"
  ) {
    throw new ProductionError(
      "The bundled runtime does not match the supported target.",
    );
  }
  return identity;
}

async function makeTreeImmutable(root) {
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(child);
      } else if (!entry.isSymbolicLink()) {
        const metadata = await lstat(child);
        await chmod(child, metadata.mode & 0o555);
      }
    }
    const metadata = await lstat(current);
    await chmod(current, metadata.mode & 0o555);
  }
  await visit(root);
}

async function makeTreeRemovable(root) {
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    await chmod(current, 0o700).catch(() => undefined);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(path.join(current, entry.name));
      }
    }
  }
  await visit(root);
}

async function fileContains(file, needle) {
  if (needle.length === 0) {
    return false;
  }
  let remainder = Buffer.alloc(0);
  for await (const chunk of createReadStream(file)) {
    const joined = Buffer.concat([remainder, chunk]);
    if (joined.includes(needle)) {
      return true;
    }
    remainder = joined.subarray(Math.max(0, joined.length - needle.length + 1));
  }
  return false;
}

async function assertNoCheckoutReference(root, checkout) {
  const needle = Buffer.from(checkout);
  const entries = await collectPayloadEntries(root);
  for (const entry of entries) {
    if (
      entry.type === "file" &&
      (await fileContains(path.join(root, entry.path), needle))
    ) {
      throw new ProductionError(
        "The release contains a source checkout reference.",
      );
    }
  }
}

export async function buildImmutableRelease(options = {}) {
  const sourceRoot = requireAbsolute(
    options.repositoryRoot ?? repositoryRoot,
    "Repository root",
  );
  const paths = options.paths ?? resolveXdgPaths();
  const commandRunner = options.runCommand ?? runCommand;
  const status = await commandRunner("git", ["status", "--porcelain"], {
    cwd: sourceRoot,
  });
  if (status.stdout.trim() !== "") {
    throw new ProductionError(
      "An immutable release requires a clean checkout.",
    );
  }
  const revision = await commandRunner("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
  });
  const gitCommit = revision.stdout.trim();
  if (!COMMIT_PATTERN.test(gitCommit)) {
    throw new ProductionError("The source commit identity is invalid.");
  }
  if (
    process.version !== NODE_VERSION ||
    process.platform !== NODE_PLATFORM ||
    process.arch !== NODE_ARCHITECTURE
  ) {
    throw new ProductionError(
      "Release assembly requires the pinned Node 24 Linux x64 runtime.",
    );
  }
  for (const required of [
    "apps/server/dist/cli.js",
    "apps/web/dist/index.html",
  ]) {
    await access(path.join(sourceRoot, required), fsConstants.R_OK).catch(
      () => {
        throw new ProductionError(
          "Build optimized application outputs before assembling a release.",
        );
      },
    );
  }

  const createdAt = (options.now ?? new Date()).toISOString();
  const releaseId = `${formatReleaseTimestamp(new Date(createdAt))}-${gitCommit.slice(0, 12)}`;
  const runtimeSource = await realpath(
    options.runtimeSource ?? path.dirname(path.dirname(process.execPath)),
  );
  const sourceIdentity = await runtimeIdentity(
    path.join(runtimeSource, "bin/node"),
  );
  await mkdir(paths.releasesRoot, { recursive: true });
  const destination = path.join(paths.releasesRoot, releaseId);
  if (await lstat(destination).catch(() => undefined)) {
    throw new ProductionError("This immutable release already exists.");
  }
  const staging = path.join(
    paths.releasesRoot,
    `.${releaseId}.staging-${randomUUID()}`,
  );
  await mkdir(staging, { mode: 0o700 });

  try {
    await cp(runtimeSource, path.join(staging, "runtime"), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await mkdir(path.join(staging, "app"), { recursive: true });
    await commandRunner(
      "pnpm",
      [
        "--filter",
        "@indexary/server",
        "deploy",
        "--prod",
        "--frozen-lockfile",
        path.join(staging, "app/server"),
      ],
      { cwd: sourceRoot },
    );
    await cp(
      path.join(sourceRoot, "apps/web/dist"),
      path.join(staging, "app/web/dist"),
      {
        recursive: true,
        preserveTimestamps: true,
      },
    );
    for (const excluded of [
      "src",
      "test",
      "tsconfig.json",
      "tsconfig.build.json",
    ]) {
      if (
        await lstat(path.join(staging, "app/server", excluded)).catch(
          () => undefined,
        )
      ) {
        throw new ProductionError(
          "The production server package includes development sources.",
        );
      }
    }
    const copiedIdentity = await runtimeIdentity(
      path.join(staging, "runtime/bin/node"),
      os.tmpdir(),
    );
    if (JSON.stringify(copiedIdentity) !== JSON.stringify(sourceIdentity)) {
      throw new ProductionError(
        "The copied runtime identity changed during release assembly.",
      );
    }
    await assertNoCheckoutReference(staging, sourceRoot);
    await makeTreeImmutable(staging);
    await chmod(staging, 0o755);
    const files = await collectPayloadEntries(staging);
    const manifest = {
      schemaVersion: RELEASE_SCHEMA_VERSION,
      releaseId,
      createdAt,
      gitCommit,
      runtime: sourceIdentity,
      application: {
        server: "app/server/dist/cli.js",
        web: "app/web/dist/index.html",
      },
      files,
    };
    await writeFile(
      path.join(staging, "release.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o444 },
    );
    await chmod(staging, 0o555);
    await validateRelease(staging, releaseId);
    await rename(staging, destination);
    await fsyncDirectory(paths.releasesRoot);
    return { releaseDirectory: destination, manifest };
  } catch (error) {
    await makeTreeRemovable(staging);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export const productionDefaults = Object.freeze({
  host: SERVICE_HOST,
  port: SERVICE_PORT,
  profile: SERVICE_PROFILE,
  serviceName: SERVICE_NAME,
  nodeVersion: NODE_VERSION,
});

function decodeEnvironmentValue(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    throw new ProductionError("The installed environment file is invalid.");
  }
  let decoded = "";
  const contents = value.slice(1, -1);
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= contents.length) {
      throw new ProductionError("The installed environment file is invalid.");
    }
    decoded += contents[index];
  }
  return decoded;
}

async function readInstalledConfiguration(paths) {
  const text = await readFile(paths.environmentFile, "utf8").catch(() => {
    throw new ProductionError(
      "The installed service configuration is unavailable.",
    );
  });
  const values = {};
  for (const line of text.split("\n").filter(Boolean)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new ProductionError("The installed environment file is invalid.");
    }
    values[line.slice(0, separator)] = decodeEnvironmentValue(
      line.slice(separator + 1),
    );
  }
  const required = [
    "INDEXARY_KNOWLEDGE_BASE",
    "INDEXARY_HOST",
    "INDEXARY_PORT",
    "INDEXARY_PROFILE",
    "INDEXARY_CACHE_ROOT",
    "INDEXARY_WEB_ROOT",
    "INDEXARY_RELEASE_ID",
  ];
  if (required.some((name) => typeof values[name] !== "string")) {
    throw new ProductionError("The installed environment file is incomplete.");
  }
  if (
    values.INDEXARY_HOST !== SERVICE_HOST ||
    values.INDEXARY_PROFILE !== SERVICE_PROFILE ||
    values.INDEXARY_CACHE_ROOT !== paths.cacheRoot ||
    values.INDEXARY_WEB_ROOT !== path.join(paths.currentLink, "app/web/dist")
  ) {
    throw new ProductionError(
      "The installed environment file violates the production contract.",
    );
  }
  const port = Number(values.INDEXARY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProductionError("The installed service port is invalid.");
  }
  return {
    knowledgeBasePath: requireAbsolute(
      values.INDEXARY_KNOWLEDGE_BASE,
      "Knowledge Base path",
    ),
    releaseId: values.INDEXARY_RELEASE_ID,
    port,
  };
}

export async function verifyInstalledService(
  paths = resolveXdgPaths(),
  dependencies = {},
) {
  const commandRunner = dependencies.runCommand ?? runCommand;
  const configuration = await readInstalledConfiguration(paths);
  const selectedTarget = await readlink(paths.currentLink).catch(
    () => undefined,
  );
  if (selectedTarget !== path.posix.join("releases", configuration.releaseId)) {
    throw new ProductionError("The active release selector is inconsistent.");
  }
  await validateRelease(path.join(paths.dataRoot, selectedTarget));
  const before = await fingerprintTree(configuration.knowledgeBasePath);
  let verificationError;
  try {
    await (
      dependencies.verifyManagedService ??
      ((options) => verifyManagedService(options, commandRunner))
    )({
      paths,
      port: configuration.port,
      knowledgeBasePath: configuration.knowledgeBasePath,
    });
  } catch (error) {
    verificationError = error;
  }
  const after = await fingerprintTree(configuration.knowledgeBasePath).catch(
    () => undefined,
  );
  if (after === undefined || after !== before) {
    throw new ProductionError(
      "The Knowledge Base differs from its byte-for-byte pre-verification state.",
      { cause: verificationError },
    );
  }
  if (verificationError !== undefined) {
    throw verificationError;
  }
  return configuration;
}

async function unusedLoopbackPort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, SERVICE_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new ProductionError(
      "A loopback verification port could not be allocated.",
    );
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

function releaseEnvironment({ knowledgeBasePath, cacheRoot, webRoot, port }) {
  return {
    HOME: os.tmpdir(),
    PATH: "/nonexistent",
    XDG_CACHE_HOME: cacheRoot,
    INDEXARY_KNOWLEDGE_BASE: knowledgeBasePath,
    INDEXARY_HOST: SERVICE_HOST,
    INDEXARY_PORT: String(port),
    INDEXARY_PROFILE: "release-smoke",
    INDEXARY_CACHE_ROOT: cacheRoot,
    INDEXARY_WEB_ROOT: webRoot,
  };
}

async function verifyLocalApplication(port, requireReady) {
  const base = `http://${SERVICE_HOST}:${port}`;
  await eventually(async () => {
    const live = await readJsonResponse(`${base}/api/health/live`);
    if (JSON.stringify(live) !== JSON.stringify({ status: "live" })) {
      throw new ProductionError("The release liveness response is invalid.");
    }
    const readyResponse = await fetchWithin(`${base}/api/health/ready`);
    if (requireReady) {
      if (readyResponse.status !== 200) {
        throw new ProductionError("The release did not become ready.");
      }
      const ready = await readyResponse.json().catch(() => undefined);
      if (
        ready?.status !== "ready" ||
        ready?.homeDocument !== "available" ||
        !Number.isSafeInteger(ready?.degradedCount)
      ) {
        throw new ProductionError("The release readiness response is invalid.");
      }
    } else if (![200, 503].includes(readyResponse.status)) {
      throw new ProductionError("The release readiness endpoint is invalid.");
    }
    const root = await fetchWithin(`${base}/`);
    if (
      root.status !== 200 ||
      !(root.headers.get("content-type") ?? "").includes("text/html")
    ) {
      throw new ProductionError(
        "The release same-origin frontend is unavailable.",
      );
    }
  });
}

function parsePrivateLifecycleLog(log, privateValues, requireReady) {
  for (const value of privateValues) {
    if (value !== "" && log.includes(value)) {
      throw new ProductionError(
        "A release lifecycle log exposed private configuration.",
      );
    }
  }
  const events = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new ProductionError(
          "A release lifecycle log is not structured JSON.",
          {
            cause: error,
          },
        );
      }
      if (
        JSON.stringify(Object.keys(event).sort()) !==
          JSON.stringify(["event", "level", "service", "timestamp"]) ||
        event.service !== "indexary"
      ) {
        throw new ProductionError(
          "A release lifecycle event shape is invalid.",
        );
      }
      return event.event;
    });
  for (const required of [
    "starting",
    "runtime-preflight-passed",
    "listening",
    ...(requireReady ? ["ready"] : []),
    "stopping",
    "stopped",
  ]) {
    if (!events.includes(required)) {
      throw new ProductionError("A release lifecycle event is missing.");
    }
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  child.kill("SIGTERM");
  return Promise.race([
    new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(new ProductionError("The release did not stop gracefully.")),
        20_000,
      ),
    ),
  ]);
}

async function smokeDirectRelease({
  nodeExecutable,
  serverEntrypoint,
  environment,
  port,
  requireReady,
  privateValues,
}) {
  const child = spawn(nodeExecutable, [serverEntrypoint], {
    cwd: os.tmpdir(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (output.length < 1024 * 1024) {
        output += chunk;
      }
    });
  }
  let verificationError;
  try {
    await verifyLocalApplication(port, requireReady);
  } catch (error) {
    verificationError = error;
  }
  const exit = await stopChild(child).catch((error) => {
    child.kill("SIGKILL");
    throw error;
  });
  if (verificationError !== undefined) {
    throw verificationError;
  }
  if (exit.code !== 0 || exit.signal !== null) {
    throw new ProductionError("The release process ended unexpectedly.");
  }
  parsePrivateLifecycleLog(output, privateValues, requireReady);
}

async function transientServiceState(unitName, commandRunner) {
  const shown = await commandRunner("systemctl", [
    "--user",
    "show",
    unitName,
    "--property=Type",
    "--property=MainPID",
    "--property=ActiveState",
    "--property=SubState",
    "--property=InvocationID",
  ]);
  const properties = parseProperties(shown.stdout);
  const mainPid = Number(properties.MainPID);
  if (
    properties.Type !== "exec" ||
    properties.ActiveState !== "active" ||
    properties.SubState !== "running" ||
    !Number.isSafeInteger(mainPid) ||
    mainPid <= 0 ||
    !/^[0-9a-f]{32}$/.test(properties.InvocationID ?? "")
  ) {
    throw new ProductionError("The transient user service state is invalid.");
  }
  return { invocationId: properties.InvocationID, mainPid };
}

async function smokeManagedRelease({
  nodeExecutable,
  serverEntrypoint,
  environment,
  port,
  requireReady,
  knowledgeBasePath,
  commandRunner,
}) {
  const unitName = `indexary-release-smoke-${process.pid}-${randomUUID()}.service`;
  const arguments_ = [
    "--user",
    "--quiet",
    "--collect",
    `--unit=${unitName}`,
    "--service-type=exec",
    "--property=Restart=on-failure",
    "--property=RestartSec=2s",
    "--property=TimeoutStopSec=20s",
    "--property=StandardOutput=journal",
    "--property=StandardError=journal",
    "--property=SyslogIdentifier=indexary",
    `--working-directory=${os.tmpdir()}`,
    ...Object.entries(environment).map(
      ([name, value]) => `--setenv=${name}=${value}`,
    ),
    nodeExecutable,
    serverEntrypoint,
  ];
  await commandRunner("systemd-run", arguments_);
  let active = true;
  let first;
  let second;
  try {
    await verifyLocalApplication(port, requireReady);
    first = await transientServiceState(unitName, commandRunner);
    const executable = await realpath(`/proc/${first.mainPid}/exe`).catch(
      () => undefined,
    );
    if (executable !== (await realpath(nodeExecutable))) {
      throw new ProductionError(
        "The transient user service is not running the bundled runtime.",
      );
    }
    await commandRunner("systemctl", ["--user", "restart", unitName]);
    await verifyLocalApplication(port, requireReady);
    second = await eventually(async () => {
      const state = await transientServiceState(unitName, commandRunner);
      if (
        state.invocationId === first.invocationId ||
        state.mainPid === first.mainPid
      ) {
        throw new ProductionError(
          "The transient user service restart was not observed.",
        );
      }
      return state;
    });
    await readInvocationEvents(
      first.invocationId,
      commandRunner,
      [
        "starting",
        "runtime-preflight-passed",
        "listening",
        "stopping",
        "stopped",
      ],
      unitName,
    );
    await commandRunner("systemctl", ["--user", "stop", unitName]);
    active = false;
    await readInvocationEvents(
      second.invocationId,
      commandRunner,
      [
        "starting",
        "runtime-preflight-passed",
        "listening",
        ...(requireReady ? ["ready"] : []),
        "stopping",
        "stopped",
      ],
      unitName,
    );
    const journal = await commandRunner("journalctl", [
      `--user-unit=${unitName}`,
      "SYSLOG_IDENTIFIER=indexary",
      "--output=cat",
      "--no-pager",
    ]);
    if (journal.stdout.includes(knowledgeBasePath)) {
      throw new ProductionError(
        "The transient service journal exposed private configuration.",
      );
    }
  } finally {
    if (active) {
      await commandRunner("systemctl", ["--user", "stop", unitName]).catch(
        () => undefined,
      );
    }
  }
}

export async function smokeRelease(
  {
    releaseDirectory,
    knowledgeBasePath,
    managed = false,
    requireReady = true,
    cacheRoot,
  },
  dependencies = {},
) {
  const release = requireAbsolute(releaseDirectory, "Release directory");
  const root = requireAbsolute(knowledgeBasePath, "Knowledge Base path");
  const manifest = await validateRelease(release);
  const rootMetadata = await stat(root).catch(() => undefined);
  if (rootMetadata === undefined || !rootMetadata.isDirectory()) {
    throw new ProductionError(
      "The explicitly selected Knowledge Base cannot be read.",
    );
  }
  const temporaryCache =
    cacheRoot === undefined
      ? await import("node:fs/promises").then(({ mkdtemp }) =>
          mkdtemp(path.join(os.tmpdir(), "indexary-release-cache-")),
        )
      : requireAbsolute(cacheRoot, "Release smoke cache root");
  const port = await unusedLoopbackPort();
  const nodeExecutable = path.join(release, "runtime/bin/node");
  const serverEntrypoint = path.join(release, manifest.application.server);
  const webRoot = path.join(release, "app/web/dist");
  const environment = releaseEnvironment({
    knowledgeBasePath: root,
    cacheRoot: temporaryCache,
    webRoot,
    port,
  });
  const before = await fingerprintTree(root);
  let smokeError;
  try {
    if (managed) {
      await smokeManagedRelease({
        nodeExecutable,
        serverEntrypoint,
        environment,
        port,
        requireReady,
        knowledgeBasePath: root,
        commandRunner: dependencies.runCommand ?? runCommand,
      });
    } else {
      await smokeDirectRelease({
        nodeExecutable,
        serverEntrypoint,
        environment,
        port,
        requireReady,
        privateValues: [root, temporaryCache],
      });
    }
  } catch (error) {
    smokeError = error;
  }
  const after = await fingerprintTree(root).catch(() => undefined);
  if (cacheRoot === undefined) {
    await rm(temporaryCache, { recursive: true, force: true });
  }
  if (after === undefined || before !== after) {
    throw new ProductionError(
      "The Knowledge Base differs from its byte-for-byte pre-smoke state.",
      { cause: smokeError },
    );
  }
  await validateRelease(release);
  if (smokeError !== undefined) {
    throw smokeError;
  }
  return manifest;
}
