import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { setTimeout as delayFor } from "node:timers/promises";

import { createKnowledgeBase } from "../apps/server/dist/index.js";

const DOCUMENT_COUNT = 2_000;
const CHILD_FLAG = "--rebuild-child";

async function findCatalogFile(cacheRoot) {
  const relative = (await readdir(cacheRoot, { recursive: true }))
    .map(String)
    .find((entry) => entry.endsWith("catalog.sqlite"));
  if (relative === undefined) {
    throw new Error("The initial catalog was not created.");
  }
  return path.join(cacheRoot, relative);
}

async function waitForCandidate(cacheRoot) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const candidates = (await readdir(cacheRoot, { recursive: true }))
      .map(String)
      .filter((entry) =>
        path.basename(entry).startsWith(".catalog-candidate-"),
      );
    if (candidates.length > 0) {
      return candidates;
    }
    await delayFor(2);
  }
  throw new Error("Timed out waiting for the rebuild candidate.");
}

async function fingerprint(root) {
  const hash = createHash("sha256");
  const entries = (await readdir(root, { recursive: true }))
    .map(String)
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const entry of entries) {
    hash.update(entry);
    const absolute = path.join(root, entry);
    try {
      hash.update(await readFile(absolute));
    } catch (error) {
      if (error.code !== "EISDIR") {
        throw error;
      }
    }
  }
  return hash.digest("hex");
}

async function runChild(root, cacheRoot) {
  const knowledgeBase = createKnowledgeBase(root, {
    cacheRoot,
    profile: "interruption",
  });
  await knowledgeBase.initialize();
  await new Promise(() => undefined);
}

async function verifyInterruption() {
  const root = await mkdtemp(path.join(os.tmpdir(), "indexary-interrupt-kb-"));
  const cacheRoot = await mkdtemp(
    path.join(os.tmpdir(), "indexary-interrupt-cache-"),
  );
  let child;
  try {
    await writeFile(path.join(root, "index.md"), "# Stable\n");
    const initial = createKnowledgeBase(root, {
      cacheRoot,
      profile: "interruption",
    });
    await initial.initialize();
    await initial.close();
    const catalogFile = await findCatalogFile(cacheRoot);
    const authoritativeBefore = await readFile(catalogFile);

    await Promise.all(
      Array.from({ length: DOCUMENT_COUNT }, (_, index) =>
        writeFile(path.join(root, `document-${index}.md`), `# ${index}\n`),
      ),
    );
    const knowledgeBaseBefore = await fingerprint(root);
    child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), CHILD_FLAG, root, cacheRoot],
      { stdio: "ignore" },
    );
    const abandonedCandidates = await waitForCandidate(cacheRoot);
    child.kill("SIGKILL");
    await once(child, "exit");
    child = undefined;

    const authoritativeAfterKill = await readFile(catalogFile);
    if (!authoritativeAfterKill.equals(authoritativeBefore)) {
      throw new Error("An interrupted candidate replaced the usable catalog.");
    }

    const recovered = createKnowledgeBase(root, {
      cacheRoot,
      profile: "interruption",
    });
    await recovered.initialize();
    const recoveredDocument = await recovered.openDocument(
      `document-${DOCUMENT_COUNT - 1}.md`,
    );
    await recovered.close();
    if (recoveredDocument?.title !== String(DOCUMENT_COUNT - 1)) {
      throw new Error("The clean rebuild did not recover current Documents.");
    }
    const candidatesAfterRecovery = (
      await readdir(path.dirname(catalogFile))
    ).filter((entry) => entry.startsWith(".catalog-candidate-"));
    if (candidatesAfterRecovery.length > 0) {
      throw new Error("Abandoned candidates remained after recovery.");
    }
    if ((await fingerprint(root)) !== knowledgeBaseBefore) {
      throw new Error("Interruption recovery changed the Knowledge Base.");
    }

    console.log(
      JSON.stringify({
        interruptedCandidateFiles: abandonedCandidates.length,
        precedingCatalogPreserved: true,
        recoveredDocuments: DOCUMENT_COUNT + 1,
        knowledgeBaseUnchanged: true,
      }),
    );
  } finally {
    child?.kill("SIGKILL");
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(cacheRoot, { recursive: true, force: true }),
    ]);
  }
}

if (process.argv[2] === CHILD_FLAG) {
  await runChild(process.argv[3], process.argv[4]);
} else {
  await verifyInterruption();
}
