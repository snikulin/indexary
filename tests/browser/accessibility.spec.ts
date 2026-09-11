import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectVisibleControlsToBeNamed(page: Page) {
  const controls = page.locator(
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

test("exposes the desktop Atlas landmarks, names, tabs, and visible focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  await expect(page.getByRole("banner")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "База знаний" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Контекст Документа" }),
  ).toBeVisible();
  await expect(page.locator(".atlas-grid")).toHaveCSS("display", "grid");

  const selectedTab = page.getByRole("tab", { name: "Свойства" });
  await expect(selectedTab).toHaveAttribute("aria-selected", "true");
  const panelId = await selectedTab.getAttribute("aria-controls");
  expect(panelId).not.toBeNull();
  await expect(page.locator(`[id=${JSON.stringify(panelId)}]`)).toHaveRole(
    "tabpanel",
  );
  await expectVisibleControlsToBeNamed(page);
  await expectVisibleFocus(selectedTab);
});

test("keeps navigation and Document context available in tablet drawers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto(
    "/documents/%D0%9F%D1%83%D1%82%D0%B5%D0%B2%D0%BE%D0%B4%D0%B8%D1%82%D0%B5%D0%BB%D1%8C.md",
  );

  await expect(page.locator(".desktop-panel").first()).toBeHidden();
  const navigationTrigger = page.getByRole("button", {
    name: "Открыть навигацию",
  });
  await navigationTrigger.focus();
  await navigationTrigger.press("Enter");
  const navigationDrawer = page.getByRole("dialog", {
    name: "Навигация по Базе знаний",
  });
  await expect(navigationDrawer).toBeVisible();
  await expect(
    navigationDrawer.getByRole("navigation", { name: "База знаний" }),
  ).toBeVisible();
  await expect(
    navigationDrawer.getByRole("button", { name: "Закрыть" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(navigationTrigger).toBeFocused();

  const contextTrigger = page.getByRole("button", {
    name: "Открыть контекст",
  });
  await contextTrigger.press("Enter");
  const contextDrawer = page.getByRole("dialog", {
    name: "Контекст выбранного Документа",
  });
  await expect(contextDrawer).toBeVisible();
  await contextDrawer.getByRole("tab", { name: "Свойства" }).press("Home");
  await expect(
    contextDrawer.getByRole("tab", { name: "Исходные материалы" }),
  ).toBeFocused();
  await expect(
    contextDrawer.getByTitle("Предпросмотр PDF: источник.pdf"),
  ).toBeVisible();
  await contextDrawer
    .getByRole("button", { name: /схема\.svg/ })
    .press("Enter");
  await expect(
    contextDrawer.getByRole("img", { name: "схема.svg" }),
  ).toBeVisible();

  const close = contextDrawer.getByRole("button", { name: "Закрыть" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(contextDrawer.locator(":focus")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(contextTrigger).toBeFocused();
});

test("retains both Atlas side areas on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/");

  await page.getByRole("button", { name: "Открыть навигацию" }).press("Enter");
  const navigationDrawer = page.getByRole("dialog", {
    name: "Навигация по Базе знаний",
  });
  await expect(
    navigationDrawer.getByRole("button", { name: "Поиск по Базе знаний" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Открыть контекст" }).press("Enter");
  const contextDrawer = page.getByRole("dialog", {
    name: "Контекст выбранного Документа",
  });
  await expect(
    contextDrawer.getByRole("tab", { name: "Обратные ссылки" }),
  ).toBeVisible();
  await expect(
    contextDrawer.getByRole("tab", { name: "Вложения" }),
  ).toBeVisible();
});

test("operates search and context journeys from the keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    "/documents/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%D1%8B/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%20%D0%90%D0%BB%D1%8C%D1%84%D0%B0.md",
  );

  const tag = page.getByRole("button", { name: "проект" });
  await tag.focus();
  await tag.press("Enter");
  const search = page.getByRole("dialog", { name: "Поиск Документов" });
  await expect(search.getByRole("combobox")).toBeFocused();
  await expect(search.getByText("Тег: проект")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tag).toBeFocused();

  await page.keyboard.press("Control+k");
  await search.getByRole("combobox").fill("Вложенный");
  await search.getByRole("combobox").press("Enter");
  await expect(
    page.getByRole("heading", { name: "Проект Альфа", level: 1 }),
  ).toBeVisible();

  const properties = page.getByRole("tab", { name: "Свойства" });
  await properties.focus();
  await properties.press("Home");
  const sources = page.getByRole("tab", { name: "Исходные материалы" });
  await expect(sources).toBeFocused();
  await sources.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Ссылки", exact: true }),
  ).toBeFocused();
});

test("follows navigation, wikilinks, and backlinks by keyboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

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

  const properties = page.getByRole("tab", { name: "Свойства" });
  await properties.focus();
  await properties.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const backlinks = page.getByRole("tab", { name: "Обратные ссылки" });
  await expect(backlinks).toBeFocused();
  const backlink = page
    .getByRole("tabpanel", { name: "Обратные ссылки" })
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
  await page.goForward();
  await expect(
    page.getByRole("heading", {
      name: "Добро пожаловать в Индексари",
      level: 1,
    }),
  ).toBeVisible();
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
