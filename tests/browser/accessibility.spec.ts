import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectVisibleControlsToBeNamed(scope: Page | Locator) {
  const controls = scope.locator(
    "button:visible, a[href]:visible, input:visible, iframe:visible",
  );
  for (let index = 0; index < (await controls.count()); index += 1) {
    await expect(controls.nth(index)).toHaveAccessibleName(/\S/);
  }
}

async function expectVisibleFocus(locator: Locator) {
  await locator.focus();
  const outline = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      color: style.outlineColor,
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(2);
  expect(outline.color).not.toBe("rgba(0, 0, 0, 0)");
}

const guideRoute =
  "/documents/%D0%9F%D1%83%D1%82%D0%B5%D0%B2%D0%BE%D0%B4%D0%B8%D1%82%D0%B5%D0%BB%D1%8C.md";

test("keeps reading width and visible search stable across the former breakpoint", async ({
  page,
}) => {
  await page.goto("/");
  const widths: number[] = [];
  for (const width of [1100, 1101, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("main")).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "База знаний" }),
    ).toHaveCount(0);
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Поиск по Базе знаний" }),
    ).toBeVisible();
    const text = await page.locator(".document-body").boundingBox();
    widths.push(text!.width);
  }
  expect(Math.min(...widths)).toBeGreaterThan(680);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);
  await expectVisibleControlsToBeNamed(page);
  await expectVisibleFocus(
    page.getByRole("button", { name: "Поиск по Базе знаний" }),
  );
});

test("opens navigation on demand with keyboard isolation and restores focus at any width", async ({
  page,
}) => {
  await page.goto("/");
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const trigger = page.getByRole("button", { name: "Открыть навигацию" });
    await trigger.focus();
    await trigger.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Навигация по Базе знаний",
    });
    await expect(
      dialog.getByRole("button", { name: "Закрыть", exact: true }),
    ).toBeFocused();
    await expect(
      dialog.getByRole("navigation", { name: "База знаний" }),
    ).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Поиск по Базе знаний" }),
    ).toBeVisible();
  }
});

test("keeps an open navigation modal usable when the viewport changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Открыть навигацию" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("dialog", { name: "Навигация по Базе знаний" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".application-content")).not.toHaveAttribute(
    "inert",
    "",
  );
});

test("opens a single Source Material directly and returns to the same reading position", async ({
  page,
}) => {
  await page.route("**/api/documents?*", async (route) => {
    const response = await route.fetch();
    const document = await response.json();
    document.materials.sourceMaterials =
      document.materials.sourceMaterials.slice(0, 1);
    await route.fulfill({ response, json: document });
  });
  await page.goto(guideRoute);
  const opener = page.getByRole("button", {
    name: "Открыть оригинал",
    exact: true,
  });
  await opener.click();
  const viewer = page.getByRole("dialog", {
    name: "Просмотр файлов Документа",
  });
  await expect(
    viewer.getByTitle("Предпросмотр PDF: источник.pdf"),
  ).toBeVisible();
  await viewer.getByRole("button", { name: "Закрыть просмотр файлов" }).click();
  await expect(opener).toBeFocused();
});

test("uses the same file viewer on desktop, tablet and phone without overflowing the viewport", async ({
  page,
}) => {
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 850 });
    await page.goto(guideRoute);
    const opener = page.getByRole("button", { name: /Все файлы/ });
    await opener.click();
    const viewer = page.getByRole("dialog", {
      name: "Просмотр файлов Документа",
    });
    await expect(
      viewer.getByRole("button", { name: "Закрыть просмотр файлов" }),
    ).toBeFocused();
    await expect(viewer.getByRole("tablist")).toHaveCount(0);
    await viewer.getByRole("button", { name: /источник\.pdf/ }).click();
    const pdf = viewer.getByTitle("Предпросмотр PDF: источник.pdf");
    await expect(pdf).toBeVisible();
    expect((await pdf.boundingBox())!.width).toBeGreaterThan(
      width === 390 ? 300 : 500,
    );
    await viewer.getByRole("button", { name: /схема\.svg/ }).click();
    await expect(viewer.getByRole("img", { name: "схема.svg" })).toBeVisible();
    await viewer.getByRole("button", { name: "Увеличить изображение" }).click();
    await expect(viewer.locator("output")).toHaveText("125%");
    await expectVisibleControlsToBeNamed(viewer);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

test("preserves search across closing, navigation and browser Back", async ({
  page,
}) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Поиск по Базе знаний" });
  await trigger.click();
  const search = page.getByRole("dialog", { name: "Поиск Документов" });
  await expect(search.getByRole("searchbox")).toBeFocused();
  await search.getByRole("searchbox").fill("Вложенный");
  await expect(
    search.getByRole("link", { name: /Проект Альфа/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(search.getByRole("searchbox")).toHaveValue("Вложенный");
  await search.getByRole("searchbox").press("Enter");
  await expect(
    page.getByRole("heading", { name: "Проект Альфа", level: 1 }),
  ).toBeVisible();
  await page.goBack();
  await page.keyboard.press("Control+k");
  await expect(search.getByRole("searchbox")).toHaveValue("Вложенный");
  await page.keyboard.press("Escape");
});

test("follows navigation, wikilinks and backlinks using the keyboard", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Открыть навигацию" }).press("Enter");
  const folder = page
    .getByRole("navigation", { name: "База знаний" })
    .getByRole("link", { name: "Разделы" });
  await folder.focus();
  await folder.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Разделы", level: 1 }),
  ).toBeVisible();
  await page.goBack();
  const wikilink = page
    .locator(".document-body")
    .getByRole("link", { name: "Путеводитель" });
  await wikilink.focus();
  await wikilink.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Путеводитель", level: 1 }),
  ).toBeVisible();
  const backlink = page
    .getByRole("list", { name: "Обратные ссылки" })
    .getByRole("link", { name: "Добро пожаловать в Индексари" });
  await backlink.focus();
  await backlink.press("Enter");
  await expect(
    page.getByRole("heading", {
      name: "Добро пожаловать в Индексари",
      level: 1,
    }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Путеводитель", level: 1 }),
  ).toBeVisible();
});

test("restores Markdown hierarchy, lists and local scrolling for wide tables", async ({
  page,
}) => {
  await page.route("**/api/documents?*", async (route) => {
    const response = await route.fetch();
    const document = await response.json();
    document.html =
      "<h2>Раздел</h2><h3>Подраздел</h3><ul><li>Маркер</li></ul><ol><li>Шаг</li></ol><table><tr><th>" +
      "Колонка".repeat(50) +
      "</th><th>Данные</th></tr><tr><td>Значение</td><td>Описание</td></tr></table>";
    await route.fulfill({ response, json: document });
  });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/");
  await expect(page.locator(".document-body ul")).toHaveCSS(
    "list-style-type",
    "disc",
  );
  await expect(page.locator(".document-body ol")).toHaveCSS(
    "list-style-type",
    "decimal",
  );
  const sizes = await page
    .locator(".document-body")
    .evaluate((element) =>
      [element, element.querySelector("h2")!, element.querySelector("h3")!].map(
        (node) => Number.parseFloat(getComputedStyle(node).fontSize),
      ),
    );
  expect(sizes[1]!).toBeGreaterThan(sizes[2]!);
  expect(sizes[2]!).toBeGreaterThan(sizes[0]!);
  await expect(page.locator(".document-body table")).toHaveCSS(
    "overflow-x",
    "auto",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("distinguishes Document links without relying on color alone", async ({
  page,
}) => {
  await page.goto("/");

  const link = page
    .locator(".document-body")
    .getByRole("link", { name: "Путеводитель" });
  const restingStyle = await link.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontWeight: Number.parseInt(style.fontWeight, 10),
      textDecorationLine: style.textDecorationLine,
      textDecorationThickness: Number.parseFloat(style.textDecorationThickness),
    };
  });

  expect(restingStyle.fontWeight).toBeGreaterThanOrEqual(600);
  expect(restingStyle.textDecorationLine).toContain("underline");
  expect(restingStyle.textDecorationThickness).toBeGreaterThanOrEqual(2);
});

test("announces distinct missing and server-error states in Russian", async ({
  page,
}) => {
  await page.route("**/api/documents?path=%D0%9D%D0%B5%D1%82.md", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ code: "DOCUMENT_NOT_FOUND" }),
    }),
  );
  await page.goto("/documents/%D0%9D%D0%B5%D1%82.md");
  await expect(
    page.getByRole("heading", { name: "Документ недоступен" }),
  ).toBeVisible();

  await page.route("**/api/documents?path=index.md", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "SERVER_UNAVAILABLE" }),
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Сервер Индексари недоступен" }),
  ).toBeVisible();
  await expect(page.getByRole("main").getByRole("status")).toContainText(
    "Не удалось получить данные",
  );
});
