import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "vitest";

import { applyKnowledgeBaseChange } from "../src/live-changes";

function populatedClient(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(["catalog", ""], { documents: [] });
  client.setQueryData(["document", "Один.md"], { title: "Один" });
  client.setQueryData(["document", "Другой.md"], { title: "Другой" });
  client.setQueryData(["search", "один"], { results: [] });
  return client;
}

function invalidated(client: QueryClient, queryKey: unknown[]): boolean {
  return client.getQueryState(queryKey)?.isInvalidated ?? false;
}

describe("live Knowledge Base query reconciliation", () => {
  test("targets catalog changes at catalog queries", async () => {
    const client = populatedClient();
    await applyKnowledgeBaseChange(client, {
      revision: 4,
      type: "catalog-changed",
    });

    expect(invalidated(client, ["catalog", ""])).toBe(true);
    expect(invalidated(client, ["document", "Один.md"])).toBe(false);
    expect(invalidated(client, ["search", "один"])).toBe(false);
  });

  test.each(["document-changed", "document-removed"] as const)(
    "targets %s at the affected Document and search queries",
    async (type) => {
      const client = populatedClient();
      await applyKnowledgeBaseChange(client, {
        revision: 5,
        type,
        path: "Один.md",
      });

      expect(invalidated(client, ["document", "Один.md"])).toBe(true);
      expect(invalidated(client, ["document", "Другой.md"])).toBe(false);
      expect(invalidated(client, ["search", "один"])).toBe(true);
      expect(invalidated(client, ["catalog", ""])).toBe(false);
    },
  );

  test("reconciles every remote query when revision history is unavailable", async () => {
    const client = populatedClient();
    await applyKnowledgeBaseChange(client, {
      revision: 9,
      type: "catalog-changed",
      resync: true,
    });

    expect(invalidated(client, ["catalog", ""])).toBe(true);
    expect(invalidated(client, ["document", "Один.md"])).toBe(true);
    expect(invalidated(client, ["document", "Другой.md"])).toBe(true);
    expect(invalidated(client, ["search", "один"])).toBe(true);
  });
});
