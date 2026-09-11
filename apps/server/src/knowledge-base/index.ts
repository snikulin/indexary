import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  interpretDocumentForIndex,
  type DocumentRepresentation,
  type DocumentSearchFields,
  unreadableDocument,
} from "./document.js";

const HOME_DOCUMENT_PATH = "index.md";
const CATALOG_VERSION = 2;
const SNIPPET_START = "\u{E000}";
const SNIPPET_END = "\u{E001}";

export type KnowledgeBaseStatus =
  | { state: "initializing" }
  | { state: "ready" }
  | { state: "home-document-unavailable" };

export type CatalogDiagnosticCode =
  "SYMLINK_CYCLIC" | "SYMLINK_EXTERNAL" | "SYMLINK_UNAVAILABLE";

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
  status(): KnowledgeBaseStatus;
  browseFolder(folderPath?: string): Promise<CatalogFolder | undefined>;
  openDocument(
    documentPath: string,
  ): Promise<DocumentRepresentation | undefined>;
  openHomeDocument(): Promise<
    DocumentRepresentation<typeof HOME_DOCUMENT_PATH> | undefined
  >;
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
  diagnostics: CatalogDiagnostic[];
}

interface SqliteRow {
  [key: string]: null | number | string;
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
  SYMLINK_CYCLIC: "Циклическая символическая ссылка пропущена.",
  SYMLINK_EXTERNAL: "Символическая ссылка за пределы Базы знаний пропущена.",
  SYMLINK_UNAVAILABLE: "Недоступная символическая ссылка пропущена.",
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
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
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
  const diagnostics: CatalogDiagnostic[] = [];
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
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);

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

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
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

    if (
      metadata.isFile() &&
      link.relativePath.toLowerCase().endsWith(".md") &&
      !canonicalDocuments.has(canonicalTarget)
    ) {
      canonicalDocuments.add(canonicalTarget);
      documents.push({
        path: toCatalogPath(link.relativePath),
        canonicalPath: canonicalTarget,
      });
    }
  }

  folders.sort((left, right) => left.path.localeCompare(right.path, "en"));
  documents.sort((left, right) => left.path.localeCompare(right.path, "en"));
  diagnostics.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { folders, documents, diagnostics };
}

function defaultCacheRoot(): string {
  const configured = process.env.XDG_CACHE_HOME;
  return configured === undefined || configured.trim() === ""
    ? path.join(os.homedir(), ".cache")
    : path.resolve(configured);
}

function namespaceFor(canonicalRoot: string, profile: string): string {
  const knowledgeBaseId = createHash("sha256")
    .update(canonicalRoot)
    .digest("hex")
    .slice(0, 24);
  return path.join(
    "indexary",
    `catalog-v${CATALOG_VERSION}`,
    profile,
    knowledgeBaseId,
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

async function buildCatalog(
  canonicalRoot: string,
  cacheRoot: string,
  profile: string,
): Promise<string> {
  const discovery = await discoverKnowledgeBase(canonicalRoot);
  const canonicalCacheRoot = await canonicalizeProspectivePath(cacheRoot);
  const namespace = path.join(
    canonicalCacheRoot,
    namespaceFor(canonicalRoot, profile),
  );
  if (isInsideRoot(canonicalRoot, namespace)) {
    throw new Error(
      "The Indexary cache must remain outside the Knowledge Base.",
    );
  }
  await mkdir(namespace, { recursive: true });
  const catalogFile = path.join(namespace, "catalog.sqlite");
  const temporaryFile = path.join(
    namespace,
    `.catalog-${process.pid}-${randomUUID()}.sqlite`,
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
          await readFile(discovered.canonicalPath, "utf8"),
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
    database.exec("COMMIT");
    database.close();
    database = undefined;
    await rename(temporaryFile, catalogFile);
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

function queryCatalog<T>(
  catalogFile: string,
  query: (database: DatabaseSync) => T,
): T {
  const database = new DatabaseSync(catalogFile, { readOnly: true });
  try {
    return query(database);
  } finally {
    database.close();
  }
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

  async function load(): Promise<void> {
    try {
      const canonicalRoot = await realpath(configuredRoot);
      const rootMetadata = await stat(canonicalRoot);
      if (!rootMetadata.isDirectory()) {
        currentStatus = { state: "home-document-unavailable" };
        return;
      }
      const profile = options.profile ?? "default";
      if (!/^[a-z0-9][a-z0-9-]*$/.test(profile)) {
        throw new Error("The cache profile is invalid.");
      }
      catalogFile = await buildCatalog(
        canonicalRoot,
        path.resolve(options.cacheRoot ?? defaultCacheRoot()),
        profile,
      );
      const home = queryCatalog(catalogFile, (database) =>
        database
          .prepare("SELECT path FROM documents WHERE path = ?")
          .get(HOME_DOCUMENT_PATH),
      );
      currentStatus =
        home === undefined
          ? { state: "home-document-unavailable" }
          : { state: "ready" };
    } catch (error) {
      currentStatus = { state: "home-document-unavailable" };
      if (error instanceof KnowledgeBaseStartupError) {
        throw error;
      }
    }
  }

  async function initializedCatalog(): Promise<string | undefined> {
    await (initialization ?? (initialization = load()));
    return catalogFile;
  }

  return {
    initialize() {
      initialization ??= load();
      return initialization;
    },
    status() {
      return currentStatus;
    },
    async browseFolder(folderPath = "") {
      const normalized = validateRelativePath(folderPath, true);
      const file = await initializedCatalog();
      if (file === undefined) {
        return undefined;
      }
      return queryCatalog(file, (database) => {
        const folder = database
          .prepare("SELECT path, name FROM folders WHERE path = ?")
          .get(normalized) as SqliteRow | undefined;
        if (folder === undefined) {
          return undefined;
        }
        const folders = database
          .prepare(
            "SELECT path, name FROM folders WHERE parent_path = ? ORDER BY path",
          )
          .all(normalized) as unknown as SqliteRow[];
        const documents = database
          .prepare(
            "SELECT path, title FROM documents WHERE folder_path = ? ORDER BY path",
          )
          .all(normalized) as unknown as SqliteRow[];
        const diagnostics = database
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
      });
    },
    async openDocument(documentPath) {
      const normalized = validateRelativePath(documentPath, false);
      const file = await initializedCatalog();
      if (file === undefined) {
        return undefined;
      }
      return queryCatalog(file, (database) => {
        const row = database
          .prepare("SELECT representation_json FROM documents WHERE path = ?")
          .get(normalized) as SqliteRow | undefined;
        return row === undefined
          ? undefined
          : (JSON.parse(
              String(row.representation_json),
            ) as DocumentRepresentation);
      });
    },
    async openHomeDocument() {
      return (await this.openDocument(HOME_DOCUMENT_PATH)) as
        DocumentRepresentation<typeof HOME_DOCUMENT_PATH> | undefined;
    },
    async searchDocuments(request) {
      const query = request.query?.trim() ?? "";
      const tag = request.tag?.trim() ?? "";
      if (query === "" && tag === "") {
        return [];
      }

      const file = await initializedCatalog();
      if (file === undefined) {
        return [];
      }
      const normalizedTag = tag === "" ? undefined : normalizeTag(tag);

      if (query === "") {
        return queryCatalog(file, (database) => {
          const rows = database
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
        });
      }

      const matchExpression = buildSafeFtsQuery(query);
      if (matchExpression === undefined) {
        return [];
      }

      return queryCatalog(file, (database) => {
        const rows = database
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
      });
    },
  };
}
