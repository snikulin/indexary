import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildApplication } from "../src/application.js";
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
});
