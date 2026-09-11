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
  buildSafeFtsQuery,
  createKnowledgeBase,
  InvalidKnowledgeBasePath,
  KnowledgeBaseStartupError,
  verifyFts5Support,
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
    expect(fixtureCatalog).toContain(`catalog-v3${path.sep}fixture`);
    const database = new DatabaseSync(path.join(cacheRoot, fixtureCatalog!), {
      readOnly: true,
    });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 3,
    });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('document_search', 'document_tags', 'document_metadata') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "document_metadata" },
      { name: "document_search" },
      { name: "document_tags" },
    ]);
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

  test("derives outgoing links and safe backlinks from the rendered interpretation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-graph-"));
    temporaryDirectories.push(root);
    await Promise.all(
      ["Раздел", "Глубже", "а", "б"].map((folder) =>
        mkdir(path.join(root, folder)),
      ),
    );
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await writeFile(path.join(root, "Цель.md"), "# Корневая цель\n");
    await writeFile(path.join(root, "Раздел", "Цель.md"), "# Локальная цель\n");
    await writeFile(
      path.join(root, "Глубже", "Единственная.md"),
      "# Единственная\n",
    );
    await writeFile(path.join(root, "а", "Дубль.md"), "# Первый дубль\n");
    await writeFile(path.join(root, "б", "Дубль.md"), "# Второй дубль\n");
    await writeFile(
      path.join(root, "Раздел", "Источник.md"),
      `# Источник

Безопасный контекст [[Цель|локальная цель]] после. <script>alert("secret")</script>

Корневая [[/Цель]], уникальная [[Единственная]], отсутствует [[Нет]] и неоднозначна [[Дубль]].
`,
    );
    const before = await captureTree(root);
    const knowledgeBase = await createTestKnowledgeBase(root, "graph");
    await knowledgeBase.initialize();

    const source = await knowledgeBase.openDocument("Раздел/Источник.md");
    expect(source?.outgoingLinks).toMatchObject([
      { label: "локальная цель", state: "resolved", path: "Раздел/Цель.md" },
      { state: "resolved", path: "Цель.md" },
      { state: "resolved", path: "Глубже/Единственная.md" },
      { state: "missing" },
      { state: "ambiguous" },
    ]);
    expect(source?.html).toContain(
      "/documents/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB/%D0%A6%D0%B5%D0%BB%D1%8C.md",
    );
    expect(source?.html).toContain("wikilink-missing");
    expect(source?.html).toContain("wikilink-ambiguous");

    const localTarget = await knowledgeBase.openDocument("Раздел/Цель.md");
    expect(localTarget?.backlinks).toMatchObject([
      {
        path: "Раздел/Источник.md",
        title: "Источник",
      },
    ]);
    expect(localTarget?.backlinks[0]?.snippet).toContain(
      "Безопасный контекст [[Цель|локальная цель]] после.",
    );
    expect(JSON.stringify(localTarget?.backlinks)).not.toContain("<script>");
    expect(await captureTree(root)).toEqual(before);
  });

  test("rebuilds the same graph regardless of file creation order", async () => {
    const roots = await Promise.all([
      mkdtemp(path.join(os.tmpdir(), "indexary-order-a-")),
      mkdtemp(path.join(os.tmpdir(), "indexary-order-b-")),
    ]);
    temporaryDirectories.push(...roots);
    const documents = new Map([
      ["index.md", "# Главная\n\n[[Цель]] и [[Дубль]].\n"],
      ["папка/Цель.md", "# Цель\n"],
      ["а/Дубль.md", "# Дубль А\n"],
      ["б/Дубль.md", "# Дубль Б\n"],
    ]);

    for (const [rootIndex, root] of roots.entries()) {
      const entries = [...documents.entries()];
      if (rootIndex === 1) {
        entries.reverse();
      }
      for (const [relativePath, content] of entries) {
        await mkdir(path.dirname(path.join(root, relativePath)), {
          recursive: true,
        });
        await writeFile(path.join(root, relativePath), content);
      }
    }

    const graphs = [];
    for (const [index, root] of roots.entries()) {
      const knowledgeBase = await createTestKnowledgeBase(
        root,
        `order-${index}`,
      );
      await knowledgeBase.initialize();
      graphs.push({
        home: await knowledgeBase.openHomeDocument(),
        target: await knowledgeBase.openDocument("папка/Цель.md"),
      });
    }
    expect(graphs[0]?.home?.outgoingLinks).toEqual(
      graphs[1]?.home?.outgoingLinks,
    );
    expect(graphs[0]?.target?.backlinks).toEqual(graphs[1]?.target?.backlinks);
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

  test("searches weighted Document fields with safe useful snippets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-search-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await writeFile(
      path.join(root, "Заголовок.md"),
      "---\ntitle: Квантовый компас\n---\nОбычный текст.\n",
    );
    await writeFile(
      path.join(root, "Тег.md"),
      "---\ntags: [квантовый, 'важное: сейчас']\n---\n# Метка\n\nОбычный текст.\n",
    );
    await writeFile(
      path.join(root, "Каталог-квантовый.md"),
      "# Маршрут\n\nОбычный текст.\n",
    );
    await writeFile(
      path.join(root, "Метаданные.md"),
      "---\nstatus: квантовый\ncount: 2048\n---\n# Свойства\n\nОбычный текст.\n",
    );
    await writeFile(
      path.join(root, "Тело.md"),
      "# Тело\n\nКвантовый сигнал. Быстрый бурый лис. Кот и коты. Проектирование.\n",
    );
    await writeFile(
      path.join(root, "Только коты.md"),
      "# Множественное\n\nКоты.\n",
    );
    await writeFile(
      path.join(root, "Опасный.md"),
      "# Безопасный фрагмент\n\n`<img src=x onerror=boom>`\n",
    );
    await writeFile(path.join(root, "Акцент.md"), "# Акцент\n\nCafé.\n");
    await writeFile(path.join(root, "Без акцента.md"), "# Plain\n\nCafe.\n");
    await writeFile(path.join(root, "материал.pdf"), "binarysecret\n");
    await writeFile(path.join(root, "архив.bin"), "attachmentsecret\n");
    await writeFile(
      path.join(root, "Материалы.md"),
      "---\noriginals: [материал.pdf]\n---\n# Материалы\n\n[архив](архив.bin)\n",
    );
    const before = await captureTree(root);
    const knowledgeBase = await createTestKnowledgeBase(root, "search");
    await knowledgeBase.initialize();

    const weighted = await knowledgeBase.searchDocuments({
      query: "квантовый",
    });
    const order = weighted.map((result) => result.path);
    expect(order.indexOf("Заголовок.md")).toBeLessThan(
      order.indexOf("Тело.md"),
    );
    expect(order.indexOf("Тег.md")).toBeLessThan(order.indexOf("Тело.md"));
    expect(order.indexOf("Каталог-квантовый.md")).toBeLessThan(
      order.indexOf("Тело.md"),
    );
    expect(order.indexOf("Метаданные.md")).toBeLessThan(
      order.indexOf("Тело.md"),
    );
    expect(weighted.every((result) => result.snippet.length > 0)).toBe(true);
    expect(
      weighted.some((result) =>
        result.snippet.some((part) => part.highlighted),
      ),
    ).toBe(true);

    await expect(
      knowledgeBase.searchDocuments({ query: '"быстрый бурый"' }),
    ).resolves.toEqual([expect.objectContaining({ path: "Тело.md" })]);
    await expect(
      knowledgeBase.searchDocuments({ query: "проект*" }),
    ).resolves.toEqual([expect.objectContaining({ path: "Тело.md" })]);
    await expect(
      knowledgeBase.searchDocuments({ query: "кот" }),
    ).resolves.toEqual([expect.objectContaining({ path: "Тело.md" })]);
    await expect(
      knowledgeBase.searchDocuments({ query: "café" }),
    ).resolves.toEqual([expect.objectContaining({ path: "Акцент.md" })]);
    await expect(
      knowledgeBase.searchDocuments({ query: "cafe" }),
    ).resolves.toEqual([expect.objectContaining({ path: "Без акцента.md" })]);
    await expect(
      knowledgeBase.searchDocuments({ tag: "ВАЖНОЕ: СЕЙЧАС" }),
    ).resolves.toEqual([
      expect.objectContaining({
        path: "Тег.md",
        snippet: [{ text: "важное: сейчас", highlighted: true }],
      }),
    ]);
    await expect(
      knowledgeBase.searchDocuments({ query: "2048" }),
    ).resolves.toEqual([]);
    await expect(
      knowledgeBase.searchDocuments({ query: "binarysecret" }),
    ).resolves.toEqual([]);
    await expect(
      knowledgeBase.searchDocuments({ query: "attachmentsecret" }),
    ).resolves.toEqual([]);

    const adversarial = await knowledgeBase.searchDocuments({
      query: "onerror OR 1=1 -- NEAR(secret)",
    });
    expect(adversarial).toEqual([]);
    const safeSnippet = await knowledgeBase.searchDocuments({
      query: "onerror",
    });
    expect(safeSnippet).toEqual([
      expect.objectContaining({
        path: "Опасный.md",
        snippet: expect.arrayContaining([
          expect.objectContaining({ text: "onerror", highlighted: true }),
        ]),
      }),
    ]);
    expect(safeSnippet[0]).not.toHaveProperty("html");
    expect(await captureTree(root)).toEqual(before);
  });

  test("returns every search result without a silent cap", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "indexary-search-complete-"),
    );
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await Promise.all(
      Array.from({ length: 125 }, (_, index) =>
        writeFile(
          path.join(root, `Результат ${index}.md`),
          `# Результат ${index}\n\nПолныйсписок\n`,
        ),
      ),
    );
    const knowledgeBase = await createTestKnowledgeBase(root, "uncapped");
    await knowledgeBase.initialize();

    expect(
      await knowledgeBase.searchDocuments({ query: "полныйсписок" }),
    ).toHaveLength(125);
  });
});

describe("safe FTS query construction", () => {
  test("allows only exact words, phrases, and trailing prefixes", () => {
    expect(buildSafeFtsQuery('кот "быстрый лис" проек*')).toBe(
      '"кот" AND "быстрый лис" AND "проек"*',
    );
    expect(buildSafeFtsQuery('OR NEAR(secret) "незакрытая фраза')).toBe(
      '"OR" AND "NEAR" AND "secret" AND "незакрытая фраза"',
    );
    expect(buildSafeFtsQuery("*** -- ()")).toBeUndefined();
  });

  test("reports a clear operational error when FTS5 is unavailable", () => {
    expect(() =>
      verifyFts5Support({
        exec() {
          throw new Error("no such module: fts5");
        },
      }),
    ).toThrowError(KnowledgeBaseStartupError);
    expect(() =>
      verifyFts5Support({
        exec() {
          throw new Error("no such module: fts5");
        },
      }),
    ).toThrow(/pinned Node 24 runtime.*SQLite FTS5/);
  });
});
