import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import {
  createKnowledgeBase,
  InvalidKnowledgeBasePath,
} from "../src/knowledge-base/index.js";
import { captureTree } from "./helpers.js";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../fixtures/knowledge-base",
);
const temporaryDirectories: string[] = [];

async function createTestKnowledgeBase(root: string, profile: string) {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
  temporaryDirectories.push(cacheRoot);
  return createKnowledgeBase(root, { cacheRoot, profile });
}

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
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(cacheRoot);
    const knowledgeBase = createKnowledgeBase(fixtureRoot, {
      cacheRoot,
      profile: "fixture-test",
    });

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

  test("catalogs the complete visible hierarchy without caps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-catalog-"));
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(root, cacheRoot);
    await mkdir(path.join(root, "Раздел с пробелом", "Глубже"), {
      recursive: true,
    });
    await mkdir(path.join(root, "tools"));
    await mkdir(path.join(root, ".hidden"));
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await writeFile(
      path.join(root, "Раздел с пробелом", "Кириллица.md"),
      "# Кириллица\n",
    );
    await writeFile(
      path.join(root, "Раздел с пробелом", "Глубже", "Финал.md"),
      "# Финал\n",
    );
    await writeFile(path.join(root, "tools", "Справка.md"), "# Справка\n");
    await writeFile(path.join(root, ".secret.md"), "# Секрет\n");
    await writeFile(path.join(root, ".hidden", "private.md"), "# Private\n");
    for (let index = 0; index < 125; index += 1) {
      await writeFile(
        path.join(root, `Документ ${String(index).padStart(3, "0")}.md`),
        `# Документ ${index}\n`,
      );
    }

    const knowledgeBase = createKnowledgeBase(root, {
      cacheRoot,
      profile: "complete",
    });
    await knowledgeBase.initialize();

    const catalogRoot = await knowledgeBase.browseFolder();
    expect(catalogRoot?.folders.map((folder) => folder.path)).toEqual([
      "tools",
      "Раздел с пробелом",
    ]);
    expect(catalogRoot?.documents).toHaveLength(126);
    expect(
      catalogRoot?.documents.some((item) => item.path.startsWith(".")),
    ).toBe(false);
    await expect(
      knowledgeBase.browseFolder("Раздел с пробелом"),
    ).resolves.toMatchObject({
      folders: [{ path: "Раздел с пробелом/Глубже", name: "Глубже" }],
      documents: [
        { path: "Раздел с пробелом/Кириллица.md", title: "Кириллица" },
      ],
    });
    await expect(
      knowledgeBase.openDocument("Раздел с пробелом/Глубже/Финал.md"),
    ).resolves.toMatchObject({ title: "Финал" });
  });

  test("deduplicates internal links and safely diagnoses external and cyclic links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-links-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "indexary-outside-"));
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(root, outside, cacheRoot);
    await mkdir(path.join(root, "Раздел"));
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await writeFile(path.join(root, "Раздел", "Один.md"), "# Один\n");
    await writeFile(path.join(outside, "private.md"), "# Private\nsecret\n");
    await symlink(
      path.join(root, "Раздел", "Один.md"),
      path.join(root, "Дубликат.md"),
    );
    await symlink(
      path.join(root, "Раздел"),
      path.join(root, "Связанный раздел"),
    );
    await symlink(outside, path.join(root, "Наружу"));
    await symlink(root, path.join(root, "Раздел", "Цикл"));

    const knowledgeBase = createKnowledgeBase(root, {
      cacheRoot,
      profile: "links",
    });
    await knowledgeBase.initialize();
    const catalogRoot = await knowledgeBase.browseFolder();
    const nested = await knowledgeBase.browseFolder("Раздел");

    expect([
      ...(catalogRoot?.documents ?? []),
      ...(nested?.documents ?? []),
    ]).toHaveLength(2);
    expect(catalogRoot?.folders).toEqual([{ path: "Раздел", name: "Раздел" }]);
    expect(catalogRoot?.diagnostics).toEqual([
      {
        code: "SYMLINK_EXTERNAL",
        path: "Наружу",
        message: "Символическая ссылка за пределы Базы знаний пропущена.",
      },
      {
        code: "SYMLINK_CYCLIC",
        path: "Раздел/Цикл",
        message: "Циклическая символическая ссылка пропущена.",
      },
    ]);
    expect(JSON.stringify(catalogRoot)).not.toContain("secret");
    expect(JSON.stringify(catalogRoot)).not.toContain(outside);
  });

  test("rejects non-canonical, absolute, and traversal paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-paths-"));
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(root, cacheRoot);
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    const knowledgeBase = createKnowledgeBase(root, {
      cacheRoot,
      profile: "paths",
    });
    await knowledgeBase.initialize();

    for (const invalid of [
      "../private.md",
      "folder/../index.md",
      "/etc/passwd",
      "C:\\private.md",
      "folder\\document.md",
      ".",
    ]) {
      await expect(knowledgeBase.openDocument(invalid)).rejects.toBeInstanceOf(
        InvalidKnowledgeBasePath,
      );
      await expect(knowledgeBase.browseFolder(invalid)).rejects.toBeInstanceOf(
        InvalidKnowledgeBasePath,
      );
    }
  });

  test("builds a versioned rebuildable SQLite catalog in isolated namespaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-sqlite-"));
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(root, cacheRoot);
    await writeFile(path.join(root, "index.md"), "# Главная\n");

    const fixtureProfile = createKnowledgeBase(root, {
      cacheRoot,
      profile: "fixture",
    });
    const personalProfile = createKnowledgeBase(root, {
      cacheRoot,
      profile: "personal",
    });
    await Promise.all([
      fixtureProfile.initialize(),
      personalProfile.initialize(),
    ]);

    const catalogFiles = (await readdir(cacheRoot, { recursive: true }))
      .map(String)
      .filter((entry) => entry.endsWith("catalog.sqlite"));
    expect(catalogFiles).toHaveLength(2);
    const fixtureCatalog = catalogFiles.find((entry) =>
      entry.includes(`${path.sep}fixture${path.sep}`),
    );
    const personalCatalog = catalogFiles.find((entry) =>
      entry.includes(`${path.sep}personal${path.sep}`),
    );
    expect(fixtureCatalog).toBeDefined();
    expect(personalCatalog).toBeDefined();
    expect(fixtureCatalog).not.toBe(personalCatalog);
    expect(fixtureCatalog).toContain(`catalog-v1${path.sep}fixture`);
    const database = new DatabaseSync(path.join(cacheRoot, fixtureCatalog!), {
      readOnly: true,
    });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 1,
    });
    database.close();

    await writeFile(path.join(root, "Новый.md"), "# Новый\n");
    const rebuilt = createKnowledgeBase(root, {
      cacheRoot,
      profile: "fixture",
    });
    await rebuilt.initialize();
    expect((await rebuilt.browseFolder())?.documents).toContainEqual({
      path: "Новый.md",
      title: "Новый",
    });
  });

  test("refuses a cache symlink that would write inside the Knowledge Base", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "indexary-cache-boundary-"),
    );
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "indexary-cache-link-"),
    );
    temporaryDirectories.push(root, outside);
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await symlink(root, path.join(outside, "cache-link"));
    const before = await captureTree(root);
    const knowledgeBase = createKnowledgeBase(root, {
      cacheRoot: path.join(outside, "cache-link", "owned"),
      profile: "contained-cache",
    });

    await knowledgeBase.initialize();

    expect(knowledgeBase.status()).toEqual({
      state: "home-document-unavailable",
    });
    expect(await captureTree(root)).toEqual(before);
  });

  test("does not substitute another Document when /index.md is absent", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "indexary-missing-home-"),
    );
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "another.md"), "# Другой Документ\n");
    const knowledgeBase = await createTestKnowledgeBase(root, "missing-home");

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
    const knowledgeBase = await createTestKnowledgeBase(root, "external-home");

    await knowledgeBase.initialize();

    expect(knowledgeBase.status()).toEqual({
      state: "home-document-unavailable",
    });
    await expect(knowledgeBase.openHomeDocument()).resolves.toBeUndefined();
  });

  test("removes active HTML and reports a content-safe diagnostic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-safe-home-"));
    temporaryDirectories.push(root);
    await writeFile(
      path.join(root, "index.md"),
      "# Безопасно\n\n<script>alert(1)</script>\n",
    );
    const knowledgeBase = await createTestKnowledgeBase(root, "safe-home");

    await knowledgeBase.initialize();

    const document = await knowledgeBase.openHomeDocument();
    expect(document?.html).not.toContain("script");
    expect(document?.diagnostics).toContainEqual({
      code: "RAW_HTML_REMOVED",
      message: "Небезопасный HTML удалён из Документа.",
    });
  });
});
