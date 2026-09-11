import { expect, test } from "@playwright/test";

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
