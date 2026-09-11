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
