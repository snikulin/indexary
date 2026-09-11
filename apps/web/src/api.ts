export interface DocumentRepresentation {
  path: string;
  title: string;
  html: string;
  searchableText: string;
  tags: string[];
  sourceMaterials: string[];
  materials: {
    sourceMaterials: MaterialReference[];
    attachments: MaterialReference[];
  };
  properties: Array<{ name: string; value: string }>;
  diagnostics: Array<{ code: string; message: string }>;
  outgoingLinks: Array<{
    target: string;
    label: string;
    state: "resolved" | "missing" | "ambiguous";
    path?: string;
    snippet: string;
  }>;
  backlinks: Array<{ path: string; title: string; snippet: string }>;
}

export interface MaterialReference {
  id: string;
  kind: "source-material" | "attachment";
  name: string;
  path: string;
  status: "available" | "missing" | "invalid";
  mimeType: string;
  size: number | null;
  preview: "image" | "pdf" | "unsupported";
  diagnostic?: { code: string; message: string };
}

export interface CatalogFolder {
  path: string;
  name: string;
  folders: Array<{ path: string; name: string }>;
  documents: Array<{ path: string; title: string }>;
  diagnostics: Array<{ path: string; code: string; message: string }>;
}

export interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  snippet: Array<{ text: string; highlighted: boolean }>;
}

export interface SearchResponse {
  results: SearchResult[];
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

export function materialUrl(documentPath: string, materialId: string): string {
  return `/api/materials?${new URLSearchParams({
    document: documentPath,
    id: materialId,
  })}`;
}

export function fetchSearch(
  query: string,
  tag?: string,
): Promise<SearchResponse> {
  const parameters = new URLSearchParams();
  if (query.trim() !== "") {
    parameters.set("q", query);
  }
  if (tag !== undefined && tag.trim() !== "") {
    parameters.set("tag", tag);
  }
  return fetchJson<SearchResponse>(`/api/search?${parameters}`);
}
