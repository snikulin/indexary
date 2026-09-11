import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../fixtures/knowledge-base",
);
const temporaryDirectories: string[] = [];
const children = new Set<ChildProcess>();

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate a test port.");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

async function eventually(
  assertion: () => Promise<void>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw lastError;
}

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("production command", () => {
  test("preflights FTS5, emits private JSON lifecycle events, and stops gracefully", async () => {
    const cacheRoot = await mkdtemp(
      path.join(os.tmpdir(), "indexary-cli-cache-"),
    );
    temporaryDirectories.push(cacheRoot);
    const port = await unusedPort();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--knowledge-base",
        fixtureRoot,
        "--cache-root",
        cacheRoot,
        "--profile",
        "cli-test",
        "--port",
        String(port),
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.add(child);

    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      output += chunk;
    });

    await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`);
      expect(response.status).toBe(200);
    });
    await eventually(async () => {
      expect(output).toContain('"event":"ready"');
    });

    child.kill("SIGTERM");
    const exit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    children.delete(child);

    expect(exit).toEqual({ code: 0, signal: null });
    expect(output).not.toContain(fixtureRoot);
    expect(output).not.toContain(cacheRoot);
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map(({ event }) => event)).toEqual([
      "starting",
      "runtime-preflight-passed",
      "listening",
      "ready",
      "stopping",
      "stopped",
    ]);
    for (const event of events) {
      expect(event).toEqual({
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        level: "info",
        event: expect.any(String),
        service: "indexary",
      });
    }
  });
});
