import { describe, expect, test } from "vitest";

import { createWikilinkResolver } from "../src/knowledge-base/links.js";

describe("wikilink resolution", () => {
  test("uses relative, root, and unique filename precedence", () => {
    const resolve = createWikilinkResolver([
      "Цель.md",
      "Раздел/Источник.md",
      "Раздел/Цель.md",
      "Глубже/Единственная.md",
      "Раздел/RFC:123.md",
    ]);

    expect(resolve("Раздел/Источник.md", "Цель")).toEqual({
      state: "resolved",
      path: "Раздел/Цель.md",
    });
    expect(resolve("Раздел/Источник.md", "/Цель")).toEqual({
      state: "resolved",
      path: "Цель.md",
    });
    expect(resolve("Раздел/Источник.md", "Единственная")).toEqual({
      state: "resolved",
      path: "Глубже/Единственная.md",
    });
    expect(resolve("Раздел/Источник.md", "../Цель.md#раздел")).toEqual({
      state: "resolved",
      path: "Цель.md",
    });
    expect(resolve("Раздел/Источник.md", "RFC:123")).toEqual({
      state: "resolved",
      path: "Раздел/RFC:123.md",
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

  test.each([
    "../../private",
    "C:\\private",
    "folder\\private",
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
