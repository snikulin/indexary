import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { setTimeout as delayFor } from "node:timers/promises";

import { createKnowledgeBase } from "../apps/server/dist/index.js";

const DOCUMENT_COUNT = 10_000;
const MATERIAL_BYTES = 1_000_000;
const COLD_INDEX_TARGET_MS = 30_000;
const SEARCH_TARGET_MS = 200;
const EVENT_LOOP_TARGET_MS = 200;
const BATCH_SIZE = 256;

async function batches(count, operation) {
  for (let start = 0; start < count; start += BATCH_SIZE) {
    await Promise.all(
      Array.from({ length: Math.min(BATCH_SIZE, count - start) }, (_, offset) =>
        operation(start + offset),
      ),
    );
  }
}

async function workloadFingerprint(root) {
  const entries = (await readdir(root, { recursive: true }))
    .map(String)
    .sort((left, right) => left.localeCompare(right, "en"));
  const hash = createHash("sha256");
  let materialBytes = 0;
  for (const entry of entries) {
    const absolute = path.join(root, entry);
    const metadata = await stat(absolute);
    hash.update(entry);
    hash.update(String(metadata.size));
    if (entry.endsWith(".md")) {
      hash.update(await readFile(absolute));
    } else if (metadata.isFile()) {
      materialBytes += metadata.size;
    }
  }
  return { digest: hash.digest("hex"), materialBytes };
}

async function generateWorkload(root) {
  const materials = path.join(root, "materials");
  await mkdir(materials);
  await batches(DOCUMENT_COUNT, async (index) => {
    const id = String(index).padStart(5, "0");
    const material = path.join(materials, `material-${id}.bin`);
    const handle = await open(material, "w");
    try {
      await handle.truncate(MATERIAL_BYTES);
    } finally {
      await handle.close();
    }
    await writeFile(
      path.join(root, index === 0 ? "index.md" : `document-${id}.md`),
      `---\ntitle: Generated Document ${id}\ntags: [group-${index % 100}]\noriginals: [materials/material-${id}.bin]\n---\n# Generated Document ${id}\n\nmarker${id} representative searchable text.\n`,
    );
  });
}

const root = await mkdtemp(path.join(os.tmpdir(), "indexary-benchmark-kb-"));
const cacheRoot = await mkdtemp(
  path.join(os.tmpdir(), "indexary-benchmark-cache-"),
);

try {
  await generateWorkload(root);
  const before = await workloadFingerprint(root);
  if (before.materialBytes !== DOCUMENT_COUNT * MATERIAL_BYTES) {
    throw new Error("The generated workload is not exactly 10 GB.");
  }

  const delay = monitorEventLoopDelay({ resolution: 10 });
  const knowledgeBase = createKnowledgeBase(root, {
    cacheRoot,
    profile: "support-target",
  });
  delay.enable();
  const indexStarted = performance.now();
  await knowledgeBase.initialize();
  const coldIndexMs = performance.now() - indexStarted;

  const searches = [
    { query: "marker09999" },
    { query: '"representative searchable"', tag: "group-99" },
    { tag: "group-42" },
  ];
  const searchMs = [];
  for (const request of searches) {
    const started = performance.now();
    const results = await knowledgeBase.searchDocuments(request);
    searchMs.push(performance.now() - started);
    if (results.length === 0) {
      throw new Error(
        "A representative search unexpectedly returned no results.",
      );
    }
  }
  await delayFor(20);
  delay.disable();
  const maxEventLoopDelayMs = Number(delay.max) / 1_000_000;
  await knowledgeBase.close();
  const after = await workloadFingerprint(root);

  const report = {
    documents: DOCUMENT_COUNT,
    materialBytes: before.materialBytes,
    coldIndexMs: Math.round(coldIndexMs * 100) / 100,
    maxSearchMs: Math.round(Math.max(...searchMs) * 100) / 100,
    maxEventLoopDelayMs: Math.round(maxEventLoopDelayMs * 100) / 100,
    knowledgeBaseUnchanged: before.digest === after.digest,
    targets: {
      coldIndexMs: COLD_INDEX_TARGET_MS,
      searchMs: SEARCH_TARGET_MS,
      eventLoopDelayMs: EVENT_LOOP_TARGET_MS,
    },
  };
  console.log(JSON.stringify(report, null, 2));

  if (
    coldIndexMs >= COLD_INDEX_TARGET_MS ||
    Math.max(...searchMs) >= SEARCH_TARGET_MS ||
    maxEventLoopDelayMs >= EVENT_LOOP_TARGET_MS ||
    before.digest !== after.digest
  ) {
    process.exitCode = 1;
  }
} finally {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(cacheRoot, { recursive: true, force: true }),
  ]);
}
