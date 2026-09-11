import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
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
  readDiscoveredDocument,
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

async function findCatalogFile(cacheRoot: string): Promise<string> {
  const catalogRelative = (await readdir(cacheRoot, { recursive: true }))
    .map(String)
    .find((entry) => entry.endsWith("catalog.sqlite"));
  expect(catalogRelative).toBeDefined();
  return path.join(cacheRoot, catalogRelative!);
}

async function waitForCandidate(cacheRoot: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const candidate = (await readdir(cacheRoot, { recursive: true }))
      .map(String)
      .find((entry) => path.basename(entry).startsWith(".catalog-candidate-"));
    if (candidate !== undefined) {
      return path.join(cacheRoot, candidate);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for an index candidate.");
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

    expect(knowledgeBase.status()).toEqual({
      state: "ready",
      degradedCount: 3,
      homeDocument: "available",
    });
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

  test("opens legal Linux backslash names without treating them as separators", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-backslash-"));
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(root, cacheRoot);
    const folderName = "Раздел\\архив";
    const documentName = "C:\\Документ.md";
    const materialName = "источник\\данные.bin";
    const attachmentName = "вложение\\архив.bin";
    await mkdir(path.join(root, folderName));
    await writeFile(
      path.join(root, "index.md"),
      `---\noriginals: ['${materialName}']\n---\n# Главная\n\n[Архив](вложение%5Cархив.bin)\n`,
    );
    await writeFile(path.join(root, materialName), "material");
    await writeFile(path.join(root, attachmentName), "attachment");
    await writeFile(
      path.join(root, folderName, documentName),
      "# Обратная косая черта\n",
    );
    const knowledgeBase = createKnowledgeBase(root, {
      cacheRoot,
      profile: "backslash",
    });

    await knowledgeBase.initialize();

    await expect(knowledgeBase.browseFolder(folderName)).resolves.toMatchObject(
      {
        path: folderName,
        documents: [
          {
            path: `${folderName}/${documentName}`,
            title: "Обратная косая черта",
          },
        ],
      },
    );
    await expect(
      knowledgeBase.openDocument(`${folderName}/${documentName}`),
    ).resolves.toMatchObject({ path: `${folderName}/${documentName}` });
    const home = await knowledgeBase.openHomeDocument();
    expect(home?.materials.sourceMaterials[0]).toMatchObject({
      path: materialName,
      status: "available",
    });
    expect(home?.materials.attachments[0]).toMatchObject({
      path: attachmentName,
      status: "available",
    });
    const openedMaterial = await knowledgeBase.openMaterial(
      "index.md",
      "source-material-0",
    );
    expect(openedMaterial).toMatchObject({ size: 8 });
    await openedMaterial?.file.close();
    const openedAttachment = await knowledgeBase.openMaterial(
      "index.md",
      "attachment-0",
    );
    expect(openedAttachment).toMatchObject({ size: 10 });
    await openedAttachment?.file.close();
  });

  test("rechecks the opened Document descriptor after a discovered path is replaced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-document-fd-"));
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "indexary-document-fd-outside-"),
    );
    temporaryDirectories.push(root, outside);
    const discoveredPath = path.join(root, "Документ.md");
    const movedPath = path.join(root, "Сохранённый.md");
    const outsidePath = path.join(outside, "private.md");
    await writeFile(discoveredPath, "# Безопасно\n");
    await writeFile(outsidePath, "# Private\nsecret\n");
    const canonicalRoot = await realpath(root);
    const canonicalDocument = await realpath(discoveredPath);
    await rename(discoveredPath, movedPath);
    await symlink(outsidePath, discoveredPath);

    await expect(
      readDiscoveredDocument(canonicalRoot, canonicalDocument),
    ).rejects.toThrow("left the Knowledge Base");
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
    expect(fixtureCatalog).toContain(`catalog-v4${path.sep}fixture`);
    const catalogFile = path.join(cacheRoot, fixtureCatalog!);
    const database = new DatabaseSync(catalogFile, {
      readOnly: true,
    });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 4,
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
    const identity = Object.fromEntries(
      (
        database
          .prepare(
            "SELECT key, value FROM catalog_metadata WHERE key IN ('knowledge-base-id', 'profile', 'schema-version')",
          )
          .all() as Array<{ key: string; value: string }>
      ).map((row) => [row.key, row.value]),
    );
    expect(identity).toMatchObject({
      profile: "fixture",
      "schema-version": "4",
      "knowledge-base-id": expect.stringMatching(/^[a-f0-9]{24}$/),
    });
    expect(JSON.stringify(identity)).not.toContain(root);
    database.close();
    const compatibleCatalogBefore = await stat(catalogFile);
    const initialRevision = (await fixtureProfile.openHomeDocument())?.revision;
    await Promise.all([fixtureProfile.close(), personalProfile.close()]);

    const reused = createKnowledgeBase(root, {
      cacheRoot,
      profile: "fixture",
    });
    await reused.initialize();
    expect((await reused.openHomeDocument())?.revision).toBe(initialRevision);
    const compatibleCatalogAfter = await stat(catalogFile);
    expect(compatibleCatalogAfter.ino).toBe(compatibleCatalogBefore.ino);
    expect(compatibleCatalogAfter.mtimeMs).toBe(
      compatibleCatalogBefore.mtimeMs,
    );
    await reused.close();

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
    await rebuilt.close();
  });

  test("recovers corrupt and incompatible indexes through validated atomic candidates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-recovery-"));
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(root, cacheRoot);
    await writeFile(
      path.join(root, "index.md"),
      "# Главная\n\nВосстановлено.\n",
    );
    const before = await captureTree(root);

    const first = createKnowledgeBase(root, { cacheRoot, profile: "recovery" });
    await first.initialize();
    await first.close();
    const catalogFile = await findCatalogFile(cacheRoot);

    await writeFile(catalogFile, "not a sqlite database");
    const corruptRecovery = createKnowledgeBase(root, {
      cacheRoot,
      profile: "recovery",
    });
    await corruptRecovery.initialize();
    expect(await corruptRecovery.openHomeDocument()).toMatchObject({
      title: "Главная",
    });
    await corruptRecovery.close();

    const incompatible = new DatabaseSync(catalogFile);
    incompatible.exec("PRAGMA user_version = 999");
    incompatible.close();
    const incompatibleRecovery = createKnowledgeBase(root, {
      cacheRoot,
      profile: "recovery",
    });
    await incompatibleRecovery.initialize();
    expect(incompatibleRecovery.status()).toMatchObject({ state: "ready" });
    expect(
      (await readdir(path.dirname(catalogFile))).filter((entry) =>
        entry.startsWith(".catalog-candidate-"),
      ),
    ).toEqual([]);
    await incompatibleRecovery.close();
    expect(await captureTree(root)).toEqual(before);
  });

  test("rebuilds caches missing any required schema object", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-schema-"));
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(root, cacheRoot);
    await writeFile(path.join(root, "index.md"), "# Главная\n");

    const first = createKnowledgeBase(root, { cacheRoot, profile: "schema" });
    await first.initialize();
    await first.close();
    const catalogFile = await findCatalogFile(cacheRoot);
    const requiredSchemaObjects = [
      { type: "TABLE", name: "folders" },
      { type: "TABLE", name: "documents" },
      { type: "TABLE", name: "materials" },
      { type: "TABLE", name: "document_tags" },
      { type: "TABLE", name: "document_metadata" },
      { type: "TABLE", name: "document_search" },
      { type: "TABLE", name: "diagnostics" },
      { type: "TABLE", name: "link_edges" },
      { type: "TABLE", name: "catalog_metadata" },
      { type: "INDEX", name: "document_tags_normalized" },
    ];

    for (const schemaObject of requiredSchemaObjects) {
      const incompatible = new DatabaseSync(catalogFile);
      incompatible.exec("PRAGMA foreign_keys = OFF");
      incompatible.exec(`DROP ${schemaObject.type} ${schemaObject.name}`);
      incompatible.close();

      const recovered = createKnowledgeBase(root, {
        cacheRoot,
        profile: "schema",
      });
      await recovered.initialize();
      expect(recovered.status()).toMatchObject({ state: "ready" });
      await recovered.close();

      const verified = new DatabaseSync(catalogFile, { readOnly: true });
      expect(
        verified
          .prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?")
          .get(schemaObject.type.toLowerCase(), schemaObject.name),
      ).toBeDefined();
      verified.close();
    }

    const invalidMetadata = [
      { key: "revision" },
      { key: "degraded-count", value: "-1" },
      { key: "source-fingerprint", value: "not-a-fingerprint" },
    ];
    for (const metadata of invalidMetadata) {
      const incompatible = new DatabaseSync(catalogFile);
      if (metadata.value === undefined) {
        incompatible
          .prepare("DELETE FROM catalog_metadata WHERE key = ?")
          .run(metadata.key);
      } else {
        incompatible
          .prepare("UPDATE catalog_metadata SET value = ? WHERE key = ?")
          .run(metadata.value, metadata.key);
      }
      incompatible.close();

      const recovered = createKnowledgeBase(root, {
        cacheRoot,
        profile: "schema",
      });
      await recovered.initialize();
      expect(recovered.status()).toMatchObject({ state: "ready" });
      expect(await recovered.openHomeDocument()).toMatchObject({
        title: "Главная",
      });
      await recovered.close();
    }
  });

  test("removes abandoned candidates and preserves a usable index after failed startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-interrupt-"));
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(root, cacheRoot);
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    const before = await captureTree(root);

    const first = createKnowledgeBase(root, {
      cacheRoot,
      profile: "interrupt",
    });
    await first.initialize();
    await first.close();
    const catalogFile = await findCatalogFile(cacheRoot);
    const abandoned = path.join(
      path.dirname(catalogFile),
      ".catalog-candidate-interrupted.sqlite",
    );
    await writeFile(abandoned, "partial");

    const recovered = createKnowledgeBase(root, {
      cacheRoot,
      profile: "interrupt",
    });
    await recovered.initialize();
    expect(await recovered.openHomeDocument()).toMatchObject({
      title: "Главная",
    });
    await expect(readFile(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
    await recovered.close();
    const catalogBeforeFailure = await readFile(catalogFile);

    const unavailableRoot = `${root}-temporarily-unavailable`;
    await rename(root, unavailableRoot);
    const failed = createKnowledgeBase(root, {
      cacheRoot,
      profile: "interrupt",
    });
    await failed.initialize();
    expect(failed.status()).toEqual({ state: "knowledge-base-unavailable" });
    expect(await readFile(catalogFile)).toEqual(catalogBeforeFailure);
    await failed.close();
    await rename(unavailableRoot, root);
    expect(await captureTree(root)).toEqual(before);
  });

  test("keeps unreadable Documents isolated and reports degraded readiness", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-unreadable-"));
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(root, cacheRoot);
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    const unreadablePath = path.join(root, "Недоступный.md");
    await writeFile(unreadablePath, "# Секрет\n");
    await chmod(unreadablePath, 0o000);

    try {
      const knowledgeBase = createKnowledgeBase(root, {
        cacheRoot,
        profile: "unreadable",
      });
      await knowledgeBase.initialize();
      expect(knowledgeBase.status()).toEqual({
        state: "ready",
        degradedCount: 1,
        homeDocument: "available",
      });
      expect(await knowledgeBase.openDocument("Недоступный.md")).toMatchObject({
        diagnostics: [{ code: "DOCUMENT_UNREADABLE" }],
      });
      await knowledgeBase.close();
    } finally {
      await chmod(unreadablePath, 0o600);
    }
  });

  test("reconciles a Document created while the first candidate is building", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-race-"));
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-cache-"));
    temporaryDirectories.push(root, cacheRoot);
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await Promise.all(
      Array.from({ length: 1_500 }, (_, index) =>
        writeFile(path.join(root, `Документ-${index}.md`), `# ${index}\n`),
      ),
    );

    const knowledgeBase = createKnowledgeBase(root, {
      cacheRoot,
      profile: "startup-race",
    });
    const initialization = knowledgeBase.initialize();
    await waitForCandidate(cacheRoot);
    await writeFile(path.join(root, "Поздний.md"), "# Поздний\n");
    await initialization;

    expect(knowledgeBase.status()).toMatchObject({ state: "ready" });
    expect(await knowledgeBase.openDocument("Поздний.md")).toMatchObject({
      title: "Поздний",
    });
    await knowledgeBase.close();
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
      state: "knowledge-base-unavailable",
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
      state: "ready",
      degradedCount: 0,
      homeDocument: "unavailable",
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
      state: "ready",
      degradedCount: 1,
      homeDocument: "unavailable",
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
