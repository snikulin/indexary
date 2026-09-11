export interface HomeDocument {
  path: "index.md";
  title: string;
  html: string;
}

export async function fetchHomeDocument(): Promise<HomeDocument> {
  const response = await fetch("/api/documents/home", {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error("HOME_DOCUMENT_UNAVAILABLE");
  }

  return (await response.json()) as HomeDocument;
}
