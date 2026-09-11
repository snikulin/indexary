import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { documentRoute, folderRoute } from "../src/api";
import { Atlas, type AtlasSelection } from "../src/atlas";

const home = {
  path: "index.md",
  title: "Домашний документ",
  html: "<p>Содержимое</p>",
  searchableText: "Домашний документ Содержимое",
  tags: ["важное"],
  sourceMaterials: [],
  properties: [
    { name: "tags", value: "[важное]" },
    { name: "status", value: "в работе" },
  ],
  diagnostics: [
    {
      code: "UNSAFE_URL_REMOVED",
      message: "Ссылка с небезопасной схемой отключена.",
    },
  ],
};

const rootCatalog = {
  path: "",
  name: "База знаний",
  folders: [{ path: "Раздел с пробелом", name: "Раздел с пробелом" }],
  documents: [{ path: "index.md", title: "Домашний документ" }],
  diagnostics: [],
};

beforeEach(() => localStorage.clear());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAtlas(selection?: AtlasSelection) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Atlas selection={selection} />
    </QueryClientProvider>,
  );
}

function stubSuccessfulRequests() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => ({
      ok: true,
      json: async () =>
        String(input).startsWith("/api/catalog") ? rootCatalog : home,
    })),
  );
}

describe("Atlas", () => {
  test("renders the Russian shell and Home Document representation", async () => {
    stubSuccessfulRequests();
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
    expect(screen.getByRole("list", { name: "Теги" })).toHaveTextContent(
      "важное",
    );
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("в работе")).toBeInTheDocument();
    expect(
      screen.getByText("Ссылка с небезопасной схемой отключена."),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: "Раздел с пробелом" }),
    ).toHaveAttribute(
      "href",
      "/folders/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%20%D1%81%20%D0%BF%D1%80%D0%BE%D0%B1%D0%B5%D0%BB%D0%BE%D0%BC",
    );
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

  test("renders a folder as its immediate entries without opening a Document", async () => {
    const nestedCatalog = {
      path: "Раздел с пробелом",
      name: "Раздел с пробелом",
      folders: [{ path: "Раздел с пробелом/Глубже", name: "Глубже" }],
      documents: [
        {
          path: "Раздел с пробелом/Проект Альфа.md",
          title: "Проект Альфа",
        },
      ],
      diagnostics: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => nestedCatalog,
      }),
    );

    renderAtlas({ kind: "folder", path: "Раздел с пробелом" });

    expect(
      await screen.findByRole("heading", { name: "Раздел с пробелом" }),
    ).toBeInTheDocument();
    const main = within(screen.getByRole("main"));
    expect(main.getByRole("link", { name: "Глубже" })).toHaveAttribute(
      "href",
      folderRoute("Раздел с пробелом/Глубже"),
    );
    expect(main.getByRole("link", { name: "Проект Альфа" })).toHaveAttribute(
      "href",
      documentRoute("Раздел с пробелом/Проект Альфа.md"),
    );
    expect(screen.queryByText("Содержимое")).not.toBeInTheDocument();
  });

  test("keeps encoded Cyrillic and spaced routes stable", () => {
    expect(documentRoute("Раздел с пробелом/Проект Альфа.md")).toBe(
      "/documents/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%20%D1%81%20%D0%BF%D1%80%D0%BE%D0%B1%D0%B5%D0%BB%D0%BE%D0%BC/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%20%D0%90%D0%BB%D1%8C%D1%84%D0%B0.md",
    );
  });

  test("opens search globally and renders highlighted snippets as inert text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const data = url.startsWith("/api/search")
          ? {
              results: [
                {
                  path: "Опасный.md",
                  title: "Безопасный результат",
                  tags: ["проверка"],
                  snippet: [
                    { text: "<img src=x ", highlighted: false },
                    { text: "onerror", highlighted: true },
                    { text: "=boom>", highlighted: false },
                  ],
                },
              ],
            }
          : url.startsWith("/api/catalog")
            ? rootCatalog
            : home;
        return { ok: true, json: async () => data };
      }),
    );
    renderAtlas();

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Поиск Документов" });
    const input = within(dialog).getByPlaceholderText("Поиск по Базе знаний");
    fireEvent.change(input, { target: { value: "onerror" } });

    expect(
      await within(dialog).findByRole("link", { name: /Безопасный результат/ }),
    ).toHaveAttribute("href", documentRoute("Опасный.md"));
    expect(within(dialog).getByText("onerror").tagName).toBe("MARK");
    expect(within(dialog).getByText(/<img src=x/)).toBeInTheDocument();
    expect(dialog.querySelector("img")).toBeNull();
  });

  test("opens the same search experience from a clickable tag", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return {
        ok: true,
        json: async () =>
          url.startsWith("/api/search")
            ? { results: [] }
            : url.startsWith("/api/catalog")
              ? rootCatalog
              : home,
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAtlas();

    fireEvent.click(await screen.findByRole("button", { name: "важное" }));
    expect(
      screen.getByRole("dialog", { name: "Поиск Документов" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Тег: важное")).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/search?tag=%D0%B2%D0%B0%D0%B6%D0%BD%D0%BE%D0%B5",
        expect.anything(),
      ),
    );
    expect(
      await screen.findByText("Документы по этому запросу не найдены."),
    ).toBeInTheDocument();
  });

  test("distinguishes an idle search from a failed search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.startsWith("/api/search")) {
          throw new Error("offline");
        }
        return {
          ok: true,
          json: async () =>
            url.startsWith("/api/catalog") ? rootCatalog : home,
        };
      }),
    );
    renderAtlas();

    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(
      screen.getByText(/Введите точное слово, фразу в кавычках/),
    ).toBeInTheDocument();
    fireEvent.change(
      within(
        screen.getByRole("dialog", { name: "Поиск Документов" }),
      ).getByPlaceholderText("Поиск по Базе знаний"),
      {
        target: { value: "ошибка" },
      },
    );
    expect(
      await screen.findByText("Поиск сейчас недоступен."),
    ).toBeInTheDocument();
  });
});
