import path from "node:path";

import { describe, expect, test } from "vitest";

import { ConfigurationError, resolveRuntimeConfig } from "../src/config.js";

describe("runtime configuration", () => {
  test("requires an explicit Knowledge Base", () => {
    expect(() =>
      resolveRuntimeConfig([], { HOME: "/personal" }, "/workspace"),
    ).toThrow(ConfigurationError);
  });

  test("binds to loopback by default", () => {
    expect(
      resolveRuntimeConfig(["--knowledge-base", "fixture"], {}, "/workspace"),
    ).toEqual({
      knowledgeBasePath: path.resolve("/workspace/fixture"),
      host: "127.0.0.1",
      port: 4173,
      profile: "default",
    });
  });

  test("applies option, environment, and safe-default precedence", () => {
    const config = resolveRuntimeConfig(
      ["--knowledge-base", "fixture", "--port", "4100", "--profile", "fixture"],
      {
        INDEXARY_KNOWLEDGE_BASE: "personal",
        INDEXARY_HOST: "localhost",
        INDEXARY_PORT: "4200",
      },
      "/workspace",
    );

    expect(config).toEqual({
      knowledgeBasePath: path.resolve("/workspace/fixture"),
      host: "localhost",
      port: 4100,
      profile: "fixture",
    });
  });

  test.each(["0", "65536", "not-a-port"])("rejects invalid port %s", (port) => {
    expect(() =>
      resolveRuntimeConfig(
        ["--knowledge-base", "fixture", "--port", port],
        {},
        "/workspace",
      ),
    ).toThrow(ConfigurationError);
  });
});
