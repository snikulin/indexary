import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const HOME_DOCUMENT_PATH = "index.md";

export type KnowledgeBaseStatus =
  | { state: "initializing" }
  | { state: "ready" }
  | { state: "home-document-unavailable" };

export interface DocumentRepresentation {
  path: "index.md";
  title: string;
  html: string;
}

export interface KnowledgeBase {
  initialize(): Promise<void>;
  status(): KnowledgeBaseStatus;
  openHomeDocument(): Promise<DocumentRepresentation | undefined>;
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function inlineMarkup(value: string): string {
  return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function interpretHomeDocument(markdown: string): DocumentRepresentation {
  const normalized = markdown.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  const headingIndex = lines.findIndex((line) => /^#\s+\S/.test(line));
  const title =
    headingIndex === -1
      ? "index"
      : lines[headingIndex]!.replace(/^#\s+/, "").trim();
  const bodyLines = lines.filter((_, index) => index !== headingIndex);
  const paragraphs = bodyLines
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p>${inlineMarkup(paragraph).replaceAll("\n", "<br>")}</p>`,
    );

  return {
    path: HOME_DOCUMENT_PATH,
    title,
    html: paragraphs.join("\n"),
  };
}

export function createKnowledgeBase(configuredRoot: string): KnowledgeBase {
  let canonicalRoot: string | undefined;
  let homeDocument: DocumentRepresentation | undefined;
  let currentStatus: KnowledgeBaseStatus = { state: "initializing" };
  let initialization: Promise<void> | undefined;

  async function load(): Promise<void> {
    try {
      canonicalRoot = await realpath(configuredRoot);
      const rootMetadata = await stat(canonicalRoot);
      if (!rootMetadata.isDirectory()) {
        currentStatus = { state: "home-document-unavailable" };
        return;
      }

      const candidate = path.join(canonicalRoot, HOME_DOCUMENT_PATH);
      const canonicalCandidate = await realpath(candidate);
      if (!isInsideRoot(canonicalRoot, canonicalCandidate)) {
        currentStatus = { state: "home-document-unavailable" };
        return;
      }

      const candidateMetadata = await stat(canonicalCandidate);
      if (!candidateMetadata.isFile()) {
        currentStatus = { state: "home-document-unavailable" };
        return;
      }

      homeDocument = interpretHomeDocument(
        await readFile(canonicalCandidate, "utf8"),
      );
      currentStatus = { state: "ready" };
    } catch {
      currentStatus = { state: "home-document-unavailable" };
    }
  }

  return {
    initialize() {
      initialization ??= load();
      return initialization;
    },
    status() {
      return currentStatus;
    },
    async openHomeDocument() {
      await (initialization ?? this.initialize());
      return homeDocument;
    },
  };
}
