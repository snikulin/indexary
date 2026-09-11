import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const separator = process.argv.indexOf("--");
const command = process.argv.slice(separator + 1);

if (separator === -1 || command.length === 0) {
  console.error("Usage: verify-fixture-read-only.mjs -- <command> [args...]");
  process.exit(2);
}

const fixtureRoot = path.resolve("fixtures/knowledge-base");

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

const before = await fingerprintTree(fixtureRoot);
const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
const after = await fingerprintTree(fixtureRoot);

if (before !== after) {
  console.error("The synthetic Knowledge Base changed while the command ran.");
  process.exit(1);
}

if (exit.signal) {
  process.kill(process.pid, exit.signal);
} else {
  process.exit(exit.code ?? 1);
}
