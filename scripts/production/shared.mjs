import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

export class ProductionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ProductionError";
  }
}

export function requireAbsolutePath(value, label, message) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    !path.isAbsolute(value)
  ) {
    throw new ProductionError(
      message ?? `${label} must be an absolute single-line path.`,
    );
  }
  return path.resolve(value);
}

export function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Atomic rename is the primary guarantee; directory fsync adds durability
    // on filesystems that permit syncing directory handles.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeAtomicFile(
  file,
  contents,
  { mode = 0o600, directoryMode } = {},
) {
  await mkdir(path.dirname(file), {
    recursive: true,
    ...(directoryMode === undefined ? {} : { mode: directoryMode }),
  });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}-${process.pid}-${randomUUID()}`,
  );
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function fetchWithDeadline(
  url,
  { errorMessage, timeoutMilliseconds = 2_000, ...options },
) {
  try {
    return await globalThis.fetch(url, {
      ...options,
      signal: globalThis.AbortSignal.timeout(timeoutMilliseconds),
      redirect: "error",
    });
  } catch (error) {
    throw new ProductionError(errorMessage, { cause: error });
  }
}

export async function retryWithin(
  action,
  {
    timeoutMilliseconds = 60_000,
    delayMilliseconds = 100,
    beforeAttempt,
    timeoutMessage,
  } = {},
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    await beforeAttempt?.();
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await delay(delayMilliseconds);
    }
  }
  throw (
    lastError ??
    new ProductionError(
      timeoutMessage ?? "A bounded production operation timed out.",
    )
  );
}
