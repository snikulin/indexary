import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createKnowledgeBase } from "../src/knowledge-base/index.js";
import { captureTree } from "./helpers.js";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../fixtures/knowledge-base",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Knowledge Base", () => {
  test("opens the root Home Document without changing a byte", async () => {
    const before = await captureTree(fixtureRoot);
    const knowledgeBase = createKnowledgeBase(fixtureRoot);

    expect(knowledgeBase.status()).toEqual({ state: "initializing" });
    await knowledgeBase.initialize();
    const document = await knowledgeBase.openHomeDocument();

    expect(knowledgeBase.status()).toEqual({ state: "ready" });
    expect(document).toMatchObject({
      path: "index.md",
      title: "Добро пожаловать в Индексари",
    });
    expect(document?.html).toContain("синтетическая База знаний");
    expect(await captureTree(fixtureRoot)).toEqual(before);
  });

  test("does not substitute another Document when /index.md is absent", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "indexary-missing-home-"),
    );
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "another.md"), "# Другой Документ\n");
    const knowledgeBase = createKnowledgeBase(root);

    await knowledgeBase.initialize();

    expect(knowledgeBase.status()).toEqual({
      state: "home-document-unavailable",
    });
    await expect(knowledgeBase.openHomeDocument()).resolves.toBeUndefined();
  });

  test("does not follow a Home Document link outside the canonical root", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "indexary-contained-home-"),
    );
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "indexary-outside-home-"),
    );
    temporaryDirectories.push(root, outside);
    const externalDocument = path.join(outside, "index.md");
    await writeFile(externalDocument, "# External\n\nprivate\n");
    await symlink(externalDocument, path.join(root, "index.md"));
    const knowledgeBase = createKnowledgeBase(root);

    await knowledgeBase.initialize();

    expect(knowledgeBase.status()).toEqual({
      state: "home-document-unavailable",
    });
    await expect(knowledgeBase.openHomeDocument()).resolves.toBeUndefined();
  });

  test("escapes active HTML in the tracer representation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-safe-home-"));
    temporaryDirectories.push(root);
    await writeFile(
      path.join(root, "index.md"),
      "# Безопасно\n\n<script>alert(1)</script>\n",
    );
    const knowledgeBase = createKnowledgeBase(root);

    await knowledgeBase.initialize();

    expect((await knowledgeBase.openHomeDocument())?.html).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });
});
