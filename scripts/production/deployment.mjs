import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  atomicSelectRelease,
  buildImmutableRelease,
  fingerprintTree,
  ProductionError,
  productionDefaults,
  readInstalledConfiguration,
  renderEnvironmentFile,
  resolveXdgPaths,
  runCommand,
  unusedLoopbackPort,
  validateRelease,
  verifyManagedService,
} from "./production.mjs";
import {
  fetchWithDeadline,
  isContainedPath,
  requireAbsolutePath,
  retryWithin,
  syncDirectory,
  writeAtomicFile,
} from "./shared.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const TRANSACTION_SCHEMA_VERSION = 2;
const HISTORY_SCHEMA_VERSION = 1;
const RELEASE_ID_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const TERMINAL_TRANSACTION_STATUSES = new Set([
  "rolled-back",
  "locally-verified",
]);
const TRANSACTION_STATUSES = new Set([
  "checking",
  "staging",
  "staged",
  "candidate-starting",
  "candidate-running",
  "candidate-verified",
  "activating",
  "activated",
  "verifying",
  "locally-verified",
  "rolling-back",
  "rolled-back",
  "rollback-failed",
]);
const LEGACY_TRANSACTION_STATUSES = new Set([
  "checking",
  "staging",
  "staged",
  "candidate-verified",
  "activating",
  "activated",
  "verifying",
  "verified",
  "rolling-back",
  "rolled-back",
  "rollback-failed",
]);

function requireAbsolute(value, label) {
  return requireAbsolutePath(value, label);
}

function transactionPath(paths) {
  return path.join(paths.stateRoot, "deployment.json");
}

function historyPath(paths) {
  return path.join(paths.stateRoot, "successful-releases.json");
}

function lockPath(paths) {
  return path.join(paths.stateRoot, "deployment.lock");
}

async function writeAtomic(file, contents, mode = 0o600) {
  await writeAtomicFile(file, contents, { mode, directoryMode: 0o700 });
}

function validReleaseId(value) {
  return typeof value === "string" && RELEASE_ID_PATTERN.test(value);
}

function validCandidateProcess(value) {
  return (
    value === null ||
    (value !== null &&
      typeof value === "object" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      value.processGroupId === value.pid &&
      typeof value.startTimeTicks === "string" &&
      /^[1-9]\d*$/.test(value.startTimeTicks))
  );
}

function validTransactionBase(value, statuses) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.transactionId === "string" &&
    /^[0-9a-f-]{36}$/.test(value.transactionId) &&
    statuses.has(value.status) &&
    validReleaseId(value.previousReleaseId) &&
    (value.candidateReleaseId === null ||
      validReleaseId(value.candidateReleaseId)) &&
    typeof value.startedAt === "string" &&
    !Number.isNaN(Date.parse(value.startedAt)) &&
    typeof value.updatedAt === "string" &&
    !Number.isNaN(Date.parse(value.updatedAt)) &&
    typeof value.rehearsal === "boolean"
  );
}

function normalizeTransaction(value) {
  if (
    value?.schemaVersion === 1 &&
    validTransactionBase(value, LEGACY_TRANSACTION_STATUSES)
  ) {
    return {
      ...value,
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      status: value.status === "verified" ? "locally-verified" : value.status,
      candidateProcess: null,
      candidatePort: null,
      candidateCachePath: null,
    };
  }
  if (
    value?.schemaVersion === TRANSACTION_SCHEMA_VERSION &&
    validTransactionBase(value, TRANSACTION_STATUSES) &&
    validCandidateProcess(value.candidateProcess) &&
    (value.candidatePort === null ||
      (Number.isSafeInteger(value.candidatePort) &&
        value.candidatePort >= 1 &&
        value.candidatePort <= 65_535)) &&
    (value.candidateCachePath === null ||
      (typeof value.candidateCachePath === "string" &&
        path.isAbsolute(value.candidateCachePath) &&
        !/[\0\n\r]/.test(value.candidateCachePath))) &&
    validCandidateState(value)
  ) {
    return value;
  }
  return undefined;
}

function validCandidateState(value) {
  const hasCache = value.candidateCachePath !== null;
  const hasPort = value.candidatePort !== null;
  const hasProcess = value.candidateProcess !== null;
  if (value.status === "candidate-starting") {
    return hasCache && hasPort && !hasProcess;
  }
  if (value.status === "candidate-running") {
    return hasCache && hasPort && hasProcess;
  }
  if (value.status === "rolling-back" || value.status === "rollback-failed") {
    return hasCache === hasPort && (!hasProcess || hasCache);
  }
  return !hasCache && !hasPort && !hasProcess;
}

export async function readDeploymentTransaction(paths = resolveXdgPaths()) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(transactionPath(paths), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw new ProductionError(
      "Deployment transaction state is invalid; run `mise run recover:deployment`.",
      { cause: error },
    );
  }
  const normalized = normalizeTransaction(parsed);
  if (normalized === undefined) {
    throw new ProductionError(
      "Deployment transaction state is invalid; run `mise run recover:deployment`.",
    );
  }
  return normalized;
}

async function writeTransaction(paths, transaction, status, updates = {}) {
  const next = {
    ...transaction,
    ...updates,
    status,
    updatedAt: new Date().toISOString(),
  };
  await writeAtomic(
    transactionPath(paths),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
}

function pidIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function readLinuxProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  let contents;
  try {
    contents = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") {
      return undefined;
    }
    throw new ProductionError("Candidate process identity is unavailable.", {
      cause: error,
    });
  }
  const commandEnd = contents.lastIndexOf(") ");
  if (commandEnd === -1) {
    throw new ProductionError("Candidate process identity is invalid.");
  }
  const fields = contents
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  if (fields[0] === "Z") {
    return undefined;
  }
  const processGroupId = Number(fields[2]);
  const startTimeTicks = fields[19];
  if (
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    startTimeTicks === undefined ||
    !/^[1-9]\d*$/.test(startTimeTicks)
  ) {
    throw new ProductionError("Candidate process identity is invalid.");
  }
  return { pid, processGroupId, startTimeTicks };
}

function sameProcessIdentity(expected, actual) {
  return (
    actual !== undefined &&
    actual.pid === expected.pid &&
    actual.processGroupId === expected.processGroupId &&
    actual.startTimeTicks === expected.startTimeTicks
  );
}

async function waitForRecordedProcessToEnd(identity, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (
      !sameProcessIdentity(
        identity,
        await readLinuxProcessIdentity(identity.pid),
      )
    ) {
      return true;
    }
    await delay(50);
  }
  return false;
}

async function stopRecordedCandidateProcess(identity) {
  const actual = await readLinuxProcessIdentity(identity.pid);
  if (!sameProcessIdentity(identity, actual)) {
    return;
  }
  if (actual.processGroupId !== actual.pid) {
    throw new ProductionError(
      "Recorded candidate process group identity is invalid.",
    );
  }
  try {
    process.kill(-actual.processGroupId, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw new ProductionError(
        "Candidate process group could not be stopped.",
        {
          cause: error,
        },
      );
    }
  }
  if (await waitForRecordedProcessToEnd(identity, 20_000)) {
    return;
  }
  const beforeKill = await readLinuxProcessIdentity(identity.pid);
  if (!sameProcessIdentity(identity, beforeKill)) {
    return;
  }
  try {
    process.kill(-identity.processGroupId, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw new ProductionError(
        "Candidate process group could not be killed.",
        {
          cause: error,
        },
      );
    }
  }
  if (!(await waitForRecordedProcessToEnd(identity, 2_000))) {
    throw new ProductionError("Candidate process group did not stop.");
  }
}

function configuredCandidateCacheRoot(paths) {
  return path.join(paths.cacheRoot, "indexary", "deployment-candidates");
}

async function createCandidateCache(paths) {
  const configuredRoot = configuredCandidateCacheRoot(paths);
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(configuredRoot);
  return mkdtemp(path.join(canonicalRoot, "candidate-"));
}

async function removeValidatedCandidateCache(paths, candidateCachePath) {
  const candidate = requireAbsolute(candidateCachePath, "Candidate cache path");
  if (!/^candidate-[A-Za-z0-9]+$/.test(path.basename(candidate))) {
    throw new ProductionError("Recorded candidate cache path is invalid.");
  }
  const canonicalRoot = await realpath(
    configuredCandidateCacheRoot(paths),
  ).catch((error) => {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  const metadata = await lstat(candidate).catch((error) => {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (metadata === undefined) {
    return;
  }
  if (
    canonicalRoot === undefined ||
    path.dirname(candidate) !== canonicalRoot ||
    !isContainedPath(canonicalRoot, candidate) ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(candidate)) !== candidate
  ) {
    throw new ProductionError("Recorded candidate cache path is invalid.");
  }
  await rm(candidate, { recursive: true });
  await syncDirectory(canonicalRoot);
}

async function cleanCandidateArtifacts(paths, transaction) {
  if (transaction.candidateProcess !== null) {
    await stopRecordedCandidateProcess(transaction.candidateProcess);
  }
  if (transaction.candidateCachePath !== null) {
    await removeValidatedCandidateCache(paths, transaction.candidateCachePath);
  }
}

export async function acquireDeploymentLock(paths = resolveXdgPaths()) {
  await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
  await chmod(paths.stateRoot, 0o700);
  const file = lockPath(paths);
  const nonce = randomUUID();
  const temporary = path.join(paths.stateRoot, `.deployment-lock-${nonce}`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce })}\n`,
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporary, file);
      await rm(temporary, { force: true });
      return async () => {
        const current = await readFile(file, "utf8").catch(() => undefined);
        if (current === undefined) {
          return;
        }
        let owner;
        try {
          owner = JSON.parse(current);
        } catch {
          return;
        }
        if (owner.nonce === nonce) {
          await rm(file, { force: true });
          await syncDirectory(paths.stateRoot);
        }
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error?.code !== "EEXIST") {
        throw new ProductionError(
          "The deployment lock could not be acquired.",
          {
            cause: error,
          },
        );
      }
      let owner;
      try {
        owner = JSON.parse(await readFile(file, "utf8"));
      } catch {
        throw new ProductionError(
          "Deployment lock state is invalid; inspect `mise run deployment:status` before retrying.",
        );
      }
      if (pidIsRunning(owner?.pid)) {
        throw new ProductionError(
          "Another deployment is active; wait for it or inspect `mise run deployment:status`.",
        );
      }
      await rm(file, { force: true });
    }
  }
  throw new ProductionError("The deployment lock could not be acquired.");
}

export async function resolveCurrentRelease(paths = resolveXdgPaths()) {
  const selector = await lstat(paths.currentLink).catch(() => undefined);
  if (selector === undefined || !selector.isSymbolicLink()) {
    throw new ProductionError("The active release selector is invalid.");
  }
  const target = await readlink(paths.currentLink);
  const match = /^releases\/(\d{8}T\d{9}Z-[0-9a-f]{12})$/.exec(target);
  if (match === null) {
    throw new ProductionError(
      "The active release selector does not name a contained release.",
    );
  }
  const releaseId = match[1];
  const releaseDirectory = path.join(paths.releasesRoot, releaseId);
  if (path.dirname(releaseDirectory) !== path.resolve(paths.releasesRoot)) {
    throw new ProductionError(
      "The active release target escapes the release root.",
    );
  }
  const resolved = await realpath(releaseDirectory).catch(() => undefined);
  if (resolved !== releaseDirectory) {
    throw new ProductionError(
      "The active release target is missing or traverses a symbolic link.",
    );
  }
  await validateRelease(releaseDirectory, releaseId);
  return { releaseId, releaseDirectory, target };
}

async function updateInstalledRelease(paths, configuration, releaseId) {
  await writeAtomic(
    paths.environmentFile,
    renderEnvironmentFile({
      knowledgeBasePath: configuration.knowledgeBasePath,
      cacheRoot: paths.cacheRoot,
      webRoot: path.join(paths.currentLink, "app/web/dist"),
      releaseId,
      port: configuration.port,
    }),
  );

  const installationFile = path.join(paths.stateRoot, "installation.json");
  let installation = {};
  try {
    installation = JSON.parse(await readFile(installationFile, "utf8"));
  } catch {
    // The external environment and validated selector remain authoritative.
  }
  await writeAtomic(
    installationFile,
    `${JSON.stringify(
      {
        ...installation,
        schemaVersion: 1,
        releaseId,
        service: productionDefaults.serviceName,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

async function fetchWithin(url, options = {}) {
  return fetchWithDeadline(url, {
    ...options,
    errorMessage:
      "The deployment smoke did not receive a local application response.",
  });
}

async function eventually(action, isInterrupted, timeoutMilliseconds = 60_000) {
  return retryWithin(action, {
    timeoutMilliseconds,
    timeoutMessage: "A bounded deployment check timed out.",
    beforeAttempt: () => {
      const signal = isInterrupted?.();
      if (signal) {
        throw new ProductionError(
          `Deployment interrupted by ${signal}; automatic recovery is required.`,
        );
      }
    },
  });
}

async function responseJson(response, message) {
  try {
    return await response.json();
  } catch (error) {
    throw new ProductionError(message, { cause: error });
  }
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function assertLiveHealth(value) {
  if (!exactKeys(value, ["status"]) || value.status !== "live") {
    throw new ProductionError(
      "Deployment liveness health is not privacy-safe.",
    );
  }
}

function assertReadyHealth(value) {
  if (
    !exactKeys(value, ["status", "homeDocument", "degradedCount"]) ||
    value.status !== "ready" ||
    !["available", "unavailable"].includes(value.homeDocument) ||
    !Number.isSafeInteger(value.degradedCount) ||
    value.degradedCount < 0
  ) {
    throw new ProductionError(
      "Deployment readiness health is not privacy-safe.",
    );
  }
}

async function getJson(
  base,
  route,
  message,
  expectedStatus = 200,
  options = {},
) {
  const response = await fetchWithin(`${base}${route}`, options);
  if (response.status !== expectedStatus) {
    throw new ProductionError(message);
  }
  return { response, body: await responseJson(response, message) };
}

function meaningfulSearchTerm(document) {
  const text = `${document.title ?? ""} ${document.searchableText ?? ""}`;
  return text.match(/[\p{L}\p{N}]{2,}/u)?.[0];
}

async function findMaterialDocument(base, rootCatalog) {
  const folders = [rootCatalog];
  const seen = new Set();
  let selectedDocument;
  let selectedMaterial;
  let selectedSearchTerm;

  while (folders.length > 0 && seen.size < 2_000) {
    const catalog = folders.shift();
    if (
      catalog === null ||
      typeof catalog !== "object" ||
      !Array.isArray(catalog.folders) ||
      !Array.isArray(catalog.documents)
    ) {
      throw new ProductionError("The deployment catalog response is invalid.");
    }
    const catalogPath = typeof catalog.path === "string" ? catalog.path : "";
    if (seen.has(catalogPath)) {
      continue;
    }
    seen.add(catalogPath);

    for (const descriptor of catalog.documents) {
      if (typeof descriptor?.path !== "string" || descriptor.path === "") {
        throw new ProductionError(
          "The deployment catalog response is invalid.",
        );
      }
      const opened = await getJson(
        base,
        `/api/documents?path=${encodeURIComponent(descriptor.path)}`,
        "The deployment Document operation failed.",
      );
      const document = opened.body;
      const materials = [
        ...(Array.isArray(document?.materials?.sourceMaterials)
          ? document.materials.sourceMaterials
          : []),
        ...(Array.isArray(document?.materials?.attachments)
          ? document.materials.attachments
          : []),
      ];
      const material = materials.find(
        (entry) =>
          entry?.status === "available" &&
          typeof entry.id === "string" &&
          entry.id !== "" &&
          Number.isSafeInteger(entry.size) &&
          entry.size > 0,
      );
      const term = meaningfulSearchTerm(document);
      if (material !== undefined && term !== undefined) {
        selectedDocument = document;
        selectedMaterial = material;
        selectedSearchTerm = term;
        break;
      }
    }
    if (selectedDocument !== undefined) {
      break;
    }
    for (const folder of catalog.folders) {
      if (typeof folder?.path !== "string" || folder.path === "") {
        throw new ProductionError(
          "The deployment catalog response is invalid.",
        );
      }
      const nested = await getJson(
        base,
        `/api/catalog?path=${encodeURIComponent(folder.path)}`,
        "The deployment catalog operation failed.",
      );
      folders.push(nested.body);
    }
  }

  if (
    selectedDocument === undefined ||
    selectedMaterial === undefined ||
    selectedSearchTerm === undefined
  ) {
    throw new ProductionError(
      "Deployment smoke requires one available non-empty material and a searchable Document.",
    );
  }
  return {
    document: selectedDocument,
    material: selectedMaterial,
    searchTerm: selectedSearchTerm,
  };
}

export async function verifyDeploymentApplication(
  port,
  { isInterrupted } = {},
) {
  const base = `http://${productionDefaults.host}:${port}`;
  return eventually(async () => {
    const live = await getJson(
      base,
      "/api/health/live",
      "Deployment liveness check failed.",
    );
    assertLiveHealth(live.body);
    const ready = await getJson(
      base,
      "/api/health/ready",
      "Deployment readiness check failed.",
    );
    assertReadyHealth(ready.body);

    const root = await fetchWithin(`${base}/`);
    if (
      root.status !== 200 ||
      !(root.headers.get("content-type") ?? "").includes("text/html")
    ) {
      throw new ProductionError(
        "Deployment same-origin frontend check failed.",
      );
    }

    const home = await fetchWithin(`${base}/api/documents/home`);
    if (ready.body.homeDocument === "available") {
      if (home.status !== 200) {
        throw new ProductionError(
          "Deployment Home Document response is invalid.",
        );
      }
      const document = await responseJson(
        home,
        "Deployment Home Document response is invalid.",
      );
      if (typeof document?.path !== "string" || document.path === "") {
        throw new ProductionError(
          "Deployment Home Document response is invalid.",
        );
      }
    } else {
      if (home.status !== 404) {
        throw new ProductionError(
          "Deployment Home Document state is inconsistent.",
        );
      }
      const missing = await responseJson(
        home,
        "Deployment Home Document state is inconsistent.",
      );
      if (missing?.code !== "HOME_DOCUMENT_NOT_FOUND") {
        throw new ProductionError(
          "Deployment Home Document state is inconsistent.",
        );
      }
    }

    const catalog = await getJson(
      base,
      "/api/catalog",
      "Deployment catalog operation failed.",
    );
    const selected = await findMaterialDocument(base, catalog.body);
    const search = await getJson(
      base,
      `/api/search?q=${encodeURIComponent(selected.searchTerm)}`,
      "Deployment search operation failed.",
    );
    if (
      !Array.isArray(search.body?.results) ||
      !search.body.results.some(
        (result) => result?.path === selected.document.path,
      )
    ) {
      throw new ProductionError(
        "Deployment search did not find the selected Document.",
      );
    }

    const materialRoute =
      `/api/materials?document=${encodeURIComponent(selected.document.path)}` +
      `&id=${encodeURIComponent(selected.material.id)}` +
      (Number.isSafeInteger(selected.document.revision)
        ? `&revision=${selected.document.revision}`
        : "");
    const material = await fetchWithin(`${base}${materialRoute}`, {
      headers: { range: "bytes=0-0" },
    });
    if (
      material.status !== 206 ||
      material.headers.get("content-length") !== "1" ||
      !(material.headers.get("content-range") ?? "").startsWith("bytes 0-0/") ||
      (await material.arrayBuffer()).byteLength !== 1
    ) {
      throw new ProductionError(
        "Deployment material byte-range response is invalid.",
      );
    }
    return {
      homeDocument: ready.body.homeDocument,
      degradedCount: ready.body.degradedCount,
    };
  }, isInterrupted);
}

function candidateEnvironment({ knowledgeBasePath, cacheRoot, webRoot, port }) {
  return {
    HOME: os.tmpdir(),
    PATH: "/nonexistent",
    XDG_CACHE_HOME: cacheRoot,
    INDEXARY_KNOWLEDGE_BASE: knowledgeBasePath,
    INDEXARY_HOST: productionDefaults.host,
    INDEXARY_PORT: String(port),
    INDEXARY_PROFILE: `deploy-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    INDEXARY_CACHE_ROOT: cacheRoot,
    INDEXARY_WEB_ROOT: webRoot,
  };
}

function parseCandidateLog(log, privateValues) {
  for (const privateValue of privateValues) {
    if (privateValue !== "" && log.includes(privateValue)) {
      throw new ProductionError(
        "Candidate lifecycle output exposed private data.",
      );
    }
  }
  const events = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new ProductionError("Candidate lifecycle output is not JSON.", {
          cause: error,
        });
      }
      if (
        !exactKeys(parsed, ["timestamp", "level", "event", "service"]) ||
        parsed.service !== "indexary"
      ) {
        throw new ProductionError("Candidate lifecycle output is invalid.");
      }
      return parsed.event;
    });
  for (const event of [
    "starting",
    "runtime-preflight-passed",
    "listening",
    "ready",
    "stopping",
    "stopped",
  ]) {
    if (!events.includes(event)) {
      throw new ProductionError("Candidate lifecycle output is incomplete.");
    }
  }
}

async function waitForChildExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMilliseconds).then(() => undefined),
  ]);
}

async function stopCandidateProcessGroup(child, identity) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const actual = await readLinuxProcessIdentity(identity.pid);
  if (!sameProcessIdentity(identity, actual)) {
    return waitForChildExit(child, 2_000);
  }
  try {
    process.kill(-identity.processGroupId, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
  let exit = await waitForChildExit(child, 20_000);
  if (exit === undefined) {
    const beforeKill = await readLinuxProcessIdentity(identity.pid);
    if (!sameProcessIdentity(identity, beforeKill)) {
      return waitForChildExit(child, 2_000);
    }
    try {
      process.kill(-identity.processGroupId, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
    await waitForChildExit(child, 2_000);
    throw new ProductionError(
      "The isolated candidate did not stop gracefully.",
    );
  }
  return exit;
}

export async function verifyCandidateRelease(
  {
    releaseDirectory,
    manifest,
    knowledgeBasePath,
    cacheRoot,
    port,
    isInterrupted,
    onStarted,
  },
  applicationVerifier = verifyDeploymentApplication,
) {
  const nodeExecutable = path.join(releaseDirectory, "runtime/bin/node");
  const entrypoint = path.join(releaseDirectory, manifest.application.server);
  const environment = candidateEnvironment({
    knowledgeBasePath,
    cacheRoot,
    webRoot: path.join(releaseDirectory, "app/web/dist"),
    port,
  });
  const child = spawn(nodeExecutable, [entrypoint], {
    cwd: os.tmpdir(),
    env: environment,
    detached: true,
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
  let identity;
  try {
    if (child.pid === undefined) {
      throw new ProductionError("The isolated candidate did not start.");
    }
    identity = await readLinuxProcessIdentity(child.pid);
    if (identity === undefined || identity.processGroupId !== identity.pid) {
      throw new ProductionError(
        "The isolated candidate process identity is invalid.",
      );
    }
    await onStarted?.(identity);
    await applicationVerifier(port, { isInterrupted });
  } catch (error) {
    verificationError = error;
  }
  const exit = await (
    identity === undefined
      ? waitForChildExit(child, 2_000)
      : stopCandidateProcessGroup(child, identity)
  ).catch((error) => {
    verificationError ??= error;
    return undefined;
  });
  if (verificationError !== undefined) {
    throw verificationError;
  }
  if (exit?.code !== 0 || exit.signal !== null) {
    throw new ProductionError("The isolated candidate ended unexpectedly.");
  }
  parseCandidateLog(output, [knowledgeBasePath, cacheRoot]);
}

async function restartAndVerify(
  { paths, configuration, expectedReleaseId, isInterrupted },
  dependencies,
) {
  const commandRunner = dependencies.runCommand ?? runCommand;
  await commandRunner(
    "systemctl",
    ["--user", "restart", productionDefaults.serviceName],
    { timeoutMilliseconds: 120_000 },
  );
  const signal = isInterrupted?.();
  if (signal) {
    throw new ProductionError(
      `Deployment interrupted by ${signal}; automatic recovery is required.`,
    );
  }
  await (
    dependencies.verifyManagedService ??
    ((options) => verifyManagedService(options, commandRunner))
  )({
    paths,
    port: configuration.port,
    knowledgeBasePath: configuration.knowledgeBasePath,
  });
  const current = await resolveCurrentRelease(paths);
  if (current.releaseId !== expectedReleaseId) {
    throw new ProductionError(
      "The managed service release identity is inconsistent.",
    );
  }
  await (dependencies.verifyApplication ?? verifyDeploymentApplication)(
    configuration.port,
    { isInterrupted },
  );
}

async function restorePreviousRelease(
  { paths, transaction, configuration },
  dependencies,
) {
  let current = transaction;
  try {
    current = await writeTransaction(paths, current, "rolling-back");
    await cleanCandidateArtifacts(paths, current);
    current = await writeTransaction(paths, current, "rolling-back", {
      candidateProcess: null,
      candidatePort: null,
      candidateCachePath: null,
    });
    const previousDirectory = path.join(
      paths.releasesRoot,
      current.previousReleaseId,
    );
    await validateRelease(previousDirectory, current.previousReleaseId);
    await (dependencies.atomicSelectRelease ?? atomicSelectRelease)(
      paths,
      previousDirectory,
    );
    await updateInstalledRelease(
      paths,
      configuration,
      current.previousReleaseId,
    );
    await restartAndVerify(
      {
        paths,
        configuration,
        expectedReleaseId: current.previousReleaseId,
        // Recovery must complete even when the initiating signal remains set.
        isInterrupted: undefined,
      },
      dependencies,
    );
    const historyFile = historyPath(paths);
    const history = await readFile(historyFile, "utf8")
      .then((contents) => JSON.parse(contents))
      .catch(() => undefined);
    if (
      history?.schemaVersion === HISTORY_SCHEMA_VERSION &&
      Array.isArray(history.releaseIds) &&
      history.releaseIds.every(validReleaseId)
    ) {
      const restoredHistory = history.releaseIds.filter(
        (releaseId) =>
          releaseId !== current.candidateReleaseId &&
          releaseId !== current.previousReleaseId,
      );
      restoredHistory.push(current.previousReleaseId);
      await writeSuccessfulHistory(paths, restoredHistory);
    }
    current = await writeTransaction(paths, current, "rolled-back");
    dependencies.report?.({
      event: "rollback-complete",
      releaseId: current.previousReleaseId,
    });
    return current;
  } catch (error) {
    await writeTransaction(paths, current, "rollback-failed").catch(
      () => undefined,
    );
    throw new ProductionError(
      `Automatic rollback failed. Run \`mise run recover:deployment\` to restore release ${current.previousReleaseId}.`,
      { cause: error },
    );
  }
}

async function recoverDeploymentUnlocked(paths, dependencies = {}) {
  const transaction = await readDeploymentTransaction(paths);
  if (
    transaction === undefined ||
    TERMINAL_TRANSACTION_STATUSES.has(transaction.status)
  ) {
    return { status: transaction?.status ?? "none", transaction };
  }
  const configuration = await readInstalledConfiguration(paths);
  const recovered = await restorePreviousRelease(
    { paths, transaction, configuration },
    dependencies,
  );
  return { status: "rolled-back", transaction: recovered };
}

export async function recoverDeployment(
  paths = resolveXdgPaths(),
  dependencies = {},
) {
  const releaseLock = await acquireDeploymentLock(paths);
  try {
    return await recoverDeploymentUnlocked(paths, dependencies);
  } finally {
    await releaseLock().catch(() => undefined);
  }
}

async function readSuccessfulHistory(paths, activeReleaseId) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(historyPath(paths), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new ProductionError("Successful release history is invalid.", {
        cause: error,
      });
    }
    return [activeReleaseId];
  }
  if (
    parsed?.schemaVersion !== HISTORY_SCHEMA_VERSION ||
    !Array.isArray(parsed.releaseIds) ||
    parsed.releaseIds.some((id) => !validReleaseId(id))
  ) {
    throw new ProductionError("Successful release history is invalid.");
  }
  const unique = [...new Set(parsed.releaseIds)];
  return unique.includes(activeReleaseId)
    ? unique
    : [...unique, activeReleaseId];
}

async function writeSuccessfulHistory(paths, releaseIds) {
  await writeAtomic(
    historyPath(paths),
    `${JSON.stringify(
      { schemaVersion: HISTORY_SCHEMA_VERSION, releaseIds },
      null,
      2,
    )}\n`,
  );
}

async function makeTreeRemovable(root) {
  async function visit(current) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new ProductionError(
        "Release pruning refuses symbolic-link targets.",
      );
    }
    if (!metadata.isDirectory()) {
      return;
    }
    await chmod(current, 0o700);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(path.join(current, entry.name));
      }
    }
  }
  await visit(root);
}

async function cleanAbandonedStaging(paths) {
  const entries = await readdir(paths.releasesRoot, {
    withFileTypes: true,
  }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  for (const entry of entries) {
    if (
      !/^\.\d{8}T\d{9}Z-[0-9a-f]{12}\.staging-[0-9a-f-]{36}$/.test(entry.name)
    ) {
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ProductionError(
        "An abandoned release staging entry is unsafe to recover automatically.",
      );
    }
    const candidate = path.join(paths.releasesRoot, entry.name);
    if (
      path.dirname(candidate) !== path.resolve(paths.releasesRoot) ||
      (await realpath(candidate)) !== candidate
    ) {
      throw new ProductionError(
        "An abandoned release staging entry escapes the release root.",
      );
    }
    await makeTreeRemovable(candidate);
    await rm(candidate, { recursive: true });
  }
}

export async function pruneSuccessfulReleases(
  paths,
  activeReleaseId,
  successfulReleaseIds,
) {
  if (!validReleaseId(activeReleaseId)) {
    throw new ProductionError("The active release identity is invalid.");
  }
  const ordered = [...new Set(successfulReleaseIds)];
  if (ordered.at(-1) !== activeReleaseId) {
    throw new ProductionError(
      "Successful release history does not end at active.",
    );
  }
  const retained = new Set(ordered.slice(-3));
  const entries = await readdir(paths.releasesRoot, { withFileTypes: true });
  const pruned = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (!validReleaseId(entry.name)) {
      throw new ProductionError("Release pruning found an unknown entry.");
    }
    if (retained.has(entry.name)) {
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new ProductionError(
        "Release pruning refuses a non-directory target.",
      );
    }
    const candidate = path.join(paths.releasesRoot, entry.name);
    if (
      path.dirname(candidate) !== path.resolve(paths.releasesRoot) ||
      (await realpath(candidate)) !== candidate
    ) {
      throw new ProductionError("Release pruning found an escaping target.");
    }
    await validateRelease(candidate, entry.name);
    await makeTreeRemovable(candidate);
    await rm(candidate, { recursive: true });
    pruned.push(entry.name);
  }
  await syncDirectory(paths.releasesRoot);
  return { retained: [...retained], pruned };
}

function checkInterrupted(isInterrupted) {
  const signal = isInterrupted?.();
  if (signal) {
    throw new ProductionError(
      `Deployment interrupted by ${signal}; automatic recovery is required.`,
    );
  }
}

export async function deployRelease(
  {
    paths = resolveXdgPaths(),
    sourceRoot = repositoryRoot,
    rehearseRollback = false,
    isInterrupted,
  } = {},
  dependencies = {},
) {
  const root = requireAbsolute(sourceRoot, "Repository root");
  const commandRunner = dependencies.runCommand ?? runCommand;
  const releaseBuilder =
    dependencies.buildImmutableRelease ?? buildImmutableRelease;
  const candidateVerifier =
    dependencies.verifyCandidate ?? verifyCandidateRelease;
  const portAllocator = dependencies.unusedLoopbackPort ?? unusedLoopbackPort;
  const releaseSelector =
    dependencies.atomicSelectRelease ?? atomicSelectRelease;
  const releaseValidator = dependencies.validateRelease ?? validateRelease;
  const phase = dependencies.phase ?? (async () => undefined);
  const releaseLock = await acquireDeploymentLock(paths);
  let transaction;
  let configuration;
  let beforeFingerprint;
  let candidateCache;
  let operationError;

  try {
    await recoverDeploymentUnlocked(paths, dependencies);
    await cleanAbandonedStaging(paths);
    const previous = await resolveCurrentRelease(paths);
    configuration = await readInstalledConfiguration(paths);
    if (configuration.releaseId !== previous.releaseId) {
      throw new ProductionError(
        "The installed configuration and active release are inconsistent.",
      );
    }
    beforeFingerprint = await fingerprintTree(configuration.knowledgeBasePath);
    const startedAt = new Date().toISOString();
    transaction = await writeTransaction(
      paths,
      {
        schemaVersion: TRANSACTION_SCHEMA_VERSION,
        transactionId: randomUUID(),
        previousReleaseId: previous.releaseId,
        candidateReleaseId: null,
        startedAt,
        updatedAt: startedAt,
        rehearsal: rehearseRollback,
        candidateProcess: null,
        candidatePort: null,
        candidateCachePath: null,
      },
      "checking",
    );

    const status = await commandRunner("git", ["status", "--porcelain"], {
      cwd: root,
    });
    if (status.stdout.trim() !== "") {
      throw new ProductionError(
        "Deployment requires a clean, identifiable source commit.",
      );
    }
    const revision = await commandRunner("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    const expectedCommit = revision.stdout.trim();
    if (!COMMIT_PATTERN.test(expectedCommit)) {
      throw new ProductionError(
        "Deployment requires a clean, identifiable source commit.",
      );
    }
    dependencies.report?.({ event: "quality-gate-starting" });
    await commandRunner("mise", ["run", "check"], { cwd: root });
    dependencies.report?.({ event: "quality-gate-passed" });
    checkInterrupted(isInterrupted);
    await phase("before-staging");
    transaction = await writeTransaction(paths, transaction, "staging");
    const built = await releaseBuilder({
      repositoryRoot: root,
      paths,
      runCommand: commandRunner,
    });
    if (built.manifest.gitCommit !== expectedCommit) {
      throw new ProductionError(
        "The candidate release does not identify the checked commit.",
      );
    }
    await releaseValidator(built.releaseDirectory, built.manifest.releaseId);
    transaction = await writeTransaction(paths, transaction, "staged", {
      candidateReleaseId: built.manifest.releaseId,
    });
    dependencies.report?.({
      event: "candidate-staged",
      releaseId: built.manifest.releaseId,
    });
    await phase("after-staging");
    checkInterrupted(isInterrupted);

    candidateCache = await createCandidateCache(paths);
    const candidatePort = await portAllocator();
    transaction = await writeTransaction(
      paths,
      transaction,
      "candidate-starting",
      {
        candidateCachePath: candidateCache,
        candidatePort,
      },
    );
    await candidateVerifier(
      {
        releaseDirectory: built.releaseDirectory,
        manifest: built.manifest,
        knowledgeBasePath: configuration.knowledgeBasePath,
        cacheRoot: candidateCache,
        port: candidatePort,
        isInterrupted,
        onStarted: async (identity) => {
          if (!validCandidateProcess(identity) || identity === null) {
            throw new ProductionError(
              "The candidate process identity is invalid.",
            );
          }
          transaction = await writeTransaction(
            paths,
            transaction,
            "candidate-running",
            { candidateProcess: identity },
          );
        },
      },
      dependencies.verifyApplication ?? verifyDeploymentApplication,
    );
    await removeValidatedCandidateCache(paths, candidateCache);
    candidateCache = undefined;
    transaction = await writeTransaction(
      paths,
      transaction,
      "candidate-verified",
      {
        candidateProcess: null,
        candidatePort: null,
        candidateCachePath: null,
      },
    );
    dependencies.report?.({ event: "candidate-smoke-passed" });
    checkInterrupted(isInterrupted);
    await phase("before-activation");
    transaction = await writeTransaction(paths, transaction, "activating");
    dependencies.report?.({
      event: "brief-downtime-starting",
      releaseId: built.manifest.releaseId,
    });
    await releaseSelector(paths, built.releaseDirectory);
    await updateInstalledRelease(
      paths,
      configuration,
      built.manifest.releaseId,
    );
    transaction = await writeTransaction(paths, transaction, "activated");
    await phase("after-activation");
    checkInterrupted(isInterrupted);

    transaction = await writeTransaction(paths, transaction, "verifying");
    await restartAndVerify(
      {
        paths,
        configuration,
        expectedReleaseId: built.manifest.releaseId,
        isInterrupted,
      },
      dependencies,
    );
    await phase("after-post-check");
    checkInterrupted(isInterrupted);
    if (rehearseRollback) {
      throw new ProductionError(
        "Controlled post-activation failure requested for rollback rehearsal.",
      );
    }

    const afterFingerprint = await fingerprintTree(
      configuration.knowledgeBasePath,
    );
    if (afterFingerprint !== beforeFingerprint) {
      throw new ProductionError(
        "The Knowledge Base differs from its byte-for-byte pre-deployment state.",
      );
    }
    checkInterrupted(isInterrupted);

    const history = await readSuccessfulHistory(paths, previous.releaseId);
    const nextHistory = [
      ...history.filter((releaseId) => releaseId !== built.manifest.releaseId),
      built.manifest.releaseId,
    ];
    await writeSuccessfulHistory(paths, nextHistory);
    await updateInstalledRelease(
      paths,
      configuration,
      built.manifest.releaseId,
    );
    const retention = await pruneSuccessfulReleases(
      paths,
      built.manifest.releaseId,
      nextHistory,
    );
    transaction = await writeTransaction(
      paths,
      transaction,
      "locally-verified",
    );
    dependencies.report?.({
      event: "deployment-locally-verified",
      releaseId: built.manifest.releaseId,
    });
    return {
      status: "locally-verified",
      releaseId: built.manifest.releaseId,
      previousReleaseId: previous.releaseId,
      retention,
    };
  } catch (error) {
    operationError = error;
    if (transaction !== undefined && configuration !== undefined) {
      try {
        transaction = await restorePreviousRelease(
          { paths, transaction, configuration, isInterrupted },
          dependencies,
        );
      } catch (rollbackError) {
        operationError = rollbackError;
      }
    }
  } finally {
    if (candidateCache !== undefined) {
      await removeValidatedCandidateCache(paths, candidateCache).catch(
        () => undefined,
      );
    }
    await releaseLock().catch(() => undefined);
  }

  if (configuration !== undefined && beforeFingerprint !== undefined) {
    const afterFingerprint = await fingerprintTree(
      configuration.knowledgeBasePath,
    ).catch(() => undefined);
    if (afterFingerprint !== beforeFingerprint) {
      throw new ProductionError(
        "The Knowledge Base differs from its byte-for-byte pre-deployment state.",
        { cause: operationError },
      );
    }
  }
  throw operationError;
}

export async function deploymentStatus(paths = resolveXdgPaths()) {
  const transaction = await readDeploymentTransaction(paths);
  if (transaction === undefined) {
    return { status: "none", action: "mise run deploy" };
  }
  return {
    status: transaction.status,
    previousReleaseId: transaction.previousReleaseId,
    candidateReleaseId: transaction.candidateReleaseId,
    action: TERMINAL_TRANSACTION_STATUSES.has(transaction.status)
      ? "mise run deploy"
      : "mise run recover:deployment",
  };
}
