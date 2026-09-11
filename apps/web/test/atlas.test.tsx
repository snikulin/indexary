import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Atlas } from "../src/atlas";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAtlas() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Atlas />
    </QueryClientProvider>,
  );
}

describe("Atlas", () => {
  test("renders the Russian shell and Home Document representation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          path: "index.md",
          title: "Домашний документ",
          html: "<p>Содержимое</p>",
        }),
      }),
    );

    renderAtlas();

    expect(
      screen.getByRole("navigation", { name: "База знаний" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Домашний документ" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Контекст Документа" }),
    ).toBeInTheDocument();
  });

  test("shows an explicit state instead of choosing another Document", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    renderAtlas();

    expect(
      await screen.findByRole("heading", {
        name: "Домашний документ недоступен",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Индексари не станет открывать другой Документ/),
    ).toBeInTheDocument();
  });
});
