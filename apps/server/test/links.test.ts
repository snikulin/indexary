import { describe, expect, test } from "vitest";

import {
  createWikilinkResolver,
  documentRoute,
} from "../src/knowledge-base/links.js";

describe("wikilink resolution", () => {
  test("uses relative, root, and unique filename precedence", () => {
    const resolve = createWikilinkResolver([
      "Цель.md",
      "Раздел/Источник.md",
      "Раздел/Цель.md",
      "Глубже/Единственная.md",
      "Раздел/RFC:123.md",
      "Раздел/C:\\private.md",
    ]);

    expect(resolve("Раздел/Источник.md", "Цель")).toEqual({
      state: "resolved",
      targetKind: "document",
      path: "Раздел/Цель.md",
    });
    expect(resolve("Раздел/Источник.md", "/Цель")).toEqual({
      state: "resolved",
      targetKind: "document",
      path: "Цель.md",
    });
    expect(resolve("Раздел/Источник.md", "Единственная")).toEqual({
      state: "resolved",
      targetKind: "document",
      path: "Глубже/Единственная.md",
    });
    expect(resolve("Раздел/Источник.md", "../Цель.md#раздел")).toEqual({
      state: "resolved",
      targetKind: "document",
      path: "Цель.md",
    });
    expect(resolve("Раздел/Источник.md", "RFC:123")).toEqual({
      state: "resolved",
      targetKind: "document",
      path: "Раздел/RFC:123.md",
    });
    expect(resolve("Раздел/Источник.md", "C:\\private")).toEqual({
      state: "resolved",
      targetKind: "document",
      path: "Раздел/C:\\private.md",
    });
  });

  test("never lets candidate order choose an ambiguous filename", () => {
    const forward = createWikilinkResolver([
      "Источник.md",
      "а/Дубль.md",
      "б/Дубль.md",
    ]);
    const reverse = createWikilinkResolver([
      "б/Дубль.md",
      "а/Дубль.md",
      "Источник.md",
    ]);

    expect(forward("Источник.md", "Дубль")).toEqual({ state: "ambiguous" });
    expect(reverse("Источник.md", "Дубль")).toEqual({ state: "ambiguous" });
  });

  test("resolves existing non-Markdown wikilinks without guessing ambiguity", () => {
    const resolve = createWikilinkResolver(
      ["Раздел/Источник.md"],
      ["materials/example.pdf", "а/duplicate.pdf", "б/duplicate.pdf"],
    );

    expect(resolve("Раздел/Источник.md", "../materials/example.pdf")).toEqual({
      state: "resolved",
      targetKind: "material",
      path: "materials/example.pdf",
    });
    expect(resolve("Раздел/Источник.md", "/materials/example.pdf")).toEqual({
      state: "resolved",
      targetKind: "material",
      path: "materials/example.pdf",
    });
    expect(resolve("Раздел/Источник.md", "duplicate.pdf")).toEqual({
      state: "ambiguous",
    });
    expect(resolve("Раздел/Источник.md", "missing.pdf")).toEqual({
      state: "missing",
    });
  });

  test("rejects an external URI even when its normalized spelling exists locally", () => {
    const resolve = createWikilinkResolver(
      ["Раздел/Источник.md"],
      ["Раздел/https:/outside.example/private.pdf"],
    );

    expect(
      resolve("Раздел/Источник.md", "https://outside.example/private.pdf"),
    ).toEqual({ state: "missing" });
  });

  test("rejects a protocol-relative wikilink before filename fallback", () => {
    const resolve = createWikilinkResolver(["index.md"], ["files/private.pdf"]);

    expect(resolve("index.md", "//evil.example/private.pdf")).toEqual({
      state: "missing",
    });
  });

  test("encodes a Linux backslash filename as data in a Document route", () => {
    expect(documentRoute("Раздел\\архив/C:\\Документ.md")).toBe(
      "/documents/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%5C%D0%B0%D1%80%D1%85%D0%B8%D0%B2/C%3A%5C%D0%94%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82.md",
    );
  });

  test.each([
    "../../private",
    "file:///private",
    "https://outside.example/private",
    "\0private",
  ])("does not resolve an unsafe target: %s", (target) => {
    const resolve = createWikilinkResolver([
      "Раздел/Источник.md",
      "private.md",
    ]);
    expect(resolve("Раздел/Источник.md", target)).toEqual({
      state: "missing",
    });
  });
});
