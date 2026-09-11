import { expect, test } from "@playwright/test";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../fixtures/knowledge-base",
);

test("opens the Home Document through the production origin", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("banner")).toContainText("Индексари");
  await expect(
    page.getByRole("navigation", { name: "База знаний" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Добро пожаловать в Индексари",
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Контекст Документа" }),
  ).toBeVisible();

  const apiResponse = await page.request.get("/api/documents/home");
  expect(apiResponse.ok()).toBe(true);
  await expect(page).toHaveURL("http://127.0.0.1:4199/");
});

test("browses nested Cyrillic paths with direct routes and browser history", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Разделы" }).click();
  await expect(page).toHaveURL(
    /\/folders\/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%D1%8B$/,
  );
  await expect(
    page.getByRole("heading", { name: "Разделы", level: 1 }),
  ).toBeVisible();

  await page
    .getByRole("main")
    .getByRole("link", { name: "Проект Альфа" })
    .click();
  await expect(page).toHaveURL(
    /\/documents\/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%D1%8B\/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%20%D0%90%D0%BB%D1%8C%D1%84%D0%B0\.md$/,
  );
  await expect(
    page.getByRole("heading", { name: "Проект Альфа", level: 1 }),
  ).toBeVisible();

  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Разделы", level: 1 }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Проект Альфа", level: 1 }),
  ).toBeVisible();

  await page.goto(
    "/documents/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%D1%8B/%D0%93%D0%BB%D1%83%D0%B1%D0%B6%D0%B5/%D0%A1%D0%B2%D0%BE%D0%B4%D0%BA%D0%B0.md",
  );
  await expect(
    page.getByRole("heading", { name: "Сводка", level: 1 }),
  ).toBeVisible();

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Добро пожаловать в Индексари",
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Последний Документ" }),
  ).toBeVisible();
});

test("catalog omits hidden Documents and keeps ordinary folder names", async ({
  request,
}) => {
  const response = await request.get("/api/catalog");
  expect(response.ok()).toBe(true);
  const catalog = (await response.json()) as {
    folders: Array<{ path: string }>;
    documents: Array<{ path: string }>;
  };
  expect(catalog.folders).toContainEqual({ path: "tools", name: "tools" });
  expect(catalog.documents.some((item) => item.path.startsWith("."))).toBe(
    false,
  );
});

test("previews and switches referenced materials in the Document context", async ({
  page,
}) => {
  await page.goto(
    "/documents/%D0%9F%D1%83%D1%82%D0%B5%D0%B2%D0%BE%D0%B4%D0%B8%D1%82%D0%B5%D0%BB%D1%8C.md",
  );
  await expect(
    page.getByRole("heading", { name: "Путеводитель", level: 1 }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Исходные материалы" }).click();
  await expect(page.getByTitle("Предпросмотр PDF: источник.pdf")).toBeVisible();
  await page.getByRole("button", { name: /схема\.svg/ }).click();
  await expect(page.getByRole("img", { name: "схема.svg" })).toBeVisible();
  await expect(page.getByRole("button", { name: /письмо\.eml/ })).toBeVisible();

  await page.getByRole("tab", { name: "Вложения" }).click();
  await expect(
    page.getByRole("link", { name: "Открыть материал" }),
  ).toHaveAttribute("target", "_blank");
  await page.getByRole("button", { name: /нет-файла\.dat/ }).click();
  await expect(page.getByRole("status")).toContainText("Материал не найден");
  await expect(
    page.getByRole("heading", { name: "Путеводитель", level: 1 }),
  ).toBeVisible();
});

test("follows a wikilink and its backlink with browser history", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator(".document-body")
    .getByRole("link", { name: "Путеводитель" })
    .click();
  await expect(page).toHaveURL(
    /\/documents\/%D0%9F%D1%83%D1%82%D0%B5%D0%B2%D0%BE%D0%B4%D0%B8%D1%82%D0%B5%D0%BB%D1%8C\.md$/,
  );

  await expect(
    page.locator(".document-body").getByText("Несуществующий — не найдено"),
  ).toBeVisible();
  await expect(
    page.locator(".document-body").getByText("Общее — неоднозначно"),
  ).toBeVisible();
  await expect(
    page.locator(".document-body").getByRole("link", {
      name: "Проектом Альфа",
    }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Обратные ссылки" }).click();
  await page
    .getByRole("list", { name: "Обратные ссылки" })
    .getByRole("link", { name: "Добро пожаловать в Индексари" })
    .click();
  await expect(page).toHaveURL("http://127.0.0.1:4199/documents/index.md");
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
test("searches from the keyboard, opens a result, preserves history, and explains no matches", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Добро пожаловать в Индексари",
      level: 1,
    }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Поиск Документов" });
  const input = dialog.getByPlaceholder("Поиск по Базе знаний");
  await input.fill("Вложенный");
  await expect(
    dialog.getByRole("link", { name: /Проект Альфа/ }),
  ).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/documents\/.*%20.*\.md$/);
  await expect(
    page.getByRole("heading", { name: "Проект Альфа", level: 1 }),
  ).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL("http://127.0.0.1:4199/");
  await page.keyboard.press("Control+k");
  await page
    .getByRole("dialog", { name: "Поиск Документов" })
    .getByPlaceholder("Поиск по Базе знаний")
    .fill("совершенно-несуществующий-запрос");
  await expect(
    page.getByText("Документы по этому запросу не найдены."),
  ).toBeVisible();
});

test("filters through a clickable tag in the shared search experience", async ({
  page,
}) => {
  await page.goto(
    "/documents/%D0%A0%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB%D1%8B/%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%20%D0%90%D0%BB%D1%8C%D1%84%D0%B0.md",
  );
  await page.getByRole("button", { name: "проект" }).click();
  const dialog = page.getByRole("dialog", { name: "Поиск Документов" });
  await expect(dialog.getByText("Тег: проект")).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: /Проект Альфа/ }),
  ).toBeVisible();
});

test("renders adversarial highlighted snippet text without creating HTML", async ({
  page,
}) => {
  await page.route("**/api/search?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          {
            path: "index.md",
            title: "Безопасный результат",
            tags: [],
            snippet: [
              { text: "<img src=x ", highlighted: false },
              { text: "onerror", highlighted: true },
              { text: "=boom>", highlighted: false },
            ],
          },
        ],
      }),
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Добро пожаловать в Индексари",
      level: 1,
    }),
  ).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Поиск Документов" });
  await dialog.getByPlaceholder("Поиск по Базе знаний").fill("onerror");

  await expect(dialog.locator("mark")).toHaveText("onerror");
  await expect(dialog).toContainText("<img src=x onerror=boom>");
  await expect(dialog.locator("img")).toHaveCount(0);
});

test("reflects live external Document create, update, rename, and delete", async ({
  page,
}) => {
  const createdName = "Браузерное наблюдение.md";
  const renamedName = "Браузерное переименование.md";
  const createdPath = path.join(fixtureRoot, createdName);
  const renamedPath = path.join(fixtureRoot, renamedName);

  try {
    await page.goto("/folders");
    await writeFile(createdPath, "# Создано извне\n\nПервая версия.\n");
    const createdLink = page
      .getByRole("main")
      .getByRole("link", { name: "Создано извне" });
    await expect(createdLink).toBeVisible({ timeout: 2_000 });
    await createdLink.click();
    await expect(
      page.getByRole("heading", { name: "Создано извне", level: 1 }),
    ).toBeVisible();

    await writeFile(createdPath, "# Обновлено извне\n\nВторая версия.\n");
    await expect(
      page.getByRole("heading", { name: "Обновлено извне", level: 1 }),
    ).toBeVisible({ timeout: 2_000 });
    await expect(page.getByRole("main")).toContainText("Вторая версия");

    await rename(createdPath, renamedPath);
    await expect(
      page.getByRole("heading", { name: "Документ недоступен", level: 1 }),
    ).toBeVisible({ timeout: 2_000 });
    await page.goto("/folders");
    const renamedLink = page
      .getByRole("main")
      .getByRole("link", { name: "Обновлено извне" });
    await expect(renamedLink).toBeVisible({ timeout: 2_000 });
    await renamedLink.click();

    await rm(renamedPath);
    await expect(
      page.getByRole("heading", { name: "Документ недоступен", level: 1 }),
    ).toBeVisible({ timeout: 2_000 });
  } finally {
    await Promise.all([
      rm(createdPath, { force: true }),
      rm(renamedPath, { force: true }),
    ]);
  }
});
