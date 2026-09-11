import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { act } from "react";
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
  materials: { sourceMaterials: [], attachments: [] },
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
  outgoingLinks: [
    {
      target: "Раздел/Цель",
      label: "Цель",
      state: "resolved" as const,
      path: "Раздел/Цель.md",
      snippet: "Перейти к [[Раздел/Цель|Цели]].",
    },
    {
      target: "Пропавшая",
      label: "Пропавшая",
      state: "missing" as const,
      snippet: "[[Пропавшая]]",
    },
    {
      target: "Дубль",
      label: "Дубль",
      state: "ambiguous" as const,
      snippet: "[[Дубль]]",
    },
  ],
  backlinks: [
    {
      path: "Источник.md",
      title: "Источник",
      snippet: '<img src=x onerror="alert(1)"> ссылается на Документ.',
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
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <Atlas selection={selection} />
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ code: "DOCUMENT_NOT_FOUND" }),
      }),
    );
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
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole("complementary", { name: "Контекст Документа" }),
      ).getByRole("status"),
    ).toHaveTextContent("Контекст появится после выбора Документа.");
  });

  test("keeps encoded Cyrillic and spaced routes stable", () => {
    expect(documentRoute("Раздел с пробелом/Проект Альфа.md")).toBe(
      "/documents/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%20%D1%81%20%D0%BF%D1%80%D0%BE%D0%B1%D0%B5%D0%BB%D0%BE%D0%BC/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%20%D0%90%D0%BB%D1%8C%D1%84%D0%B0.md",
    );
  });

  test("switches among Source Materials and Attachments without leaving the Document", async () => {
    const materialDocument = {
      ...home,
      materials: {
        sourceMaterials: [
          {
            id: "source-material-0",
            kind: "source-material",
            name: "схема.svg",
            path: "materials/схема.svg",
            status: "available",
            mimeType: "image/svg+xml",
            size: 320,
            preview: "image",
          },
          {
            id: "source-material-1",
            kind: "source-material",
            name: "источник.pdf",
            path: "materials/источник.pdf",
            status: "available",
            mimeType: "application/pdf",
            size: 2048,
            preview: "pdf",
          },
          {
            id: "source-material-2",
            kind: "source-material",
            name: "нет.pdf",
            path: "materials/нет.pdf",
            status: "missing",
            mimeType: "application/pdf",
            size: null,
            preview: "pdf",
            diagnostic: {
              code: "MATERIAL_MISSING",
              message: "Материал не найден.",
            },
          },
        ],
        attachments: [
          {
            id: "attachment-0",
            kind: "attachment",
            name: "черновик.docx",
            path: "files/черновик.docx",
            status: "available",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: 100,
            preview: "unsupported",
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => ({
        ok: true,
        json: async () =>
          String(input).startsWith("/api/catalog")
            ? rootCatalog
            : materialDocument,
      })),
    );
    renderAtlas();

    fireEvent.click(
      await screen.findByRole("tab", { name: "Исходные материалы" }),
    );
    expect(
      await screen.findByRole("img", { name: "схема.svg" }),
    ).toHaveAttribute(
      "src",
      "/api/materials?document=index.md&id=source-material-0",
    );
    fireEvent.click(screen.getByRole("button", { name: /источник\.pdf/ }));
    expect(screen.getByTitle("Предпросмотр PDF: источник.pdf")).toHaveAttribute(
      "src",
      "/api/materials?document=index.md&id=source-material-1",
    );
    fireEvent.click(screen.getByRole("button", { name: /нет\.pdf/ }));
    expect(
      screen.getByText("Материал не найден.", {
        selector: ".material-diagnostic",
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Вложения" }));
    expect(
      screen.getByRole("link", { name: "Открыть материал" }),
    ).toHaveAttribute(
      "href",
      "/api/materials?document=index.md&id=attachment-0",
    );
    expect(
      screen.getByRole("heading", { name: "Домашний документ" }),
    ).toBeInTheDocument();
  });

  test("shows navigable links, inert unresolved states, and escaped backlinks", async () => {
    stubSuccessfulRequests();
    renderAtlas();
    await screen.findByRole("heading", { name: "Домашний документ" });

    fireEvent.click(screen.getByRole("tab", { name: "Ссылки" }));
    expect(screen.getByRole("link", { name: "Цель" })).toHaveAttribute(
      "href",
      documentRoute("Раздел/Цель.md"),
    );
    expect(
      screen.queryByRole("link", { name: "Пропавшая" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Пропавшая")).toHaveClass("relationship-missing");
    expect(screen.getByText("Дубль")).toHaveClass("relationship-ambiguous");

    fireEvent.click(screen.getByRole("tab", { name: "Обратные ссылки" }));
    expect(screen.getByRole("link", { name: "Источник" })).toHaveAttribute(
      "href",
      documentRoute("Источник.md"),
    );
    expect(
      screen.getByText('<img src=x onerror="alert(1)"> ссылается на Документ.'),
    ).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
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

  test("distinguishes missing Documents from a server failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const missing = String(input).startsWith("/api/documents");
        return {
          ok: false,
          status: missing ? 404 : 503,
          json: async () => ({
            code: missing ? "DOCUMENT_NOT_FOUND" : "SERVER_UNAVAILABLE",
          }),
        };
      }),
    );
    renderAtlas({ kind: "document", path: "Нет.md" });

    expect(
      await screen.findByRole("heading", { name: "Документ недоступен" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "База знаний" })).getByRole(
        "status",
      ),
    ).toHaveTextContent("Сервер не смог загрузить каталог.");
  });

  test("supports arrow-key tab selection with complete tab semantics", async () => {
    stubSuccessfulRequests();
    renderAtlas();
    const properties = await screen.findByRole("tab", { name: "Свойства" });

    properties.focus();
    fireEvent.keyDown(properties, { key: "Home" });
    const sources = screen.getByRole("tab", { name: "Исходные материалы" });
    expect(sources).toHaveFocus();
    expect(sources).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", {
      name: "Исходные материалы",
    });
    expect(sources).toHaveAttribute("aria-controls", panel.id);

    fireEvent.keyDown(sources, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Ссылки" })).toHaveFocus();
    expect(
      screen.getByRole("tabpanel", { name: "Ссылки" }),
    ).toBeInTheDocument();
  });

  test("traps drawer focus, closes with Escape, and returns focus", async () => {
    stubSuccessfulRequests();
    renderAtlas();
    const trigger = screen.getByRole("button", { name: "Открыть навигацию" });

    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", {
      name: "Навигация по Базе знаний",
    });
    expect(
      within(dialog).getByRole("button", { name: "Закрыть" }),
    ).toHaveFocus();
    expect(document.querySelector(".application-content")).toHaveAttribute(
      "inert",
    );

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Навигация по Базе знаний" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test("focuses search, traps it, and returns to the invoking tag", async () => {
    stubSuccessfulRequests();
    renderAtlas();
    const tag = await screen.findByRole("button", { name: "важное" });

    tag.focus();
    fireEvent.click(tag);
    const dialog = screen.getByRole("dialog", { name: "Поиск Документов" });
    expect(within(dialog).getByRole("combobox")).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog).not.toBeInTheDocument();
    expect(tag).toHaveFocus();
  });

  test("recovers a focused Document link after a live representation update", async () => {
    const first = {
      ...home,
      revision: 1,
      html: '<p><a href="/documents/Цель.md">Цель до обновления</a></p>',
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => ({
        ok: true,
        json: async () =>
          String(input).startsWith("/api/catalog") ? rootCatalog : first,
      })),
    );
    const { queryClient } = renderAtlas();
    const link = await screen.findByRole("link", {
      name: "Цель до обновления",
    });
    link.focus();

    await act(async () => {
      queryClient.setQueryData(["document", "index.md"], {
        ...first,
        revision: 2,
        html: '<p><a href="/documents/Цель.md">Цель после обновления</a></p>',
      });
    });

    expect(
      await screen.findByRole("link", { name: "Цель после обновления" }),
    ).toHaveFocus();
  });
});
