import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
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
    expect(screen.getByRole("status")).toHaveTextContent("Материал не найден");

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
});
