import rehypeSanitize, {
  defaultSchema,
  type Options as SanitizeOptions,
} from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { parseDocument } from "yaml";

import {
  documentRoute,
  type ResolveWikilink,
  type WikilinkState,
} from "./links.js";

export type DocumentDiagnosticCode =
  | "DOCUMENT_UNREADABLE"
  | "FRONTMATTER_INVALID"
  | "FRONTMATTER_NOT_MAPPING"
  | "TITLE_INVALID"
  | "TAGS_INVALID"
  | "ORIGINALS_INVALID"
  | "ORIGINAL_PATH_INVALID"
  | "PROPERTY_INVALID"
  | "RAW_HTML_REMOVED"
  | "UNSAFE_URL_REMOVED"
  | "WIKILINK_MISSING"
  | "WIKILINK_AMBIGUOUS";

export interface DocumentDiagnostic {
  code: DocumentDiagnosticCode;
  message: string;
}

export interface DocumentProperty {
  name: string;
  value: string;
}

export interface OutgoingLink {
  target: string;
  label: string;
  state: WikilinkState;
  path?: string;
  snippet: string;
}

export interface Backlink {
  path: string;
  title: string;
  snippet: string;
}

export interface DocumentRepresentation<DocumentPath extends string = string> {
  path: DocumentPath;
  title: string;
  html: string;
  searchableText: string;
  tags: string[];
  sourceMaterials: string[];
  attachmentPaths: string[];
  properties: DocumentProperty[];
  diagnostics: DocumentDiagnostic[];
  outgoingLinks: OutgoingLink[];
  backlinks: Backlink[];
}

export interface InterpretDocumentOptions {
  resolveWikilink?: ResolveWikilink;
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  depth?: number;
  children?: MarkdownNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

const diagnosticMessages: Record<DocumentDiagnosticCode, string> = {
  DOCUMENT_UNREADABLE: "Не удалось прочитать содержимое Документа.",
  FRONTMATTER_INVALID: "Не удалось разобрать YAML-метаданные Документа.",
  FRONTMATTER_NOT_MAPPING: "YAML-метаданные Документа должны быть объектом.",
  TITLE_INVALID: "Свойство title должно быть непустой строкой.",
  TAGS_INVALID: "Свойство tags должно содержать непустые строки.",
  ORIGINALS_INVALID: "Свойство originals должно содержать пути строками.",
  ORIGINAL_PATH_INVALID:
    "Свойство original_path должно содержать один путь строкой.",
  PROPERTY_INVALID: "Одно из свойств Документа имеет неподдерживаемый вид.",
  RAW_HTML_REMOVED: "Небезопасный HTML удалён из Документа.",
  UNSAFE_URL_REMOVED: "Ссылка с небезопасной схемой отключена.",
  WIKILINK_MISSING: "Одна или несколько вики-ссылок не найдены.",
  WIKILINK_AMBIGUOUS:
    "Одна или несколько вики-ссылок имеют несколько возможных целей.",
};

const documentSanitizeSchema: SanitizeOptions = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      ["className", "wikilink", "wikilink-resolved"],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", "wikilink", "wikilink-missing", "wikilink-ambiguous"],
    ],
  },
};

function addDiagnostic(
  diagnostics: DocumentDiagnostic[],
  code: DocumentDiagnosticCode,
): void {
  if (diagnostics.some((diagnostic) => diagnostic.code === code)) {
    return;
  }
  diagnostics.push({ code, message: diagnosticMessages[code] });
}

function splitFrontmatter(markdown: string): {
  body: string;
  frontmatter?: string;
  unterminated: boolean;
} {
  const normalized = markdown.replaceAll("\r\n", "\n").replace(/^\uFEFF/, "");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { body: normalized, unterminated: false };
  }

  const closingIndex = lines.findIndex(
    (line, index) =>
      index > 0 && (line.trim() === "---" || line.trim() === "..."),
  );
  if (closingIndex === -1) {
    return {
      body: lines.slice(1).join("\n"),
      frontmatter: lines.slice(1).join("\n"),
      unterminated: true,
    };
  }

  return {
    frontmatter: lines.slice(1, closingIndex).join("\n"),
    body: lines.slice(closingIndex + 1).join("\n"),
    unterminated: false,
  };
}

function parseFrontmatter(
  source: string | undefined,
  unterminated: boolean,
  diagnostics: DocumentDiagnostic[],
): Map<string, unknown> {
  if (source === undefined) {
    return new Map();
  }
  if (unterminated) {
    addDiagnostic(diagnostics, "FRONTMATTER_INVALID");
    return new Map();
  }

  try {
    const yaml = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (yaml.errors.length > 0) {
      addDiagnostic(diagnostics, "FRONTMATTER_INVALID");
      return new Map();
    }
    const value: unknown = yaml.toJS({ mapAsMap: true, maxAliasCount: 50 });
    if (value === null) {
      return new Map();
    }
    if (!(value instanceof Map)) {
      addDiagnostic(diagnostics, "FRONTMATTER_NOT_MAPPING");
      return new Map();
    }

    const properties = new Map<string, unknown>();
    for (const [name, propertyValue] of value) {
      if (typeof name !== "string") {
        addDiagnostic(diagnostics, "PROPERTY_INVALID");
        continue;
      }
      properties.set(name, propertyValue);
    }
    return properties;
  } catch {
    addDiagnostic(diagnostics, "FRONTMATTER_INVALID");
    return new Map();
  }
}

function readableValue(
  value: unknown,
  seen = new Set<unknown>(),
): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.map((item) => readableValue(item, seen));
    seen.delete(value);
    return items.every((item) => item !== undefined)
      ? `[${items.join(", ")}]`
      : undefined;
  }
  if (value instanceof Map) {
    const items: string[] = [];
    for (const [key, item] of value) {
      if (typeof key !== "string") {
        seen.delete(value);
        return undefined;
      }
      const readable = readableValue(item, seen);
      if (readable === undefined) {
        seen.delete(value);
        return undefined;
      }
      items.push(`${key}: ${readable}`);
    }
    seen.delete(value);
    return `{${items.join(", ")}}`;
  }
  seen.delete(value);
  return undefined;
}

function parseStringList(
  value: unknown,
  diagnostics: DocumentDiagnostic[],
  code: "TAGS_INVALID" | "ORIGINALS_INVALID",
): string[] {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) {
    addDiagnostic(diagnostics, code);
    return [];
  }

  const normalized: string[] = [];
  for (const item of values) {
    if (typeof item !== "string" || item.trim() === "") {
      addDiagnostic(diagnostics, code);
      continue;
    }
    const text = item.trim();
    if (!normalized.includes(text)) {
      normalized.push(text);
    }
  }
  return normalized;
}

function textContent(node: MarkdownNode): string {
  if (
    node.type === "text" ||
    node.type === "inlineCode" ||
    node.type === "code"
  ) {
    return node.value ?? "";
  }
  if (node.type === "image") {
    return node.alt ?? "";
  }
  return (node.children ?? []).map(textContent).join(" ");
}

function attachmentPath(url: string): string | undefined {
  const value = url.trim();
  if (
    value === "" ||
    value.startsWith("#") ||
    value.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    return undefined;
  }

  const pathname = value.split(/[?#]/, 1)[0] ?? "";
  if (pathname === "") {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  return decoded.toLowerCase().endsWith(".md") ? undefined : decoded;
}

function collectAttachmentPaths(node: MarkdownNode): string[] {
  const paths: string[] = [];

  function visit(current: MarkdownNode): void {
    if (current.type === "link" || current.type === "image") {
      const candidate = attachmentPath(current.url ?? "");
      if (candidate !== undefined && !paths.includes(candidate)) {
        paths.push(candidate);
      }
    }
    for (const child of current.children ?? []) {
      visit(child);
    }
  }

  visit(node);
  return paths;
}

export function isSafeDocumentUrl(value: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (
    [...decoded].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return false;
  }
  try {
    const base = new URL("https://indexary.invalid/");
    const url = new URL(decoded, base);
    return (
      url.origin === base.origin ||
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

function makeText(value: string): MarkdownNode {
  return { type: "text", value };
}

function safeSnippet(value: string, focus: string): string {
  const normalized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  const normalizedFocus = focus.replace(/\s+/g, " ");
  const focusIndex = normalized.indexOf(normalizedFocus);
  const desiredStart = focusIndex === -1 ? 0 : focusIndex - 70;
  const start = Math.max(0, Math.min(desiredStart, normalized.length - 178));
  const end = Math.min(normalized.length, start + 178);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end).trim()}${
    end < normalized.length ? "…" : ""
  }`;
}

function unresolvedWikilink(
  label: string,
  state: Exclude<WikilinkState, "resolved">,
): MarkdownNode {
  const status = state === "missing" ? "не найдено" : "неоднозначно";
  return {
    type: "emphasis",
    data: {
      hName: "span",
      hProperties: {
        className: ["wikilink", `wikilink-${state}`],
      },
    },
    children: [makeText(label), makeText(` — ${status}`)],
  };
}

function interpretWikilinks(
  tree: MarkdownNode,
  documentPath: string,
  resolveWikilink: ResolveWikilink | undefined,
  diagnostics: DocumentDiagnostic[],
): OutgoingLink[] {
  const links: OutgoingLink[] = [];
  const wikilinkPattern = /\[\[([^\]\r\n]+)\]\]/g;

  function visit(node: MarkdownNode, inheritedSnippet = ""): void {
    if (node.children === undefined) {
      return;
    }
    const snippetSource = ["paragraph", "heading", "tableCell"].includes(
      node.type,
    )
      ? textContent(node)
      : inheritedSnippet;

    node.children = node.children.flatMap((child) => {
      if (
        child.type === "link" ||
        child.type === "inlineCode" ||
        child.type === "code"
      ) {
        return [child];
      }
      if (child.type !== "text" || child.value === undefined) {
        visit(child, snippetSource);
        return [child];
      }

      const replacements: MarkdownNode[] = [];
      let start = 0;
      for (const match of child.value.matchAll(wikilinkPattern)) {
        const index = match.index;
        if (index > start) {
          replacements.push(makeText(child.value.slice(start, index)));
        }
        const expression = match[1] ?? "";
        const separator = expression.indexOf("|");
        const target = (
          separator === -1 ? expression : expression.slice(0, separator)
        ).trim();
        const alias =
          separator === -1 ? "" : expression.slice(separator + 1).trim();
        const label = alias || target || "Вики-ссылка";
        const resolution = resolveWikilink?.(documentPath, target) ?? {
          state: "missing" as const,
        };
        const link: OutgoingLink = {
          target,
          label,
          state: resolution.state,
          ...(resolution.path === undefined ? {} : { path: resolution.path }),
          snippet: safeSnippet(snippetSource || child.value, match[0]),
        };
        links.push(link);

        if (resolution.state === "resolved" && resolution.path !== undefined) {
          replacements.push({
            type: "link",
            url: documentRoute(resolution.path),
            data: {
              hProperties: { className: ["wikilink", "wikilink-resolved"] },
            },
            children: [makeText(label)],
          });
        } else {
          addDiagnostic(
            diagnostics,
            resolution.state === "ambiguous"
              ? "WIKILINK_AMBIGUOUS"
              : "WIKILINK_MISSING",
          );
          replacements.push(
            unresolvedWikilink(
              label,
              resolution.state === "ambiguous" ? "ambiguous" : "missing",
            ),
          );
        }
        start = index + match[0].length;
      }
      if (start === 0) {
        return [child];
      }
      if (start < child.value.length) {
        replacements.push(makeText(child.value.slice(start)));
      }
      return replacements;
    });
  }

  visit(tree);
  return links;
}

function secureMarkdown(
  node: MarkdownNode,
  diagnostics: DocumentDiagnostic[],
): void {
  if (node.children === undefined) {
    return;
  }

  node.children = node.children.flatMap((child) => {
    if (child.type === "html") {
      addDiagnostic(diagnostics, "RAW_HTML_REMOVED");
      return [];
    }
    if (child.type === "link") {
      secureMarkdown(child, diagnostics);
      if (!isSafeDocumentUrl(child.url ?? "")) {
        addDiagnostic(diagnostics, "UNSAFE_URL_REMOVED");
        return child.children ?? [];
      }
      return [child];
    }
    if (child.type === "image") {
      const label = child.alt?.trim() || "Изображение";
      if (!isSafeDocumentUrl(child.url ?? "")) {
        addDiagnostic(diagnostics, "UNSAFE_URL_REMOVED");
        return [makeText(label)];
      }
      return [
        {
          type: "link",
          url: child.url,
          children: [makeText(label)],
        },
      ];
    }
    secureMarkdown(child, diagnostics);
    return [child];
  });
}

function filenameTitle(documentPath: string): string {
  const filename = documentPath.split("/").at(-1) ?? documentPath;
  return filename.replace(/\.md$/i, "") || "Документ";
}

function normalizeSearchableText(values: readonly string[]): string {
  return values.join(" ").replace(/\s+/g, " ").trim();
}

export async function interpretDocument<DocumentPath extends string>(
  documentPath: DocumentPath,
  markdown: string,
  options: InterpretDocumentOptions = {},
): Promise<DocumentRepresentation<DocumentPath>> {
  const diagnostics: DocumentDiagnostic[] = [];
  const separated = splitFrontmatter(markdown);
  const metadata = parseFrontmatter(
    separated.frontmatter,
    separated.unterminated,
    diagnostics,
  );
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(separated.body) as MarkdownNode;

  const firstHeadingIndex = (tree.children ?? []).findIndex(
    (node) => node.type === "heading" && node.depth === 1,
  );
  const firstHeading =
    firstHeadingIndex === -1 ? undefined : tree.children?.[firstHeadingIndex];
  const headingTitle =
    firstHeading && textContent(firstHeading).replace(/\s+/g, " ").trim();

  const configuredTitle = metadata.get("title");
  let title: string | undefined;
  if (configuredTitle !== undefined) {
    if (typeof configuredTitle === "string" && configuredTitle.trim() !== "") {
      title = configuredTitle.trim();
    } else {
      addDiagnostic(diagnostics, "TITLE_INVALID");
    }
  }
  if (title === undefined && headingTitle) {
    title = headingTitle;
    tree.children?.splice(firstHeadingIndex, 1);
  }
  title ??= filenameTitle(documentPath);

  const tags = metadata.has("tags")
    ? parseStringList(metadata.get("tags"), diagnostics, "TAGS_INVALID")
    : [];
  const sourceMaterials = metadata.has("originals")
    ? parseStringList(
        metadata.get("originals"),
        diagnostics,
        "ORIGINALS_INVALID",
      )
    : [];
  if (metadata.has("original_path")) {
    const legacyPath = metadata.get("original_path");
    if (typeof legacyPath === "string" && legacyPath.trim() !== "") {
      if (!sourceMaterials.includes(legacyPath.trim())) {
        sourceMaterials.push(legacyPath.trim());
      }
    } else {
      addDiagnostic(diagnostics, "ORIGINAL_PATH_INVALID");
    }
  }

  const properties: DocumentProperty[] = [];
  for (const [name, value] of metadata) {
    const readable = readableValue(value);
    if (readable === undefined) {
      addDiagnostic(diagnostics, "PROPERTY_INVALID");
      continue;
    }
    properties.push({ name, value: readable });
  }

  const outgoingLinks = interpretWikilinks(
    tree,
    documentPath,
    options.resolveWikilink,
    diagnostics,
  );
  const bodyText = textContent(tree);
  const attachmentPaths = collectAttachmentPaths(tree);
  secureMarkdown(tree, diagnostics);
  const renderer = unified()
    .use(remarkRehype)
    .use(rehypeSanitize, documentSanitizeSchema)
    .use(rehypeStringify);
  const renderedTree = await renderer.run(tree as never);
  const html = renderer.stringify(renderedTree);
  const searchableText = normalizeSearchableText([
    title,
    ...tags,
    ...properties.map((property) => property.value),
    bodyText,
  ]);

  return {
    path: documentPath,
    title,
    html,
    searchableText,
    tags,
    sourceMaterials,
    attachmentPaths,
    properties,
    diagnostics,
    outgoingLinks,
    backlinks: [],
  };
}

export function unreadableDocument<DocumentPath extends string>(
  documentPath: DocumentPath,
): DocumentRepresentation<DocumentPath> {
  return {
    path: documentPath,
    title: filenameTitle(documentPath),
    html: "",
    searchableText: filenameTitle(documentPath),
    tags: [],
    sourceMaterials: [],
    attachmentPaths: [],
    properties: [],
    outgoingLinks: [],
    backlinks: [],
    diagnostics: [
      {
        code: "DOCUMENT_UNREADABLE",
        message: diagnosticMessages.DOCUMENT_UNREADABLE,
      },
    ],
  };
}
