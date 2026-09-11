import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export interface KnowledgeBaseChange {
  revision: number;
  type: "catalog-changed" | "document-changed" | "document-removed";
  path?: string;
  resync?: true;
}

const remoteQueryKeys = new Set(["catalog", "document", "search"]);
const changeTypes = new Set<KnowledgeBaseChange["type"]>([
  "catalog-changed",
  "document-changed",
  "document-removed",
]);

export async function applyKnowledgeBaseChange(
  queryClient: QueryClient,
  change: KnowledgeBaseChange,
): Promise<void> {
  if (change.resync) {
    await queryClient.invalidateQueries({
      predicate: (query) => remoteQueryKeys.has(String(query.queryKey[0])),
    });
    return;
  }

  if (change.type === "catalog-changed") {
    await queryClient.invalidateQueries({ queryKey: ["catalog"] });
    return;
  }

  if (change.path !== undefined) {
    await queryClient.invalidateQueries({
      queryKey: ["document", change.path],
      exact: true,
    });
  }
  await queryClient.invalidateQueries({ queryKey: ["search"] });
}

export function LiveKnowledgeBaseChanges() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const events = new EventSource("/api/events");
    const handleChange = (event: Event) => {
      try {
        const change = JSON.parse((event as MessageEvent<string>).data) as
          KnowledgeBaseChange | undefined;
        if (
          change !== undefined &&
          Number.isSafeInteger(change.revision) &&
          changeTypes.has(change.type)
        ) {
          void applyKnowledgeBaseChange(queryClient, change);
        }
      } catch {
        // EventSource reconnects and the server reconciles missed revisions.
      }
    };

    for (const type of [
      "catalog-changed",
      "document-changed",
      "document-removed",
    ]) {
      events.addEventListener(type, handleChange);
    }
    return () => events.close();
  }, [queryClient]);

  return null;
}
