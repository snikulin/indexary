import process from "node:process";
import { setTimeout as delayFor } from "node:timers/promises";

import type { FastifyInstance } from "fastify";

import { buildApplication } from "./application.js";
import { ConfigurationError, resolveRuntimeConfig } from "./config.js";
import {
  KnowledgeBaseStartupError,
  preflightKnowledgeBaseRuntime,
} from "./knowledge-base/index.js";

type OperationalEvent =
  | "failure"
  | "listening"
  | "ready"
  | "runtime-preflight-passed"
  | "starting"
  | "stopped"
  | "stopping";

function emitOperationalEvent(
  event: OperationalEvent,
  level: "error" | "info" = "info",
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    service: "indexary",
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

async function waitUntilReady(
  app: FastifyInstance,
  isStopping: () => boolean,
): Promise<void> {
  while (!isStopping()) {
    const response = await app.inject({
      method: "GET",
      url: "/api/health/ready",
    });
    if (response.statusCode === 200) {
      emitOperationalEvent("ready");
      return;
    }
    await delayFor(50);
  }
}

async function main(): Promise<void> {
  let app: FastifyInstance | undefined;
  let shutdown: Promise<void> | undefined;

  try {
    const config = resolveRuntimeConfig(
      process.argv.slice(2),
      process.env,
      process.env.INIT_CWD ?? process.cwd(),
    );
    emitOperationalEvent("starting");
    preflightKnowledgeBaseRuntime();
    emitOperationalEvent("runtime-preflight-passed");

    app = await buildApplication(config);
    await app.listen({ host: config.host, port: config.port });

    const close = (): Promise<void> => {
      shutdown ??= (async () => {
        emitOperationalEvent("stopping");
        await app?.close();
        emitOperationalEvent("stopped");
        process.exitCode = 0;
      })().catch(() => {
        emitOperationalEvent("failure", "error");
        process.exitCode = 1;
      });
      return shutdown;
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => void close());
    }

    emitOperationalEvent("listening");
    await waitUntilReady(app, () => shutdown !== undefined);
  } catch (error) {
    if (
      error instanceof ConfigurationError ||
      error instanceof KnowledgeBaseStartupError
    ) {
      // Known failures are intentionally represented by a stable event rather
      // than by values that could include private runtime configuration.
    }
    await app?.close().catch(() => undefined);
    emitOperationalEvent("failure", "error");
    process.exitCode = 1;
  }
}

await main();
