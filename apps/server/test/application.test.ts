import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildApplication } from "../src/application.js";
import type { RuntimeConfig } from "../src/config.js";
import { captureTree } from "./helpers.js";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../fixtures/knowledge-base",
);
const temporaryDirectories: string[] = [];

function config(knowledgeBasePath: string, webRoot?: string): RuntimeConfig {
  return {
    knowledgeBasePath,
    host: "127.0.0.1",
    port: 4173,
    profile: "test",
    ...(webRoot === undefined ? {} : { webRoot }),
  };
}

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
    });

    const ready = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: "ready",
      homeDocument: "available",
    });
    await app.close();
    expect(await captureTree(fixtureRoot)).toEqual(before);
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
    await app.close();
  });
});
