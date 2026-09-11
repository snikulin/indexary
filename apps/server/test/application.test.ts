import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildApplication, parseByteRange } from "../src/application.js";
import type { RuntimeConfig } from "../src/config.js";
import { captureTree } from "./helpers.js";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../fixtures/knowledge-base",
);
const temporaryDirectories: string[] = [];
let testCacheRoot: string;

function config(knowledgeBasePath: string, webRoot?: string): RuntimeConfig {
  return {
    knowledgeBasePath,
    host: "127.0.0.1",
    port: 4173,
    profile: "test",
    cacheRoot: testCacheRoot,
    ...(webRoot === undefined ? {} : { webRoot }),
  };
}

beforeEach(async () => {
  testCacheRoot = await mkdtemp(path.join(os.tmpdir(), "indexary-app-cache-"));
  temporaryDirectories.push(testCacheRoot);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("assembled Fastify application", () => {
  test("exposes liveness, readiness, and the Home Document through validated responses", async () => {
    const before = await captureTree(fixtureRoot);
    const app = await buildApplication(config(fixtureRoot));

    const live = await app.inject({ method: "GET", url: "/api/health/live" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "live" });

    await app.ready();
    const home = await app.inject({
      method: "GET",
      url: "/api/documents/home",
    });
    expect(home.statusCode).toBe(200);
    expect(home.json()).toMatchObject({
      path: "index.md",
      title: "Добро пожаловать в Индексари",
      tags: [],
      properties: [],
      diagnostics: [],
    });
    expect(home.json()).toHaveProperty("searchableText");
    expect(home.json()).not.toHaveProperty("markdown");

    const ready = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: "ready",
      homeDocument: "available",
    });
    await app.close();
    expect(await captureTree(fixtureRoot)).toEqual(before);
  });

  test("serves a malformed Document diagnostic without losing readiness", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "indexary-malformed-home-"),
    );
    temporaryDirectories.push(root);
    await writeFile(
      path.join(root, "index.md"),
      "---\ntags: [сломано\n---\n# Доступный Документ\n\nТекст остаётся доступен.\n",
    );
    const app = await buildApplication(config(root));
    await app.ready();

    const home = await app.inject("/api/documents/home");
    expect(home.statusCode).toBe(200);
    expect(home.json()).toMatchObject({
      title: "Доступный Документ",
      diagnostics: [{ code: "FRONTMATTER_INVALID" }],
    });
    expect(home.json().html).toContain("Текст остаётся доступен");
    expect((await app.inject("/api/health/ready")).statusCode).toBe(200);
    await app.close();
  });

  test("keeps liveness up and reports a clear non-fatal missing Home Document", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-no-index-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "somewhere.md"), "# Не домашний\n");
    const app = await buildApplication(config(root));
    await app.ready();

    const home = await app.inject({
      method: "GET",
      url: "/api/documents/home",
    });
    expect(home.statusCode).toBe(404);
    expect(home.json()).toEqual({
      code: "HOME_DOCUMENT_NOT_FOUND",
      message: "Домашний документ /index.md недоступен.",
    });

    expect((await app.inject("/api/health/live")).statusCode).toBe(200);
    const ready = await app.inject("/api/health/ready");
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: "not-ready",
      reason: "home-document-unavailable",
    });
    await app.close();
  });

  test("serves optimized web assets and the application interface from one origin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-web-root-"));
    temporaryDirectories.push(root);
    const assets = path.join(root, "assets");
    await mkdir(assets);
    await writeFile(
      path.join(root, "index.html"),
      '<main lang="ru">Атлас</main>',
    );
    await writeFile(path.join(assets, "application.js"), "export {};\n");
    const app = await buildApplication(config(fixtureRoot, root));
    await app.ready();

    expect((await app.inject("/")).body).toContain("Атлас");
    expect((await app.inject("/assets/application.js")).statusCode).toBe(200);
    expect((await app.inject("/api/documents/home")).statusCode).toBe(200);
    expect((await app.inject("/documents/nested/example.md")).body).toContain(
      "Атлас",
    );
    expect((await app.inject("/folders/nested")).body).toContain("Атлас");
    await app.close();
  });

  test("browses immediate folder children and opens encoded nested Document paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-browse-app-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "Раздел с пробелом", "Глубже"), {
      recursive: true,
    });
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await writeFile(
      path.join(root, "Раздел с пробелом", "Документ.md"),
      "# Вложенный\n\nСодержимое\n",
    );
    await writeFile(
      path.join(root, "Раздел с пробелом", "Глубже", "Ещё.md"),
      "# Ещё\n",
    );
    const app = await buildApplication(config(root));
    await app.ready();

    const rootCatalog = await app.inject("/api/catalog");
    expect(rootCatalog.statusCode).toBe(200);
    expect(rootCatalog.json()).toMatchObject({
      path: "",
      folders: [{ path: "Раздел с пробелом" }],
      documents: [{ path: "index.md", title: "Главная" }],
    });

    const folder = await app.inject({
      method: "GET",
      url: "/api/catalog",
      query: { path: "Раздел с пробелом" },
    });
    expect(folder.statusCode).toBe(200);
    expect(folder.json()).toMatchObject({
      path: "Раздел с пробелом",
      folders: [{ path: "Раздел с пробелом/Глубже" }],
      documents: [
        { path: "Раздел с пробелом/Документ.md", title: "Вложенный" },
      ],
    });

    const document = await app.inject({
      method: "GET",
      url: "/api/documents",
      query: { path: "Раздел с пробелом/Документ.md" },
    });
    expect(document.statusCode).toBe(200);
    expect(document.json()).toMatchObject({
      path: "Раздел с пробелом/Документ.md",
      title: "Вложенный",
    });
    await app.close();
  });

  test("returns structured errors for traversal and absolute path requests", async () => {
    const app = await buildApplication(config(fixtureRoot));
    await app.ready();

    for (const candidate of ["../private.md", "/etc/passwd", "a/../index.md"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/documents",
        query: { path: candidate },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: "INVALID_KNOWLEDGE_BASE_PATH",
        message: "Путь внутри Базы знаний недопустим.",
      });
    }
    await app.close();
  });

  test("indexes only referenced materials with root and Document-relative resolution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-materials-"));
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "indexary-materials-outside-"),
    );
    temporaryDirectories.push(root, outside);
    await mkdir(path.join(root, "Раздел", "локально"), { recursive: true });
    await mkdir(path.join(root, "materials"));
    await mkdir(path.join(root, "files"));
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await writeFile(path.join(root, "materials", "source.pdf"), "PDF-source");
    await writeFile(path.join(root, "materials", "legacy.eml"), "mail");
    await writeFile(path.join(root, "files", "data.bin"), "0123456789");
    await writeFile(path.join(root, "files", "unreferenced.bin"), "hidden");
    await writeFile(path.join(outside, "private.bin"), "private-host-data");
    await symlink(
      path.join(outside, "private.bin"),
      path.join(root, "files", "external.bin"),
    );
    await writeFile(
      path.join(root, "Раздел", "Материалы.md"),
      `---
originals:
  - materials/source.pdf
  - materials/missing.pdf
  - /etc/passwd
original_path: materials/legacy.eml
---
# Материалы

[Повтор источника](../materials/source.pdf)
[Данные](../files/data.bin)
[Нет файла](локально/missing.docx)
[Внешняя ссылка](../files/external.bin)
[Абсолютный путь](/etc/shadow)
[Другой Документ](../index.md)
`,
    );
    const before = await captureTree(root);
    const app = await buildApplication(config(root));
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/documents",
      query: { path: "Раздел/Материалы.md" },
    });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.materials.sourceMaterials).toMatchObject([
      {
        id: "source-material-0",
        path: "materials/source.pdf",
        status: "available",
        mimeType: "application/pdf",
        preview: "pdf",
      },
      {
        status: "missing",
        diagnostic: { code: "MATERIAL_MISSING" },
      },
      {
        path: "passwd",
        status: "invalid",
        diagnostic: { code: "MATERIAL_INVALID_PATH" },
      },
      {
        path: "materials/legacy.eml",
        status: "available",
        mimeType: "message/rfc822",
        preview: "unsupported",
      },
    ]);
    expect(document.materials.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "files/data.bin",
          status: "available",
          mimeType: "application/octet-stream",
        }),
        expect.objectContaining({
          path: "Раздел/локально/missing.docx",
          status: "missing",
        }),
        expect.objectContaining({
          name: "external.bin",
          status: "invalid",
          diagnostic: expect.objectContaining({ code: "MATERIAL_EXTERNAL" }),
        }),
        expect.objectContaining({
          name: "shadow",
          status: "invalid",
          diagnostic: expect.objectContaining({
            code: "MATERIAL_INVALID_PATH",
          }),
        }),
      ]),
    );
    expect(document).not.toHaveProperty("attachmentPaths");
    expect(
      document.materials.attachments.some(
        (material: { path: string }) =>
          material.path === "materials/source.pdf" ||
          material.path.endsWith("index.md") ||
          material.path.includes("unreferenced"),
      ),
    ).toBe(false);
    expect(JSON.stringify(document.materials)).not.toContain(outside);
    expect(JSON.stringify(document.materials)).not.toContain(
      "private-host-data",
    );

    const pdf = await app.inject({
      method: "GET",
      url: "/api/materials",
      query: {
        document: "Раздел/Материалы.md",
        id: "source-material-0",
      },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.body).toBe("PDF-source");
    expect(pdf.headers).toMatchObject({
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
    });
    expect(pdf.headers["content-disposition"]).toContain("inline");

    const eml = await app.inject({
      method: "GET",
      url: "/api/materials",
      query: {
        document: "Раздел/Материалы.md",
        id: "source-material-3",
      },
    });
    expect(eml.statusCode).toBe(200);
    expect(eml.headers["content-type"]).toBe("message/rfc822");
    expect(eml.headers["content-disposition"]).toContain("attachment");
    expect(await captureTree(root)).toEqual(before);
    await app.close();
  });

  test("serves full and partial material bytes with safe headers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-ranges-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "files"));
    await writeFile(
      path.join(root, "index.md"),
      "# Главная\n\n[Данные](files/data.bin)\n",
    );
    await writeFile(path.join(root, "files", "data.bin"), "0123456789");
    const before = await captureTree(root);
    const app = await buildApplication(config(root));
    await app.ready();
    const url = "/api/materials?document=index.md&id=attachment-0";

    const full = await app.inject(url);
    expect(full.statusCode).toBe(200);
    expect(full.body).toBe("0123456789");
    expect(full.headers).toMatchObject({
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-type": "application/octet-stream",
      "content-length": "10",
      "x-content-type-options": "nosniff",
    });
    expect(full.headers["content-disposition"]).toContain("attachment");

    const middle = await app.inject({
      url,
      headers: { range: "bytes=2-5" },
    });
    expect(middle.statusCode).toBe(206);
    expect(middle.body).toBe("2345");
    expect(middle.headers["content-range"]).toBe("bytes 2-5/10");

    const openEnded = await app.inject({
      url,
      headers: { range: "bytes=7-" },
    });
    expect(openEnded.statusCode).toBe(206);
    expect(openEnded.body).toBe("789");

    const suffix = await app.inject({
      url,
      headers: { range: "bytes=-4" },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.body).toBe("6789");

    const oversizedSuffix = await app.inject({
      url,
      headers: { range: "bytes=-99" },
    });
    expect(oversizedSuffix.statusCode).toBe(206);
    expect(oversizedSuffix.body).toBe("0123456789");

    const malformed = await app.inject({
      url,
      headers: { range: "bytes=broken" },
    });
    expect(malformed.statusCode).toBe(200);
    expect(malformed.body).toBe("0123456789");

    const unsatisfiable = await app.inject({
      url,
      headers: { range: "bytes=10-" },
    });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe("bytes */10");

    expect(
      (await app.inject("/api/materials?document=index.md&id=attachment-9"))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject(
          "/api/materials?document=../outside.md&id=attachment-0",
        )
      ).statusCode,
    ).toBe(400);
    expect(await captureTree(root)).toEqual(before);
    await app.close();
  });

  test("rechecks canonical containment after a referenced file is replaced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-swap-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "indexary-swap-out-"));
    temporaryDirectories.push(root, outside);
    await writeFile(
      path.join(root, "index.md"),
      "# Главная\n\n[Файл](material.bin)\n",
    );
    const materialPath = path.join(root, "material.bin");
    await writeFile(materialPath, "inside");
    const privatePath = path.join(outside, "private.bin");
    await writeFile(privatePath, "private-host-data");
    const app = await buildApplication(config(root));
    await app.ready();

    await rm(materialPath);
    await symlink(privatePath, materialPath);
    const response = await app.inject(
      "/api/materials?document=index.md&id=attachment-0",
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("private-host-data");
    expect(response.body).not.toContain(outside);
    await app.close();
  });

  test("serves deterministic wikilinks and backlinks through the validated API", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-links-app-"));
    temporaryDirectories.push(root);
    for (const folder of ["Раздел", "Глубже", "а", "б"]) {
      await mkdir(path.join(root, folder));
    }
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await writeFile(path.join(root, "Цель.md"), "# Цель в корне\n");
    await writeFile(path.join(root, "Раздел", "Цель.md"), "# Цель рядом\n");
    await writeFile(
      path.join(root, "Глубже", "Уникальная.md"),
      "# Уникальная\n",
    );
    await writeFile(path.join(root, "а", "Дубль.md"), "# Дубль А\n");
    await writeFile(path.join(root, "б", "Дубль.md"), "# Дубль Б\n");
    await writeFile(
      path.join(root, "Раздел", "Источник.md"),
      "# Источник\n\n[[Цель]], [[/Цель]], [[Уникальная]], [[Нет]] и [[Дубль]].\n",
    );
    const before = await captureTree(root);
    const app = await buildApplication(config(root));
    await app.ready();

    const source = await app.inject({
      method: "GET",
      url: "/api/documents",
      query: { path: "Раздел/Источник.md" },
    });
    expect(source.statusCode).toBe(200);
    expect(source.json().outgoingLinks).toMatchObject([
      { state: "resolved", path: "Раздел/Цель.md" },
      { state: "resolved", path: "Цель.md" },
      { state: "resolved", path: "Глубже/Уникальная.md" },
      { state: "missing" },
      { state: "ambiguous" },
    ]);

    const target = await app.inject({
      method: "GET",
      url: "/api/documents",
      query: { path: "Раздел/Цель.md" },
    });
    expect(target.statusCode).toBe(200);
    expect(target.json().backlinks).toMatchObject([
      { path: "Раздел/Источник.md", title: "Источник" },
    ]);
    await app.close();
    expect(await captureTree(root)).toEqual(before);
  });
});

describe("byte range parsing", () => {
  test.each([
    [undefined, 10, undefined],
    ["items=0-1", 10, "ignore"],
    ["bytes=0-1,4-5", 10, "ignore"],
    ["bytes=-0", 10, "unsatisfiable"],
    ["bytes=8-7", 10, "unsatisfiable"],
    ["bytes=0-", 0, "unsatisfiable"],
    ["bytes=0-99", 10, { start: 0, end: 9 }],
  ])("handles %s against %i bytes", (header, size, expected) => {
    expect(parseByteRange(header, size)).toEqual(expected);
  });
});

describe("search API", () => {
  test("serves safe uncapped search and exact tag filters", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "indexary-search-app-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "index.md"), "# Главная\n");
    await writeFile(
      path.join(root, "Поиск.md"),
      "---\ntags: [важное]\nstatus: активный\n---\n# Поиск\n\nКириллический фрагмент.\n",
    );
    const before = await captureTree(root);
    const app = await buildApplication(config(root));

    const response = await app.inject({
      method: "GET",
      url: "/api/search",
      query: { q: "кирилл*", tag: "ВАЖНОЕ" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        expect.objectContaining({
          path: "Поиск.md",
          title: "Поиск",
          tags: ["важное"],
          snippet: expect.arrayContaining([
            expect.objectContaining({ highlighted: true }),
          ]),
        }),
      ],
    });
    expect(response.json().results[0]).not.toHaveProperty("searchableText");
    expect(response.json().results[0]).not.toHaveProperty("score");

    const malformed = await app.inject({
      method: "GET",
      url: "/api/search",
      query: { q: '" ) OR * : --' },
    });
    expect(malformed.statusCode).toBe(200);
    expect(malformed.json()).toEqual({ results: [] });
    await app.close();
    expect(await captureTree(root)).toEqual(before);
  });
});
