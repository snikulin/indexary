import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delayFor } from "node:timers/promises";

const configuredRoot = process.env.INDEXARY_KB_PATH;

if (configuredRoot === undefined || configuredRoot.trim() === "") {
  console.error(
    "Set INDEXARY_KB_PATH to an explicitly selected Knowledge Base before running the personal smoke.",
  );
  process.exit(2);
}

async function fingerprintTree(root) {
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
        hash.update(await readFile(absolutePath));
      } else {
        hash.update("other\0");
      }
    }
  }

  await visit(root);
  return hash.digest("hex");
}

async function main() {
  const root = path.resolve(configuredRoot);
  let before;
  try {
    before = await fingerprintTree(root);
  } catch {
    console.error("The explicitly selected Knowledge Base cannot be read.");
    process.exitCode = 1;
    return;
  }

  console.log(
    "Personal smoke started. Complete the documented checklist, restore the external test edit, then press Ctrl+C.",
  );
  const child = spawn(
    "pnpm",
    ["run", "dev", "--", "--profile", "personal-smoke", "--port", "4175"],
    {
      detached: true,
      stdio: "inherit",
      env: {
        ...process.env,
        INDEXARY_KNOWLEDGE_BASE: root,
      },
    },
  );

  function signalChildGroup(signal) {
    if (child.pid === undefined) {
      return;
    }

    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => signalChildGroup(signal));
  }

  const exit = await new Promise((resolve) => {
    child.once("error", () => resolve({ code: 1, signal: undefined }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (child.pid !== undefined) {
    const shutdownDeadline = Date.now() + 5_000;
    while (Date.now() < shutdownDeadline) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") {
          break;
        }
        throw error;
      }
      await delayFor(25);
    }

    try {
      process.kill(-child.pid, 0);
      signalChildGroup("SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }

  let after;
  try {
    after = await fingerprintTree(root);
  } catch {
    console.error(
      "The Knowledge Base could not be verified after the personal smoke.",
    );
    process.exitCode = 1;
    return;
  }

  if (before !== after) {
    console.error(
      "The Knowledge Base differs from its byte-for-byte pre-smoke state.",
    );
    process.exitCode = 1;
    return;
  }

  const stoppedNormally =
    exit.code === 0 ||
    exit.signal === "SIGINT" ||
    exit.signal === "SIGTERM" ||
    exit.code === 130 ||
    exit.code === 143;
  if (!stoppedNormally) {
    console.error(
      "The personal smoke process ended unexpectedly; the Knowledge Base is unchanged.",
    );
    process.exitCode = exit.code ?? 1;
    return;
  }

  console.log("Personal smoke finished with the Knowledge Base unchanged.");
}

await main();
