import { describe, expect, test } from "vitest";

import {
  interpretDocument,
  isSafeDocumentUrl,
  unreadableDocument,
} from "../src/knowledge-base/document.js";
import { createWikilinkResolver } from "../src/knowledge-base/links.js";

describe("Document interpretation", () => {
  test("builds one complete representation from Cyrillic YAML and GFM", async () => {
    const document = await interpretDocument(
      "раздел/обзор.md",
      `---
title: "Обзор Базы знаний"
tags:
  - исследование
  - "важное: сейчас"
originals: [материалы/обзор.pdf]
original_path: архив/старый.eml
status: в работе
details:
  owner: Ник
---
# Заголовок в тексте

> Цитата с **выделением**.

- [x] Проверено
- [ ] Продолжить

| Поле | Значение |
| --- | --- |
| Язык | русский |

\`\`\`ts
const ready = true;
\`\`\`

[Сайт](https://example.com) и [почта](mailto:user@example.com).
[Вложение](../файлы/снимок%20экрана.png?raw=1#preview)
[Документ](другой.md)
`,
    );

    expect(document).toMatchObject({
      path: "раздел/обзор.md",
      title: "Обзор Базы знаний",
      tags: ["исследование", "важное: сейчас"],
      sourceMaterials: ["материалы/обзор.pdf", "архив/старый.eml"],
      diagnostics: [],
    });
    expect(document.properties).toEqual(
      expect.arrayContaining([
        { name: "status", value: "в работе" },
        { name: "details", value: "{owner: Ник}" },
      ]),
    );
    expect(document.html).toContain("<blockquote>");
    expect(document.html).toContain("<table>");
    expect(document.html).toContain('type="checkbox" checked disabled');
    expect(document.html).toContain('<pre><code class="language-ts">');
    expect(document.html).toContain('href="https://example.com"');
    expect(document.html).toContain('href="mailto:user@example.com"');
    expect(document.html).toContain("<h1>Заголовок в тексте</h1>");
    expect(document.searchableText).toContain("Обзор Базы знаний");
    expect(document.searchableText).toContain("русский");
    expect(document.searchableText).toContain("const ready = true;");
    expect(document.attachmentPaths).toEqual(["../файлы/снимок экрана.png"]);
  });

  test("selects title by precedence and removes only a selected H1", async () => {
    const headingDocument = await interpretDocument(
      "папка/без-названия.md",
      "Текст до.\n\n# Первый заголовок\n\n## Подраздел\n",
    );
    expect(headingDocument.title).toBe("Первый заголовок");
    expect(headingDocument.html).not.toContain("<h1>");
    expect(headingDocument.html).toContain("<h2>Подраздел</h2>");

    const filenameDocument = await interpretDocument(
      "папка/Без заголовка.md",
      "Текст",
    );
    expect(filenameDocument.title).toBe("Без заголовка");
  });

  test("retains readable content and generic properties around invalid fields", async () => {
    const document = await interpretDocument(
      "index.md",
      `---
title: 42
tags: [хороший, 9, ""]
originals: { path: материал.pdf }
original_path: [старый.pdf]
published: true
---
# Безопасный заголовок

Доступное содержимое.
`,
    );

    expect(document.title).toBe("Безопасный заголовок");
    expect(document.tags).toEqual(["хороший"]);
    expect(document.sourceMaterials).toEqual([]);
    expect(document.properties).toContainEqual({
      name: "published",
      value: "true",
    });
    expect(document.html).toContain("Доступное содержимое");
    expect(document.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "TITLE_INVALID",
        "TAGS_INVALID",
        "ORIGINALS_INVALID",
        "ORIGINAL_PATH_INVALID",
      ]),
    );
    expect(JSON.stringify(document.diagnostics)).not.toContain("старый.pdf");
  });

  test("accepts mixed legacy and SHA-bound Source Material entries", async () => {
    const document = await interpretDocument(
      "index.md",
      `---
originals:
  - materials/legacy.pdf
  - path: materials/bound.pdf
    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  - materials/legacy.pdf
---
`,
    );

    expect(document.sourceMaterials).toEqual([
      "materials/legacy.pdf",
      "materials/bound.pdf",
    ]);
    expect(document.diagnostics.map(({ code }) => code)).not.toContain(
      "ORIGINALS_INVALID",
    );
    expect(document.sourceMaterials.join(" ")).not.toContain(
      "0123456789abcdef",
    );
  });

  test.each([
    ["missing sha256", "  - path: materials/example.pdf"],
    [
      "missing path",
      "  - sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ],
    [
      "empty path",
      '  - path: ""\n    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ],
    [
      "invalid sha256",
      "  - path: materials/example.pdf\n    sha256: not-a-sha256",
    ],
    [
      "absolute path",
      "  - path: /etc/passwd\n    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ],
    [
      "traversal",
      "  - path: ../private.pdf\n    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ],
    [
      "nested path",
      "  - path:\n      nested: materials/example.pdf\n    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ],
    [
      "extra field",
      "  - path: materials/example.pdf\n    sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n    url: https://example.com/private.pdf",
    ],
  ])("rejects a malformed SHA-bound Source Material: %s", async (_, entry) => {
    const document = await interpretDocument(
      "index.md",
      `---\noriginals:\n${entry}\n---\n`,
    );

    expect(document.sourceMaterials).toEqual([]);
    expect(document.diagnostics.map(({ code }) => code)).toContain(
      "ORIGINALS_INVALID",
    );
  });

  test("isolates malformed YAML without hiding safely readable text", async () => {
    const document = await interpretDocument(
      "ошибка.md",
      "---\ntitle: [сломано\n---\n# Читаемый заголовок\n\nЧитаемый текст.\n",
    );

    expect(document.title).toBe("Читаемый заголовок");
    expect(document.html).toContain("Читаемый текст");
    expect(document.diagnostics).toContainEqual({
      code: "FRONTMATTER_INVALID",
      message: "Не удалось разобрать YAML-метаданные Документа.",
    });
  });

  test("removes active HTML, remote embeds, and unsafe link schemes", async () => {
    const document = await interpretDocument(
      "опасный.md",
      `# Безопасно

<script>alert("secret")</script>
<iframe src="https://tracker.example"></iframe>

![Удалённый рисунок](https://images.example/private.png)
[опасно](javascript:alert(1))
[файл](file:///etc/passwd)
[данные](data:text/html,boom)
[кодированная схема](java%73cript:alert(1))
[локально](другой.md)
`,
    );

    expect(document.html).not.toContain("<script");
    expect(document.html).not.toContain("<iframe");
    expect(document.html).not.toContain("<img");
    expect(document.html).toContain(
      '<a href="https://images.example/private.png">Удалённый рисунок</a>',
    );
    expect(document.html).not.toContain("javascript:");
    expect(document.html).not.toContain("file:");
    expect(document.html).not.toContain("data:");
    expect(document.html).toContain(
      'href="%D0%B4%D1%80%D1%83%D0%B3%D0%BE%D0%B9.md"',
    );
    expect(document.diagnostics.map(({ code }) => code)).toEqual([
      "RAW_HTML_REMOVED",
      "UNSAFE_URL_REMOVED",
    ]);
  });

  test("creates a content-safe representation for an unreadable Document", () => {
    expect(unreadableDocument("секретный.md")).toEqual({
      path: "секретный.md",
      title: "секретный",
      html: "",
      searchableText: "секретный",
      tags: [],
      sourceMaterials: [],
      attachmentPaths: [],
      properties: [],
      outgoingLinks: [],
      backlinks: [],
      diagnostics: [
        {
          code: "DOCUMENT_UNREADABLE",
          message: "Не удалось прочитать содержимое Документа.",
        },
      ],
    });
  });

  test("renders resolved wikilinks and distinct inert unresolved states", async () => {
    const resolve = createWikilinkResolver([
      "Раздел/Источник.md",
      "Раздел/Цель.md",
      "а/Дубль.md",
      "б/Дубль.md",
    ]);
    const document = await interpretDocument(
      "Раздел/Источник.md",
      "Переход к [[Цель|целевому Документу]], [[Нет]] и [[Дубль]].",
      { resolveWikilink: resolve },
    );

    expect(document.html).toContain(
      'href="/documents/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB/%D0%A6%D0%B5%D0%BB%D1%8C.md"',
    );
    expect(document.html).toContain("wikilink-missing");
    expect(document.html).toContain("Нет — не найдено");
    expect(document.html).toContain("wikilink-ambiguous");
    expect(document.html).toContain("Дубль — неоднозначно");
    expect(document.outgoingLinks.map(({ state }) => state)).toEqual([
      "resolved",
      "missing",
      "ambiguous",
    ]);
    expect(document.diagnostics.map(({ code }) => code)).toEqual([
      "WIKILINK_MISSING",
      "WIKILINK_AMBIGUOUS",
    ]);
  });

  test("keeps the referenced text inside a bounded backlink snippet", async () => {
    const resolve = createWikilinkResolver(["Источник.md", "Цель.md"]);
    const document = await interpretDocument(
      "Источник.md",
      `${"далёкий текст ".repeat(30)}переход [[Цель]] в контексте.`,
      { resolveWikilink: resolve },
    );

    expect(document.outgoingLinks[0]?.snippet.length).toBeLessThanOrEqual(180);
    expect(document.outgoingLinks[0]?.snippet).toContain("[[Цель]]");
  });
});

describe("Document URL safety", () => {
  test.each([
    "https://example.com/path",
    "http://example.com",
    "mailto:user@example.com",
    "соседний.md",
    "../папка/документ.md#часть",
    "#раздел",
  ])("allows an explicit or Knowledge Base link: %s", (url) => {
    expect(isSafeDocumentUrl(url)).toBe(true);
  });

  test.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com/archive",
    "java%73cript:alert(1)",
    "%6A%61vascript:alert(1)",
    "%broken",
    "java\nscript:alert(1)",
  ])("rejects an unsafe active URL: %s", (url) => {
    expect(isSafeDocumentUrl(url)).toBe(false);
  });
});
