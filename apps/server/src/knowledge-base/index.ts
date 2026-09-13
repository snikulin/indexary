import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
  lstat,
  open,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type Backlink,
  interpretDocumentForIndex,
  type DocumentRepresentation,
  type DocumentSearchFields,
  unreadableDocument,
} from "./document.js";
import { createWikilinkResolver } from "./links.js";

const HOME_DOCUMENT_PATH = "index.md";
const CATALOG_VERSION = 5;
const WATCH_DEBOUNCE_MS = 120;
const WATCH_MAX_WAIT_MS = 800;
const CHANGE_HISTORY_LIMIT = 512;
const SNIPPET_START = "\u{E000}";
const SNIPPET_END = "\u{E001}";

export type KnowledgeBaseStatus =
  | { state: "initializing" }
  | {
      state: "ready";
      degradedCount: number;
      homeDocument: "available" | "unavailable";
    }
  | { state: "knowledge-base-unavailable" };

export type CatalogDiagnosticCode =
  | "CONTENT_UNAVAILABLE"
  | "SYMLINK_CYCLIC"
  | "SYMLINK_EXTERNAL"
  | "SYMLINK_UNAVAILABLE";

export interface CatalogDiagnostic {
  code: CatalogDiagnosticCode;
  path: string;
  message: string;
}

export interface CatalogFolderEntry {
  path: string;
  name: string;
}

export interface CatalogDocumentEntry {
  path: string;
  title: string;
}

export interface CatalogFolder {
  path: string;
  name: string;
  folders: CatalogFolderEntry[];
  documents: CatalogDocumentEntry[];
  diagnostics: CatalogDiagnostic[];
}

export type MaterialKind = "source-material" | "attachment";
export type MaterialStatus = "available" | "missing" | "invalid";
export type MaterialPreview = "image" | "pdf" | "unsupported";
export type MaterialDiagnosticCode =
  | "MATERIAL_EXTERNAL"
  | "MATERIAL_INVALID_PATH"
  | "MATERIAL_MISSING"
  | "MATERIAL_NOT_FILE"
  | "MATERIAL_UNAVAILABLE";

export interface MaterialDiagnostic {
  code: MaterialDiagnosticCode;
  message: string;
}

export interface MaterialReference {
  id: string;
  kind: MaterialKind;
  name: string;
  path: string;
  status: MaterialStatus;
  mimeType: string;
  size: number | null;
  preview: MaterialPreview;
  diagnostic?: MaterialDiagnostic;
}

export interface DocumentMaterials {
  sourceMaterials: MaterialReference[];
  attachments: MaterialReference[];
}

export type DocumentWithMaterials<DocumentPath extends string = string> = Omit<
  DocumentRepresentation<DocumentPath>,
  "attachmentPaths"
> & {
  revision: number;
  materials: DocumentMaterials;
};

export type KnowledgeBaseChangeType =
  "catalog-changed" | "document-changed" | "document-removed";

export interface KnowledgeBaseChange {
  revision: number;
  type: KnowledgeBaseChangeType;
  path?: string;
  resync?: true;
}

export interface OpenedMaterial {
  file: FileHandle;
  name: string;
  size: number;
  mimeType: string;
  preview: MaterialPreview;
}

export interface SearchSnippetPart {
  text: string;
  highlighted: boolean;
}

export interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  snippet: SearchSnippetPart[];
}

export interface SearchRequest {
  query?: string;
  tag?: string;
}

export class InvalidKnowledgeBasePath extends Error {
  override readonly name = "InvalidKnowledgeBasePath";
}

export class KnowledgeBaseStartupError extends Error {
  override readonly name = "KnowledgeBaseStartupError";
}

export interface KnowledgeBaseOptions {
  cacheRoot?: string;
  profile?: string;
}

export interface KnowledgeBase {
  initialize(): Promise<void>;
  close(): Promise<void>;
  status(): KnowledgeBaseStatus;
  subscribeChanges(
    lastRevision: number | undefined,
    listener: (change: KnowledgeBaseChange) => void,
  ): () => void;
  browseFolder(folderPath?: string): Promise<CatalogFolder | undefined>;
  openDocument(
    documentPath: string,
  ): Promise<DocumentWithMaterials | undefined>;
  openHomeDocument(): Promise<
    DocumentWithMaterials<typeof HOME_DOCUMENT_PATH> | undefined
  >;
  openMaterial(
    documentPath: string,
    materialId: string,
  ): Promise<OpenedMaterial | undefined>;
  searchDocuments(request: SearchRequest): Promise<SearchResult[]>;
}

interface DiscoveredFolder {
  path: string;
  name: string;
  parentPath: string | undefined;
}

interface DiscoveredDocument {
  path: string;
  canonicalPath: string;
}

interface Discovery {
  folders: DiscoveredFolder[];
  documents: DiscoveredDocument[];
  materialPaths: string[];
  diagnostics: CatalogDiagnostic[];
  sourceFingerprint: string;
}

interface SqliteRow {
  [key: string]: null | number | string;
}

interface CatalogSnapshot {
  catalog: string;
  documents: Map<string, string>;
}

function normalizeIndexedText(value: string): string {
  return value
    .normalize("NFKC")
    .replaceAll(SNIPPET_START, " ")
    .replaceAll(SNIPPET_END, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTag(value: string): string {
  return normalizeIndexedText(value).toLowerCase();
}

function isFtsWordCharacter(character: string): boolean {
  return /[\p{L}\p{M}\p{N}_]/u.test(character);
}

function ftsPhrase(value: string): string | undefined {
  const words = value.match(/[\p{L}\p{M}\p{N}_]+/gu);
  return words === null ? undefined : `"${words.join(" ")}"`;
}

export function buildSafeFtsQuery(input: string): string | undefined {
  const normalized = input.normalize("NFKC");
  const terms: string[] = [];

  for (let index = 0; index < normalized.length;) {
    const character = normalized[index]!;
    if (character === '"') {
      const closing = normalized.indexOf('"', index + 1);
      const end = closing === -1 ? normalized.length : closing;
      const phrase = ftsPhrase(normalized.slice(index + 1, end));
      if (phrase !== undefined) {
        terms.push(phrase);
      }
      index = closing === -1 ? normalized.length : closing + 1;
      continue;
    }
    if (!isFtsWordCharacter(character)) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < normalized.length && isFtsWordCharacter(normalized[end]!)) {
      end += 1;
    }
    const word = normalized.slice(index, end);
    const prefix = normalized[end] === "*";
    terms.push(`"${word}"${prefix ? "*" : ""}`);
    index = end + (prefix ? 1 : 0);
  }

  return terms.length === 0 ? undefined : terms.join(" AND ");
}

export function verifyFts5Support(database: Pick<DatabaseSync, "exec">): void {
  try {
    database.exec(
      "CREATE VIRTUAL TABLE temp.__indexary_fts5_probe USING fts5(value); DROP TABLE temp.__indexary_fts5_probe;",
    );
  } catch (error) {
    throw new KnowledgeBaseStartupError(
      "The pinned Node 24 runtime does not provide the required SQLite FTS5 capability.",
      { cause: error },
    );
  }
}

export function preflightKnowledgeBaseRuntime(): void {
  const database = new DatabaseSync(":memory:");
  try {
    verifyFts5Support(database);
  } finally {
    database.close();
  }
}

function snippetParts(value: string): SearchSnippetPart[] {
  const parts: SearchSnippetPart[] = [];
  let highlighted = false;
  let offset = 0;

  while (offset < value.length) {
    const marker = highlighted ? SNIPPET_END : SNIPPET_START;
    const markerOffset = value.indexOf(marker, offset);
    const end = markerOffset === -1 ? value.length : markerOffset;
    if (end > offset) {
      parts.push({ text: value.slice(offset, end), highlighted });
    }
    if (markerOffset === -1) {
      break;
    }
    highlighted = !highlighted;
    offset = markerOffset + marker.length;
  }

  return parts;
}

const diagnosticMessages: Record<CatalogDiagnosticCode, string> = {
  CONTENT_UNAVAILABLE: "Недоступное содержимое пропущено.",
  SYMLINK_CYCLIC: "Циклическая символическая ссылка пропущена.",
  SYMLINK_EXTERNAL: "Символическая ссылка за пределы Базы знаний пропущена.",
  SYMLINK_UNAVAILABLE: "Недоступная символическая ссылка пропущена.",
};

const materialDiagnosticMessages: Record<MaterialDiagnosticCode, string> = {
  MATERIAL_EXTERNAL: "Материал находится за пределами Базы знаний.",
  MATERIAL_INVALID_PATH: "Путь к материалу недопустим.",
  MATERIAL_MISSING: "Материал не найден.",
  MATERIAL_NOT_FILE: "Ссылка на материал не указывает на файл.",
  MATERIAL_UNAVAILABLE: "Материал недоступен для чтения.",
};

const materialTypes: Record<
  string,
  { mimeType: string; preview: MaterialPreview }
> = {
  ".avif": { mimeType: "image/avif", preview: "image" },
  ".bmp": { mimeType: "image/bmp", preview: "image" },
  ".docx": {
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    preview: "unsupported",
  },
  ".eml": { mimeType: "message/rfc822", preview: "unsupported" },
  ".gif": { mimeType: "image/gif", preview: "image" },
  ".jpeg": { mimeType: "image/jpeg", preview: "image" },
  ".jpg": { mimeType: "image/jpeg", preview: "image" },
  ".pdf": { mimeType: "application/pdf", preview: "pdf" },
  ".png": { mimeType: "image/png", preview: "image" },
  ".svg": { mimeType: "image/svg+xml", preview: "image" },
  ".webp": { mimeType: "image/webp", preview: "image" },
};

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function hasHiddenSegment(relativePath: string): boolean {
  return relativePath
    .split(path.sep)
    .some((segment) => segment.startsWith("."));
}

function toCatalogPath(relativePath: string): string {
  return relativePath.split(path.sep).join(path.posix.sep);
}

function validateRelativePath(value: string, allowRoot: boolean): string {
  if (value.includes("\0") || path.posix.isAbsolute(value)) {
    throw new InvalidKnowledgeBasePath("The path must be relative.");
  }

  const normalized = path.posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== value ||
    (!allowRoot && normalized === "")
  ) {
    if (allowRoot && value === "") {
      return "";
    }
    throw new InvalidKnowledgeBasePath("The path is not canonical.");
  }
  return normalized;
}

function materialType(materialPath: string): {
  mimeType: string;
  preview: MaterialPreview;
} {
  return (
    materialTypes[path.posix.extname(materialPath).toLowerCase()] ?? {
      mimeType: "application/octet-stream",
      preview: "unsupported",
    }
  );
}

function safeMaterialName(reference: string): string {
  const candidate = reference.split("/").at(-1) ?? "";
  const cleaned = [...candidate]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("")
    .trim();
  return cleaned === "" ? "Материал" : cleaned;
}

function materialFailure(
  id: string,
  kind: MaterialKind,
  reference: string,
  code: MaterialDiagnosticCode,
  displayPath = safeMaterialName(reference),
): MaterialReference {
  const type = materialType(reference);
  return {
    id,
    kind,
    name: safeMaterialName(reference),
    path: displayPath,
    status: code === "MATERIAL_MISSING" ? "missing" : "invalid",
    mimeType: type.mimeType,
    size: null,
    preview: type.preview,
    diagnostic: { code, message: materialDiagnosticMessages[code] },
  };
}

async function inspectMaterial(
  canonicalRoot: string,
  documentPath: string,
  kind: MaterialKind,
  position: number,
  reference: string,
): Promise<
  MaterialReference & { resolvedPath?: string; contentFingerprint?: string }
> {
  const id = `${kind}-${position}`;
  if (reference.includes("\0") || path.posix.isAbsolute(reference)) {
    return materialFailure(id, kind, reference, "MATERIAL_INVALID_PATH");
  }

  const segments = reference.split("/");
  if (
    reference === "" ||
    segments.includes("") ||
    (kind === "source-material" && segments.includes(".."))
  ) {
    return materialFailure(id, kind, reference, "MATERIAL_INVALID_PATH");
  }

  const base =
    kind === "source-material" ? "" : path.posix.dirname(documentPath);
  const relativePath = path.posix.normalize(path.posix.join(base, reference));
  if (
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.toLowerCase().endsWith(".md")
  ) {
    return materialFailure(id, kind, reference, "MATERIAL_INVALID_PATH");
  }

  const absolutePath = path.join(canonicalRoot, ...relativePath.split("/"));
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return materialFailure(
      id,
      kind,
      reference,
      code === "ENOENT" ? "MATERIAL_MISSING" : "MATERIAL_UNAVAILABLE",
      relativePath,
    );
  }
  if (!isInsideRoot(canonicalRoot, canonicalTarget)) {
    return materialFailure(id, kind, reference, "MATERIAL_EXTERNAL");
  }

  let metadata;
  try {
    metadata = await stat(canonicalTarget);
  } catch {
    return materialFailure(
      id,
      kind,
      reference,
      "MATERIAL_UNAVAILABLE",
      relativePath,
    );
  }
  if (!metadata.isFile()) {
    return materialFailure(
      id,
      kind,
      reference,
      "MATERIAL_NOT_FILE",
      relativePath,
    );
  }

  const type = materialType(relativePath);
  return {
    id,
    kind,
    name: safeMaterialName(relativePath),
    path: relativePath,
    resolvedPath: toCatalogPath(path.relative(canonicalRoot, canonicalTarget)),
    contentFingerprint: `${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`,
    status: "available",
    mimeType: type.mimeType,
    size: metadata.size,
    preview: type.preview,
  };
}

function folderName(folderPath: string): string {
  return folderPath === ""
    ? "База знаний"
    : (folderPath.split("/").at(-1) ?? folderPath);
}

function addDiagnostic(
  diagnostics: CatalogDiagnostic[],
  code: CatalogDiagnosticCode,
  relativePath: string,
): void {
  const catalogPath = toCatalogPath(relativePath);
  if (
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === code && diagnostic.path === catalogPath,
    )
  ) {
    return;
  }
  diagnostics.push({
    code,
    path: catalogPath,
    message: diagnosticMessages[code],
  });
}

async function discoverKnowledgeBase(
  canonicalRoot: string,
): Promise<Discovery> {
  const folders: DiscoveredFolder[] = [
    { path: "", name: folderName(""), parentPath: undefined },
  ];
  const documents: DiscoveredDocument[] = [];
  const materialPaths: string[] = [];
  const diagnostics: CatalogDiagnostic[] = [];
  const sourceState = createHash("sha256");
  const canonicalFolders = new Set([canonicalRoot]);
  const canonicalDocuments = new Set<string>();
  const symbolicLinks: Array<{
    absolutePath: string;
    relativePath: string;
    canonicalParent: string;
  }> = [];

  async function walk(
    absoluteDirectory: string,
    relativeDirectory: string,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      addDiagnostic(
        diagnostics,
        "CONTENT_UNAVAILABLE",
        relativeDirectory || ".",
      );
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      let entryMetadata;
      try {
        entryMetadata = await lstat(absolutePath);
      } catch {
        addDiagnostic(diagnostics, "CONTENT_UNAVAILABLE", relativePath);
        sourceState.update(`${toCatalogPath(relativePath)}\0unavailable\0`);
        continue;
      }
      sourceState.update(
        `${toCatalogPath(relativePath)}\0${entryMetadata.mode}\0${entryMetadata.size}\0${entryMetadata.mtimeMs}\0${entryMetadata.ctimeMs}\0`,
      );

      if (entry.isSymbolicLink()) {
        symbolicLinks.push({
          absolutePath,
          relativePath,
          canonicalParent: await realpath(absoluteDirectory),
        });
        continue;
      }

      if (entry.isDirectory()) {
        let canonicalDirectory: string;
        try {
          canonicalDirectory = await realpath(absolutePath);
        } catch {
          continue;
        }
        const canonicalRelative = path.relative(
          canonicalRoot,
          canonicalDirectory,
        );
        if (
          !isInsideRoot(canonicalRoot, canonicalDirectory) ||
          hasHiddenSegment(canonicalRelative) ||
          canonicalFolders.has(canonicalDirectory)
        ) {
          continue;
        }
        canonicalFolders.add(canonicalDirectory);
        const catalogPath = toCatalogPath(relativePath);
        folders.push({
          path: catalogPath,
          name: entry.name,
          parentPath: toCatalogPath(relativeDirectory),
        });
        await walk(absolutePath, relativePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) {
        materialPaths.push(toCatalogPath(relativePath));
        continue;
      }
      let canonicalDocument: string;
      try {
        canonicalDocument = await realpath(absolutePath);
      } catch {
        continue;
      }
      const canonicalRelative = path.relative(canonicalRoot, canonicalDocument);
      if (
        !isInsideRoot(canonicalRoot, canonicalDocument) ||
        hasHiddenSegment(canonicalRelative) ||
        canonicalDocuments.has(canonicalDocument)
      ) {
        continue;
      }
      canonicalDocuments.add(canonicalDocument);
      documents.push({
        path: toCatalogPath(relativePath),
        canonicalPath: canonicalDocument,
      });
    }
  }

  await walk(canonicalRoot, "");

  for (const link of symbolicLinks) {
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(link.absolutePath);
    } catch (error) {
      addDiagnostic(
        diagnostics,
        (error as NodeJS.ErrnoException).code === "ELOOP"
          ? "SYMLINK_CYCLIC"
          : "SYMLINK_UNAVAILABLE",
        link.relativePath,
      );
      continue;
    }

    const canonicalRelative = path.relative(canonicalRoot, canonicalTarget);
    if (
      !isInsideRoot(canonicalRoot, canonicalTarget) ||
      hasHiddenSegment(canonicalRelative)
    ) {
      addDiagnostic(diagnostics, "SYMLINK_EXTERNAL", link.relativePath);
      continue;
    }

    let metadata;
    try {
      metadata = await stat(canonicalTarget);
    } catch {
      addDiagnostic(diagnostics, "SYMLINK_UNAVAILABLE", link.relativePath);
      continue;
    }

    if (metadata.isDirectory()) {
      if (isInsideRoot(canonicalTarget, link.canonicalParent)) {
        addDiagnostic(diagnostics, "SYMLINK_CYCLIC", link.relativePath);
      }
      continue;
    }

    if (metadata.isFile()) {
      if (link.relativePath.toLowerCase().endsWith(".md")) {
        if (!canonicalDocuments.has(canonicalTarget)) {
          canonicalDocuments.add(canonicalTarget);
          documents.push({
            path: toCatalogPath(link.relativePath),
            canonicalPath: canonicalTarget,
          });
        }
      } else {
        materialPaths.push(toCatalogPath(link.relativePath));
      }
    }
  }

  folders.sort((left, right) => left.path.localeCompare(right.path, "en"));
  documents.sort((left, right) => left.path.localeCompare(right.path, "en"));
  materialPaths.sort((left, right) => left.localeCompare(right, "en"));
  diagnostics.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    folders,
    documents,
    materialPaths,
    diagnostics,
    sourceFingerprint: sourceState.digest("hex"),
  };
}

export async function readDiscoveredDocument(
  canonicalRoot: string,
  canonicalPath: string,
): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(canonicalPath, "r");
    const openedTarget = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!isInsideRoot(canonicalRoot, openedTarget)) {
      throw new Error("The opened Document left the Knowledge Base.");
    }
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("The opened Document is not a file.");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function defaultCacheRoot(): string {
  const configured = process.env.XDG_CACHE_HOME;
  return configured === undefined || configured.trim() === ""
    ? path.join(os.homedir(), ".cache")
    : path.resolve(configured);
}

interface CatalogIdentity {
  formatVersion: number;
  knowledgeBaseId: string;
  profile: string;
}

function catalogIdentity(
  canonicalRoot: string,
  profile: string,
): CatalogIdentity {
  return {
    formatVersion: CATALOG_VERSION,
    knowledgeBaseId: createHash("sha256")
      .update(canonicalRoot)
      .digest("hex")
      .slice(0, 24),
    profile,
  };
}

function namespaceFor(identity: CatalogIdentity): string {
  return path.join(
    "indexary",
    `catalog-v${identity.formatVersion}`,
    identity.profile,
    identity.knowledgeBaseId,
  );
}

async function canonicalizeProspectivePath(candidate: string): Promise<string> {
  const missingSegments: string[] = [];
  let existing = path.resolve(candidate);

  while (true) {
    try {
      return path.join(await realpath(existing), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw error;
      }
      missingSegments.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

async function catalogLocation(
  canonicalRoot: string,
  cacheRoot: string,
  profile: string,
): Promise<{
  catalogFile: string;
  namespace: string;
  identity: CatalogIdentity;
}> {
  const canonicalCacheRoot = await canonicalizeProspectivePath(cacheRoot);
  const identity = catalogIdentity(canonicalRoot, profile);
  const namespace = path.join(canonicalCacheRoot, namespaceFor(identity));
  if (isInsideRoot(canonicalRoot, namespace)) {
    throw new Error(
      "The Indexary cache must remain outside the Knowledge Base.",
    );
  }
  return {
    namespace,
    catalogFile: path.join(namespace, "catalog.sqlite"),
    identity,
  };
}

function catalogMetadata(
  database: DatabaseSync,
  key: string,
): string | undefined {
  const row = database
    .prepare("SELECT value FROM catalog_metadata WHERE key = ?")
    .get(key) as SqliteRow | undefined;
  return row === undefined ? undefined : String(row.value);
}

function nonNegativeIntegerMetadata(
  database: DatabaseSync,
  key: string,
): number | undefined {
  const stored = catalogMetadata(database, key);
  if (stored === undefined || !/^(?:0|[1-9]\d*)$/.test(stored)) {
    return undefined;
  }
  const value = Number(stored);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function validateCatalog(
  database: DatabaseSync,
  identity: CatalogIdentity,
): void {
  const integrity = database.prepare("PRAGMA quick_check").get() as
    SqliteRow | undefined;
  if (integrity?.quick_check !== "ok") {
    throw new Error("The derived index failed its integrity check.");
  }
  const version = database.prepare("PRAGMA user_version").get() as
    SqliteRow | undefined;
  if (
    Number(version?.user_version) !== identity.formatVersion ||
    catalogMetadata(database, "schema-version") !==
      String(identity.formatVersion) ||
    catalogMetadata(database, "knowledge-base-id") !==
      identity.knowledgeBaseId ||
    catalogMetadata(database, "profile") !== identity.profile ||
    !/^[a-f0-9]{64}$/.test(
      catalogMetadata(database, "source-fingerprint") ?? "",
    ) ||
    nonNegativeIntegerMetadata(database, "revision") === undefined ||
    nonNegativeIntegerMetadata(database, "degraded-count") === undefined
  ) {
    throw new Error("The derived index is incompatible with this runtime.");
  }
  const requiredSchemaProbes = [
    "SELECT path, parent_path, name FROM folders LIMIT 1",
    "SELECT path, folder_path, title, representation_json FROM documents LIMIT 1",
    "SELECT document_path, id, kind, position, name, path, resolved_path, status, mime_type, size, preview, diagnostic_code, diagnostic_message, content_fingerprint FROM materials LIMIT 1",
    "SELECT document_path, tag, normalized_tag FROM document_tags LIMIT 1",
    "SELECT document_path, name, value FROM document_metadata LIMIT 1",
    "SELECT document_path, title, tags, relative_path, metadata, body FROM document_search LIMIT 1",
    "SELECT path, code, message FROM diagnostics LIMIT 1",
    "SELECT source_path, ordinal, target, label, state, target_path, snippet FROM link_edges LIMIT 1",
  ];
  for (const probe of requiredSchemaProbes) {
    database.prepare(probe).get();
  }
  database
    .prepare(
      "SELECT document_path FROM document_search WHERE document_search MATCH ? LIMIT 1",
    )
    .get("indexary");
  const tagIndex = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'document_tags_normalized'",
    )
    .get();
  if (tagIndex === undefined) {
    throw new Error("The derived index is missing a required search index.");
  }
  const foreignKeyFailure = database.prepare("PRAGMA foreign_key_check").get();
  if (foreignKeyFailure !== undefined) {
    throw new Error("The derived index failed its foreign-key check.");
  }
}

function openCatalog(
  catalogFile: string,
  identity: CatalogIdentity,
): DatabaseSync {
  const database = new DatabaseSync(catalogFile);
  try {
    validateCatalog(database, identity);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function validStoredRevision(database: DatabaseSync): number {
  return nonNegativeIntegerMetadata(database, "revision") ?? 0;
}

function catalogDegradedCount(database: DatabaseSync): number {
  return nonNegativeIntegerMetadata(database, "degraded-count") ?? 0;
}

async function removeAbandonedCandidates(namespace: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(namespace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(".catalog-candidate-"))
      .map((entry) => rm(path.join(namespace, entry), { force: true })),
  );
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // The supported Linux target permits directory fsync. Other filesystems may
    // reject it; the already-closed SQLite candidate remains safe to rename.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function buildCatalog(
  canonicalRoot: string,
  cacheRoot: string,
  profile: string,
  revision: number,
  discovered?: Discovery,
): Promise<string> {
  const discovery = discovered ?? (await discoverKnowledgeBase(canonicalRoot));
  const { catalogFile, namespace, identity } = await catalogLocation(
    canonicalRoot,
    cacheRoot,
    profile,
  );
  await mkdir(namespace, { recursive: true });
  const temporaryFile = path.join(
    namespace,
    `.catalog-candidate-${process.pid}-${randomUUID()}.sqlite`,
  );

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(temporaryFile);
    verifyFts5Support(database);
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA user_version = ${CATALOG_VERSION};
      CREATE TABLE folders (
        path TEXT PRIMARY KEY,
        parent_path TEXT,
        name TEXT NOT NULL
      ) STRICT;
      CREATE TABLE documents (
        path TEXT PRIMARY KEY,
        folder_path TEXT NOT NULL,
        title TEXT NOT NULL,
        representation_json TEXT NOT NULL,
        FOREIGN KEY (folder_path) REFERENCES folders(path)
      ) STRICT;
      CREATE TABLE materials (
        document_path TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        resolved_path TEXT,
        status TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER,
        preview TEXT NOT NULL,
        diagnostic_code TEXT,
        diagnostic_message TEXT,
        content_fingerprint TEXT,
        PRIMARY KEY (document_path, id),
        FOREIGN KEY (document_path) REFERENCES documents(path)
      ) STRICT;
      CREATE TABLE document_tags (
        document_path TEXT NOT NULL,
        tag TEXT NOT NULL,
        normalized_tag TEXT NOT NULL,
        PRIMARY KEY (document_path, tag),
        FOREIGN KEY (document_path) REFERENCES documents(path) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX document_tags_normalized
        ON document_tags(normalized_tag, document_path);
      CREATE TABLE document_metadata (
        document_path TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (document_path, name),
        FOREIGN KEY (document_path) REFERENCES documents(path) ON DELETE CASCADE
      ) STRICT;
      CREATE VIRTUAL TABLE document_search USING fts5(
        document_path UNINDEXED,
        title,
        tags,
        relative_path,
        metadata,
        body,
        tokenize = 'unicode61 remove_diacritics 0'
      );
      CREATE TABLE diagnostics (
        path TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        PRIMARY KEY (path, code)
      ) STRICT;
      CREATE TABLE link_edges (
        source_path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        target TEXT NOT NULL,
        label TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('resolved', 'missing', 'ambiguous')),
        target_path TEXT,
        snippet TEXT NOT NULL,
        PRIMARY KEY (source_path, ordinal),
        FOREIGN KEY (source_path) REFERENCES documents(path),
        FOREIGN KEY (target_path) REFERENCES documents(path)
      ) STRICT;
      CREATE TABLE catalog_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);

    const insertFolder = database.prepare(
      "INSERT INTO folders(path, parent_path, name) VALUES (?, ?, ?)",
    );
    const insertDocument = database.prepare(
      "INSERT INTO documents(path, folder_path, title, representation_json) VALUES (?, ?, ?, ?)",
    );
    const insertTag = database.prepare(
      "INSERT INTO document_tags(document_path, tag, normalized_tag) VALUES (?, ?, ?)",
    );
    const insertMetadata = database.prepare(
      "INSERT INTO document_metadata(document_path, name, value) VALUES (?, ?, ?)",
    );
    const insertSearch = database.prepare(
      "INSERT INTO document_search(document_path, title, tags, relative_path, metadata, body) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertDiagnostic = database.prepare(
      "INSERT INTO diagnostics(path, code, message) VALUES (?, ?, ?)",
    );
    const insertMaterial = database.prepare(`
      INSERT INTO materials(
        document_path, id, kind, position, name, path, resolved_path, status,
        mime_type, size, preview, diagnostic_code, diagnostic_message,
        content_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLink = database.prepare(
      "INSERT INTO link_edges(source_path, ordinal, target, label, state, target_path, snippet) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const resolveWikilink = createWikilinkResolver(
      discovery.documents.map((document) => document.path),
      discovery.materialPaths,
    );
    const interpretedDocuments: DocumentRepresentation[] = [];
    let degradedCount = discovery.diagnostics.length;
    database.exec("BEGIN IMMEDIATE");
    for (const folder of discovery.folders) {
      insertFolder.run(folder.path, folder.parentPath ?? null, folder.name);
    }
    for (const discovered of discovery.documents) {
      let document: DocumentRepresentation;
      let searchFields: DocumentSearchFields;
      try {
        const interpreted = await interpretDocumentForIndex(
          discovered.path,
          await readDiscoveredDocument(canonicalRoot, discovered.canonicalPath),
          { resolveWikilink },
        );
        document = interpreted.document;
        searchFields = interpreted.searchFields;
      } catch {
        document = unreadableDocument(discovered.path);
        searchFields = { body: "", metadata: [] };
      }
      insertDocument.run(
        document.path,
        path.posix.dirname(document.path) === "."
          ? ""
          : path.posix.dirname(document.path),
        document.title,
        JSON.stringify(document),
      );
      interpretedDocuments.push(document);
      degradedCount += document.diagnostics.length;
      const sourceMaterials = await Promise.all(
        document.sourceMaterials.map((reference, position) =>
          inspectMaterial(
            canonicalRoot,
            document.path,
            "source-material",
            position,
            reference,
          ),
        ),
      );
      const attachments = (
        await Promise.all(
          document.attachmentPaths.map((reference, position) =>
            inspectMaterial(
              canonicalRoot,
              document.path,
              "attachment",
              position,
              reference,
            ),
          ),
        )
      ).filter(
        (attachment) =>
          !sourceMaterials.some((source) => source.path === attachment.path),
      );
      for (const [position, material] of [
        ...sourceMaterials,
        ...attachments,
      ].entries()) {
        if (material.diagnostic !== undefined) {
          degradedCount += 1;
        }
        insertMaterial.run(
          document.path,
          material.id,
          material.kind,
          position,
          material.name,
          material.path,
          material.resolvedPath ?? null,
          material.status,
          material.mimeType,
          material.size,
          material.preview,
          material.diagnostic?.code ?? null,
          material.diagnostic?.message ?? null,
          material.contentFingerprint ?? null,
        );
      }
      for (const tag of document.tags) {
        insertTag.run(document.path, tag, normalizeTag(tag));
      }
      for (const property of searchFields.metadata) {
        insertMetadata.run(document.path, property.name, property.value);
      }
      insertSearch.run(
        document.path,
        normalizeIndexedText(document.title),
        normalizeIndexedText(document.tags.join(" ")),
        normalizeIndexedText(document.path),
        normalizeIndexedText(
          searchFields.metadata.map((property) => property.value).join(" "),
        ),
        normalizeIndexedText(searchFields.body),
      );
    }
    for (const document of interpretedDocuments) {
      for (const [ordinal, link] of document.outgoingLinks.entries()) {
        insertLink.run(
          document.path,
          ordinal,
          link.target,
          link.label,
          link.state,
          link.path ?? null,
          link.snippet,
        );
      }
    }
    for (const diagnostic of discovery.diagnostics) {
      insertDiagnostic.run(
        diagnostic.path,
        diagnostic.code,
        diagnostic.message,
      );
    }
    database
      .prepare("INSERT INTO catalog_metadata(key, value) VALUES (?, ?)")
      .run("schema-version", String(CATALOG_VERSION));
    database
      .prepare("INSERT INTO catalog_metadata(key, value) VALUES (?, ?)")
      .run("revision", String(revision));
    database
      .prepare("INSERT INTO catalog_metadata(key, value) VALUES (?, ?)")
      .run("knowledge-base-id", identity.knowledgeBaseId);
    database
      .prepare("INSERT INTO catalog_metadata(key, value) VALUES (?, ?)")
      .run("profile", identity.profile);
    database
      .prepare("INSERT INTO catalog_metadata(key, value) VALUES (?, ?)")
      .run("degraded-count", String(degradedCount));
    database
      .prepare("INSERT INTO catalog_metadata(key, value) VALUES (?, ?)")
      .run("source-fingerprint", discovery.sourceFingerprint);
    database.exec("COMMIT");
    database.close();
    database = undefined;
    const verified = openCatalog(temporaryFile, identity);
    verified.close();
    await rename(temporaryFile, catalogFile);
    await syncDirectory(namespace);
    return catalogFile;
  } catch (error) {
    try {
      database?.close();
    } finally {
      await rm(temporaryFile, { force: true });
    }
    throw error;
  }
}

function snapshotCatalog(database: DatabaseSync): CatalogSnapshot {
  const folders = database
    .prepare("SELECT path, parent_path, name FROM folders ORDER BY path")
    .all() as unknown as SqliteRow[];
  const diagnostics = database
    .prepare("SELECT path, code, message FROM diagnostics ORDER BY path, code")
    .all() as unknown as SqliteRow[];
  const documentRows = database
    .prepare(
      "SELECT path, folder_path, title, representation_json FROM documents ORDER BY path",
    )
    .all() as unknown as SqliteRow[];
  const materials = database
    .prepare(
      `SELECT document_path, id, kind, position, name, path, resolved_path,
                status, mime_type, size, preview, diagnostic_code,
                diagnostic_message, content_fingerprint
         FROM materials ORDER BY document_path, position, id`,
    )
    .all() as unknown as SqliteRow[];
  const incomingLinks = database
    .prepare(
      `SELECT links.target_path AS document_path, links.source_path,
                documents.title, links.ordinal, links.snippet
         FROM link_edges AS links
         JOIN documents ON documents.path = links.source_path
         WHERE links.state = 'resolved'
         ORDER BY links.target_path, links.source_path, links.ordinal`,
    )
    .all() as unknown as SqliteRow[];

  const materialsByDocument = new Map<string, SqliteRow[]>();
  for (const material of materials) {
    const documentPath = String(material.document_path);
    const grouped = materialsByDocument.get(documentPath) ?? [];
    grouped.push(material);
    materialsByDocument.set(documentPath, grouped);
  }
  const backlinksByDocument = new Map<string, SqliteRow[]>();
  for (const link of incomingLinks) {
    const documentPath = String(link.document_path);
    const grouped = backlinksByDocument.get(documentPath) ?? [];
    grouped.push(link);
    backlinksByDocument.set(documentPath, grouped);
  }

  const documents = new Map<string, string>();
  for (const row of documentRows) {
    const documentPath = String(row.path);
    documents.set(
      documentPath,
      JSON.stringify({
        title: row.title,
        representation: row.representation_json,
        materials: materialsByDocument.get(documentPath) ?? [],
        backlinks: backlinksByDocument.get(documentPath) ?? [],
      }),
    );
  }

  return {
    catalog: JSON.stringify({
      folders,
      diagnostics,
      documents: documentRows.map((row) => ({
        path: row.path,
        folder: row.folder_path,
        title: row.title,
      })),
    }),
    documents,
  };
}

function updateCatalogRevision(database: DatabaseSync, revision: number): void {
  try {
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare("UPDATE catalog_metadata SET value = ? WHERE key = 'revision'")
      .run(String(revision));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function materialFromRow(row: SqliteRow): MaterialReference {
  const diagnosticCode = row.diagnostic_code;
  const diagnosticMessage = row.diagnostic_message;
  return {
    id: String(row.id),
    kind: String(row.kind) as MaterialKind,
    name: String(row.name),
    path: String(row.path),
    status: String(row.status) as MaterialStatus,
    mimeType: String(row.mime_type),
    size: row.size === null ? null : Number(row.size),
    preview: String(row.preview) as MaterialPreview,
    ...(diagnosticCode === null || diagnosticMessage === null
      ? {}
      : {
          diagnostic: {
            code: String(diagnosticCode) as MaterialDiagnosticCode,
            message: String(diagnosticMessage),
          },
        }),
  };
}

function searchResultFromRow(row: SqliteRow, snippet?: string): SearchResult {
  const representation = JSON.parse(
    String(row.representation_json),
  ) as DocumentRepresentation;
  const parts = snippet === undefined ? [] : snippetParts(snippet);
  return {
    path: String(row.path),
    title: String(row.title),
    tags: representation.tags,
    snippet:
      parts.length === 0
        ? [{ text: String(row.title), highlighted: false }]
        : parts,
  };
}

export function createKnowledgeBase(
  configuredRoot: string,
  options: KnowledgeBaseOptions = {},
): KnowledgeBase {
  let currentStatus: KnowledgeBaseStatus = { state: "initializing" };
  let initialization: Promise<void> | undefined;
  let catalogFile: string | undefined;
  let catalogIdentityValue: CatalogIdentity | undefined;
  let database: DatabaseSync | undefined;
  let canonicalKnowledgeBaseRoot: string | undefined;
  let cacheRoot: string | undefined;
  let profile: string | undefined;
  let watcher: FSWatcher | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  let firstPendingChangeAt: number | undefined;
  let reconcilePromise: Promise<void> | undefined;
  let reconcileAgain = false;
  let startupDirty = false;
  let closed = false;
  let currentRevision = 0;
  const observedDocumentPaths = new Set<string>();
  const listeners = new Set<(change: KnowledgeBaseChange) => void>();
  const changeHistory: KnowledgeBaseChange[] = [];

  function publish(change: KnowledgeBaseChange): void {
    changeHistory.push(change);
    if (changeHistory.length > CHANGE_HISTORY_LIMIT) {
      changeHistory.splice(0, changeHistory.length - CHANGE_HISTORY_LIMIT);
    }
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        listeners.delete(listener);
      }
    }
  }

  function observeFilesystemChange(filename: string | Buffer | null): void {
    if (filename !== null) {
      const observedPath = toCatalogPath(String(filename));
      if (
        observedPath !== "" &&
        !hasHiddenSegment(observedPath) &&
        observedPath.toLowerCase().endsWith(".md")
      ) {
        observedDocumentPaths.add(observedPath);
      }
    }
    queueReconcile();
  }

  function publishStartupChanges(): void {
    const activeDatabase = database;
    if (activeDatabase === undefined || observedDocumentPaths.size === 0) {
      return;
    }
    const alreadyPublished = new Set(
      changeHistory
        .filter((change) => change.path !== undefined)
        .map((change) => change.path),
    );
    const changes: Array<Omit<KnowledgeBaseChange, "revision">> = [];
    if (!changeHistory.some((change) => change.type === "catalog-changed")) {
      changes.push({ type: "catalog-changed" });
    }
    for (const documentPath of [...observedDocumentPaths].sort((left, right) =>
      left.localeCompare(right, "en"),
    )) {
      if (alreadyPublished.has(documentPath)) {
        continue;
      }
      const exists = activeDatabase
        .prepare("SELECT 1 FROM documents WHERE path = ?")
        .get(documentPath);
      changes.push({
        type: exists === undefined ? "document-removed" : "document-changed",
        path: documentPath,
      });
    }
    const revisionedChanges = changes.map((change) => {
      currentRevision += 1;
      return { ...change, revision: currentRevision };
    });
    if (revisionedChanges.length > 0) {
      updateCatalogRevision(activeDatabase, currentRevision);
    }
    for (const change of revisionedChanges) {
      publish(change);
    }
    observedDocumentPaths.clear();
  }

  function updateStatus(activeDatabase: DatabaseSync): void {
    const home = activeDatabase
      .prepare("SELECT path FROM documents WHERE path = ?")
      .get(HOME_DOCUMENT_PATH);
    currentStatus = {
      state: "ready",
      degradedCount: catalogDegradedCount(activeDatabase),
      homeDocument: home === undefined ? "unavailable" : "available",
    };
  }

  async function reconcile(updateReadiness = true): Promise<void> {
    const activeDatabase = database;
    const identity = catalogIdentityValue;
    const canonicalRoot = canonicalKnowledgeBaseRoot;
    const resolvedCacheRoot = cacheRoot;
    const selectedProfile = profile;
    if (
      closed ||
      activeDatabase === undefined ||
      identity === undefined ||
      canonicalRoot === undefined ||
      resolvedCacheRoot === undefined ||
      selectedProfile === undefined
    ) {
      return;
    }

    const discovery = await discoverKnowledgeBase(canonicalRoot);
    const observedPaths = new Set(observedDocumentPaths);
    for (const observedPath of observedPaths) {
      observedDocumentPaths.delete(observedPath);
    }
    if (
      catalogMetadata(activeDatabase, "source-fingerprint") ===
      discovery.sourceFingerprint
    ) {
      const changes = [...observedPaths]
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((documentPath) => {
          currentRevision += 1;
          const exists = activeDatabase
            .prepare("SELECT 1 FROM documents WHERE path = ?")
            .get(documentPath);
          return {
            revision: currentRevision,
            type:
              exists === undefined
                ? ("document-removed" as const)
                : ("document-changed" as const),
            path: documentPath,
          };
        });
      if (changes.length > 0) {
        updateCatalogRevision(activeDatabase, currentRevision);
      }
      for (const change of changes) {
        publish(change);
      }
      return;
    }

    const previous = snapshotCatalog(activeDatabase);
    const rebuiltFile = await buildCatalog(
      canonicalRoot,
      resolvedCacheRoot,
      selectedProfile,
      currentRevision,
      discovery,
    );
    const nextDatabase = openCatalog(rebuiltFile, identity);
    try {
      const next = snapshotCatalog(nextDatabase);
      const changes: Array<Omit<KnowledgeBaseChange, "revision">> = [];
      if (previous.catalog !== next.catalog) {
        changes.push({ type: "catalog-changed" });
      }
      for (const [documentPath, signature] of next.documents) {
        if (previous.documents.get(documentPath) !== signature) {
          changes.push({ type: "document-changed", path: documentPath });
        }
      }
      for (const documentPath of previous.documents.keys()) {
        if (!next.documents.has(documentPath)) {
          changes.push({ type: "document-removed", path: documentPath });
        }
      }
      const changedPaths = new Set(changes.map((change) => change.path));
      for (const observedPath of observedPaths) {
        if (changedPaths.has(observedPath)) {
          continue;
        }
        changes.push({
          type: next.documents.has(observedPath)
            ? "document-changed"
            : "document-removed",
          path: observedPath,
        });
      }

      const revisionedChanges = changes.map((change) => {
        currentRevision += 1;
        return { ...change, revision: currentRevision };
      });
      if (revisionedChanges.length > 0) {
        updateCatalogRevision(nextDatabase, currentRevision);
      }
      activeDatabase.close();
      catalogFile = rebuiltFile;
      database = nextDatabase;
      if (updateReadiness) {
        updateStatus(nextDatabase);
      }
      for (const change of revisionedChanges) {
        publish(change);
      }
    } catch (error) {
      nextDatabase.close();
      throw error;
    }
  }

  function queueReconcile(): void {
    if (closed) {
      return;
    }
    if (currentStatus.state === "initializing") {
      startupDirty = true;
      return;
    }
    if (reconcilePromise !== undefined) {
      reconcileAgain = true;
      return;
    }
    const now = Date.now();
    firstPendingChangeAt ??= now;
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    const remaining = Math.max(
      0,
      WATCH_MAX_WAIT_MS - (now - firstPendingChangeAt),
    );
    debounceTimer = setTimeout(
      () => {
        debounceTimer = undefined;
        firstPendingChangeAt = undefined;
        reconcilePromise = reconcile()
          .catch(() => {
            reconcileAgain = true;
          })
          .finally(() => {
            reconcilePromise = undefined;
            if (reconcileAgain && !closed) {
              reconcileAgain = false;
              queueReconcile();
            }
          });
      },
      Math.min(WATCH_DEBOUNCE_MS, remaining),
    );
  }

  async function load(): Promise<void> {
    try {
      try {
        watcher ??= watch(
          path.resolve(configuredRoot),
          { recursive: true },
          (_eventType, filename) => observeFilesystemChange(filename),
        );
      } catch {
        // Invalid roots are reported through readiness after canonicalization.
      }
      const canonicalRoot = await realpath(configuredRoot);
      const rootMetadata = await stat(canonicalRoot);
      if (!rootMetadata.isDirectory()) {
        currentStatus = { state: "knowledge-base-unavailable" };
        return;
      }
      canonicalKnowledgeBaseRoot = canonicalRoot;
      profile = options.profile ?? "default";
      if (!/^[a-z0-9][a-z0-9-]*$/.test(profile)) {
        throw new Error("The cache profile is invalid.");
      }
      cacheRoot = path.resolve(options.cacheRoot ?? defaultCacheRoot());
      const location = await catalogLocation(canonicalRoot, cacheRoot, profile);
      catalogFile = location.catalogFile;
      catalogIdentityValue = location.identity;
      await mkdir(location.namespace, { recursive: true });
      await removeAbandonedCandidates(location.namespace);
      try {
        await stat(catalogFile);
        database = openCatalog(catalogFile, location.identity);
        currentRevision = validStoredRevision(database);
      } catch {
        database = undefined;
        currentRevision = 0;
      }
      if (closed) {
        return;
      }
      watcher ??= watch(
        canonicalRoot,
        { recursive: true },
        (_eventType, filename) => observeFilesystemChange(filename),
      );
      do {
        startupDirty = false;
        if (database === undefined) {
          currentRevision = Math.max(1, currentRevision);
          const builtFile = await buildCatalog(
            canonicalRoot,
            cacheRoot,
            profile,
            currentRevision,
          );
          database = openCatalog(builtFile, location.identity);
          catalogFile = builtFile;
        } else {
          await reconcile(false);
        }
      } while (startupDirty && !closed);
      if (database !== undefined) {
        publishStartupChanges();
        updateStatus(database);
      }
    } catch (error) {
      currentStatus = { state: "knowledge-base-unavailable" };
      if (error instanceof KnowledgeBaseStartupError) {
        throw error;
      }
    }
  }

  async function initializedCatalog(): Promise<DatabaseSync | undefined> {
    await (initialization ?? (initialization = load()));
    return database;
  }

  return {
    initialize() {
      initialization ??= load();
      return initialization;
    },
    async close() {
      closed = true;
      watcher?.close();
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      await initialization?.catch(() => undefined);
      watcher?.close();
      await reconcilePromise;
      database?.close();
      database = undefined;
      listeners.clear();
    },
    status() {
      return currentStatus;
    },
    subscribeChanges(lastRevision, listener) {
      if (
        lastRevision !== undefined &&
        (lastRevision > currentRevision ||
          (lastRevision < currentRevision &&
            (changeHistory.length === 0 ||
              lastRevision < changeHistory[0]!.revision - 1)))
      ) {
        listener({
          revision: currentRevision,
          type: "catalog-changed",
          resync: true,
        });
      } else if (lastRevision !== undefined) {
        for (const change of changeHistory) {
          if (change.revision > lastRevision) {
            listener(change);
          }
        }
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async browseFolder(folderPath = "") {
      const normalized = validateRelativePath(folderPath, true);
      const activeDatabase = await initializedCatalog();
      if (activeDatabase === undefined) {
        return undefined;
      }
      const folder = activeDatabase
        .prepare("SELECT path, name FROM folders WHERE path = ?")
        .get(normalized) as SqliteRow | undefined;
      if (folder === undefined) {
        return undefined;
      }
      const folders = activeDatabase
        .prepare(
          "SELECT path, name FROM folders WHERE parent_path = ? ORDER BY path",
        )
        .all(normalized) as unknown as SqliteRow[];
      const documents = activeDatabase
        .prepare(
          "SELECT path, title FROM documents WHERE folder_path = ? ORDER BY path",
        )
        .all(normalized) as unknown as SqliteRow[];
      const diagnostics = activeDatabase
        .prepare("SELECT path, code, message FROM diagnostics ORDER BY path")
        .all() as unknown as SqliteRow[];
      return {
        path: String(folder.path),
        name: String(folder.name),
        folders: folders.map((row) => ({
          path: String(row.path),
          name: String(row.name),
        })),
        documents: documents.map((row) => ({
          path: String(row.path),
          title: String(row.title),
        })),
        diagnostics: diagnostics.map((row) => ({
          path: String(row.path),
          code: String(row.code) as CatalogDiagnosticCode,
          message: String(row.message),
        })),
      };
    },
    async openDocument(documentPath) {
      const normalized = validateRelativePath(documentPath, false);
      const activeDatabase = await initializedCatalog();
      if (activeDatabase === undefined) {
        return undefined;
      }
      const row = activeDatabase
        .prepare(
          `SELECT documents.representation_json,
                    catalog_metadata.value AS revision
             FROM documents
             JOIN catalog_metadata ON catalog_metadata.key = 'revision'
             WHERE documents.path = ?`,
        )
        .get(normalized) as SqliteRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      const materialRows = activeDatabase
        .prepare(
          "SELECT * FROM materials WHERE document_path = ? ORDER BY position",
        )
        .all(normalized) as unknown as SqliteRow[];
      const materials = materialRows.map(materialFromRow);
      const interpreted = JSON.parse(
        String(row.representation_json),
      ) as DocumentRepresentation;
      const backlinkRows = activeDatabase
        .prepare(
          `SELECT links.source_path AS path, documents.title, links.snippet
             FROM link_edges AS links
             JOIN documents ON documents.path = links.source_path
             WHERE links.state = 'resolved' AND links.target_path = ?
             ORDER BY links.source_path, links.ordinal`,
        )
        .all(normalized) as unknown as SqliteRow[];
      const backlinks: Backlink[] = backlinkRows.map((backlink) => ({
        path: String(backlink.path),
        title: String(backlink.title),
        snippet: String(backlink.snippet),
      }));
      const { attachmentPaths, ...document } = interpreted;
      void attachmentPaths;
      return {
        ...document,
        revision: Number(row.revision),
        backlinks,
        materials: {
          sourceMaterials: materials.filter(
            (material) => material.kind === "source-material",
          ),
          attachments: materials.filter(
            (material) => material.kind === "attachment",
          ),
        },
      };
    },
    async openHomeDocument() {
      return (await this.openDocument(HOME_DOCUMENT_PATH)) as
        DocumentWithMaterials<typeof HOME_DOCUMENT_PATH> | undefined;
    },
    async openMaterial(documentPath, materialId) {
      const normalizedDocument = validateRelativePath(documentPath, false);
      if (!/^(?:source-material|attachment)-\d+$/.test(materialId)) {
        throw new InvalidKnowledgeBasePath("The material id is invalid.");
      }
      const activeDatabase = await initializedCatalog();
      const canonicalRoot = canonicalKnowledgeBaseRoot;
      if (activeDatabase === undefined || canonicalRoot === undefined) {
        return undefined;
      }
      const row = activeDatabase
        .prepare(
          `SELECT name, resolved_path, status, mime_type, preview
           FROM materials WHERE document_path = ? AND id = ?`,
        )
        .get(normalizedDocument, materialId) as SqliteRow | undefined;
      if (
        row === undefined ||
        row.status !== "available" ||
        row.resolved_path === null
      ) {
        return undefined;
      }

      const normalizedMaterial = validateRelativePath(
        String(row.resolved_path),
        false,
      );
      const candidate = path.join(
        canonicalRoot,
        ...normalizedMaterial.split("/"),
      );
      let handle: FileHandle | undefined;
      try {
        handle = await open(candidate, "r");
        const openedTarget = await realpath(`/proc/self/fd/${handle.fd}`);
        if (!isInsideRoot(canonicalRoot, openedTarget)) {
          await handle.close();
          return undefined;
        }
        const metadata = await handle.stat();
        if (!metadata.isFile()) {
          await handle.close();
          return undefined;
        }
        return {
          file: handle,
          name: String(row.name),
          size: metadata.size,
          mimeType: String(row.mime_type),
          preview: String(row.preview) as MaterialPreview,
        };
      } catch {
        await handle?.close().catch(() => undefined);
        return undefined;
      }
    },
    async searchDocuments(request) {
      const query = request.query?.trim() ?? "";
      const tag = request.tag?.trim() ?? "";
      if (query === "" && tag === "") {
        return [];
      }

      const activeDatabase = await initializedCatalog();
      if (activeDatabase === undefined) {
        return [];
      }
      const normalizedTag = tag === "" ? undefined : normalizeTag(tag);

      if (query === "") {
        const rows = activeDatabase
          .prepare(
            `SELECT path, title, representation_json
               FROM documents
               WHERE EXISTS (
                 SELECT 1 FROM document_tags
                 WHERE document_path = documents.path
                   AND normalized_tag = ?
               )
               ORDER BY title, path`,
          )
          .all(normalizedTag!) as unknown as SqliteRow[];
        return rows.map((row) => {
          const result = searchResultFromRow(row);
          const matchingTag = result.tags.find(
            (candidate) => normalizeTag(candidate) === normalizedTag,
          );
          return {
            ...result,
            snippet: [
              {
                text: matchingTag ?? tag,
                highlighted: true,
              },
            ],
          };
        });
      }

      const matchExpression = buildSafeFtsQuery(query);
      if (matchExpression === undefined) {
        return [];
      }

      const rows = activeDatabase
        .prepare(
          `SELECT document_search.document_path AS path,
                    documents.title,
                    documents.representation_json,
                    snippet(document_search, -1, ?, ?, ' … ', 24) AS snippet,
                    bm25(document_search, 0.0, 12.0, 8.0, 4.0, 2.0, 1.0) AS score
             FROM document_search
             JOIN documents ON documents.path = document_search.document_path
             WHERE document_search MATCH ?
               AND (
                 ? IS NULL OR EXISTS (
                   SELECT 1 FROM document_tags
                   WHERE document_path = documents.path
                     AND normalized_tag = ?
                 )
               )
             ORDER BY score, documents.path`,
        )
        .all(
          SNIPPET_START,
          SNIPPET_END,
          matchExpression,
          normalizedTag ?? null,
          normalizedTag ?? null,
        ) as unknown as SqliteRow[];
      return rows.map((row) => searchResultFromRow(row, String(row.snippet)));
    },
  };
}
