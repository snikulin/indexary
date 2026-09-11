import { createHash, randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  readdir,
  readFile,
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
  interpretDocument,
  type Backlink,
  type DocumentRepresentation,
  unreadableDocument,
} from "./document.js";
import { createWikilinkResolver } from "./links.js";

const HOME_DOCUMENT_PATH = "index.md";
const CATALOG_VERSION = 2;

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
  materials: DocumentMaterials;
};

export interface OpenedMaterial {
  file: FileHandle;
  name: string;
  size: number;
  mimeType: string;
  preview: MaterialPreview;
}

export class InvalidKnowledgeBasePath extends Error {
  override readonly name = "InvalidKnowledgeBasePath";
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
  ): Promise<DocumentWithMaterials | undefined>;
  openHomeDocument(): Promise<
    DocumentWithMaterials<typeof HOME_DOCUMENT_PATH> | undefined
  >;
  openMaterial(
    documentPath: string,
    materialId: string,
  ): Promise<OpenedMaterial | undefined>;
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

const diagnosticMessages: Record<CatalogDiagnosticCode, string> = {
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
  const candidate = reference.replaceAll("\\", "/").split("/").at(-1) ?? "";
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
): Promise<MaterialReference & { resolvedPath?: string }> {
  const id = `${kind}-${position}`;
  if (
    reference.includes("\0") ||
    reference.includes("\\") ||
    path.posix.isAbsolute(reference) ||
    path.win32.isAbsolute(reference)
  ) {
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
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
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
        PRIMARY KEY (document_path, id),
        FOREIGN KEY (document_path) REFERENCES documents(path)
      ) STRICT;
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
    const insertDiagnostic = database.prepare(
      "INSERT INTO diagnostics(path, code, message) VALUES (?, ?, ?)",
    );
    const insertMaterial = database.prepare(`
      INSERT INTO materials(
        document_path, id, kind, position, name, path, resolved_path, status,
        mime_type, size, preview, diagnostic_code, diagnostic_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertLink = database.prepare(
      "INSERT INTO link_edges(source_path, ordinal, target, label, state, target_path, snippet) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const resolveWikilink = createWikilinkResolver(
      discovery.documents.map((document) => document.path),
    );
    const interpretedDocuments: DocumentRepresentation[] = [];
    database.exec("BEGIN IMMEDIATE");
    for (const folder of discovery.folders) {
      insertFolder.run(folder.path, folder.parentPath ?? null, folder.name);
    }
    for (const discovered of discovery.documents) {
      let document: DocumentRepresentation;
      try {
        document = await interpretDocument(
          discovered.path,
          await readFile(discovered.canonicalPath, "utf8"),
          { resolveWikilink },
        );
      } catch {
        document = unreadableDocument(discovered.path);
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
          !sourceMaterials.some(
            (source) =>
              (source.resolvedPath !== undefined &&
                source.resolvedPath === attachment.resolvedPath) ||
              source.path === attachment.path,
          ),
      );
      for (const [position, material] of [
        ...sourceMaterials,
        ...attachments,
      ].entries()) {
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
        );
      }
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

export function createKnowledgeBase(
  configuredRoot: string,
  options: KnowledgeBaseOptions = {},
): KnowledgeBase {
  let currentStatus: KnowledgeBaseStatus = { state: "initializing" };
  let initialization: Promise<void> | undefined;
  let catalogFile: string | undefined;
  let canonicalKnowledgeBaseRoot: string | undefined;

  async function load(): Promise<void> {
    try {
      const canonicalRoot = await realpath(configuredRoot);
      const rootMetadata = await stat(canonicalRoot);
      if (!rootMetadata.isDirectory()) {
        currentStatus = { state: "home-document-unavailable" };
        return;
      }
      canonicalKnowledgeBaseRoot = canonicalRoot;
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
    } catch {
      currentStatus = { state: "home-document-unavailable" };
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
        if (row === undefined) {
          return undefined;
        }
        const materialRows = database
          .prepare(
            "SELECT * FROM materials WHERE document_path = ? ORDER BY position",
          )
          .all(normalized) as unknown as SqliteRow[];
        const materials = materialRows.map(materialFromRow);
        const interpreted = JSON.parse(
          String(row.representation_json),
        ) as DocumentRepresentation;
        const backlinkRows = database
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
      });
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
      const file = await initializedCatalog();
      const canonicalRoot = canonicalKnowledgeBaseRoot;
      if (file === undefined || canonicalRoot === undefined) {
        return undefined;
      }
      const row = queryCatalog(file, (database) =>
        database
          .prepare(
            `SELECT name, resolved_path, status, mime_type, preview
             FROM materials WHERE document_path = ? AND id = ?`,
          )
          .get(normalizedDocument, materialId),
      ) as SqliteRow | undefined;
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
  };
}
