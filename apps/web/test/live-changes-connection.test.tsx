import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { LiveKnowledgeBaseChanges } from "../src/live-changes";

class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  close = vi.fn();
  constructor() {
    super();
    TestEventSource.instances.push(this);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  TestEventSource.instances = [];
});

test("rechecks the catalog when the event stream connects during an older request", async () => {
  vi.stubGlobal("EventSource", TestEventSource);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let finishFirst: (value: string) => void = () => undefined;
  const firstResponse = new Promise<string>((resolve) => {
    finishFirst = resolve;
  });
  const fetchCatalog = vi
    .fn()
    .mockImplementationOnce(() => firstResponse)
    .mockResolvedValue("Обновлённый каталог");
  function Catalog() {
    const query = useQuery({
      queryKey: ["catalog", ""],
      queryFn: fetchCatalog,
    });
    return <p>{query.data ?? "Загрузка"}</p>;
  }
  render(
    <QueryClientProvider client={client}>
      <LiveKnowledgeBaseChanges />
      <Catalog />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(fetchCatalog).toHaveBeenCalledTimes(1));
  await act(async () => {
    TestEventSource.instances[0]!.dispatchEvent(new Event("open"));
  });
  expect(await screen.findByText("Обновлённый каталог")).toBeInTheDocument();
  await act(async () => {
    finishFirst("Устаревший каталог");
  });
  expect(screen.getByText("Обновлённый каталог")).toBeInTheDocument();
});
