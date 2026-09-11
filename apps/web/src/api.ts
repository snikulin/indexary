export interface DocumentRepresentation {
  path: string;
  title: string;
  html: string;
  searchableText: string;
  tags: string[];
  sourceMaterials: string[];
  properties: Array<{ name: string; value: string }>;
  diagnostics: Array<{ code: string; message: string }>;
}

export interface CatalogFolder {
  path: string;
  name: string;
  folders: Array<{ path: string; name: string }>;
  documents: Array<{ path: string; title: string }>;
  diagnostics: Array<{ path: string; code: string; message: string }>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`INDEXARY_REQUEST_FAILED_${response.status}`);
  }
  return (await response.json()) as T;
}

export function documentRoute(documentPath: string): string {
  return `/documents/${documentPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function folderRoute(folderPath: string): string {
  return folderPath === ""
    ? "/folders"
    : `/folders/${folderPath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`;
}

export function fetchDocument(
  documentPath: string,
): Promise<DocumentRepresentation> {
  const query = new URLSearchParams({ path: documentPath });
  return fetchJson<DocumentRepresentation>(`/api/documents?${query}`);
}

export function fetchHomeDocument(): Promise<DocumentRepresentation> {
  return fetchJson<DocumentRepresentation>("/api/documents/home");
}

export function fetchCatalog(folderPath = ""): Promise<CatalogFolder> {
  const query = new URLSearchParams();
  if (folderPath !== "") {
    query.set("path", folderPath);
  }
  const suffix = query.size === 0 ? "" : `?${query}`;
  return fetchJson<CatalogFolder>(`/api/catalog${suffix}`);
}
