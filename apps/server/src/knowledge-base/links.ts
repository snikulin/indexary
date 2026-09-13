import path from "node:path";

export type WikilinkState = "resolved" | "missing" | "ambiguous";

export type WikilinkResolution =
  | {
      state: "resolved";
      targetKind: "document" | "material";
      path: string;
    }
  | { state: Exclude<WikilinkState, "resolved"> };

export type ResolveWikilink = (
  sourcePath: string,
  target: string,
) => WikilinkResolution;

function markdownPath(target: string): string {
  return target.toLowerCase().endsWith(".md") ? target : `${target}.md`;
}

function safeTarget(target: string): string | undefined {
  const value = target.trim().split("#", 1)[0]?.trim() ?? "";
  if (
    value === "" ||
    value.startsWith("//") ||
    value.includes("\0") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return undefined;
  }

  const withoutRootMarker = value.startsWith("/") ? value.slice(1) : value;
  const normalized = path.posix.normalize(withoutRootMarker);
  if (normalized === ".") {
    return undefined;
  }
  return normalized;
}

interface PathIndex {
  paths: Set<string>;
  pathsByFilename: Map<string, string[]>;
}

function createPathIndex(paths: readonly string[]): PathIndex {
  const indexedPaths = new Set(paths);
  const pathsByFilename = new Map<string, string[]>();
  for (const indexedPath of [...indexedPaths].sort((left, right) =>
    left.localeCompare(right, "en"),
  )) {
    const filename = path.posix.basename(indexedPath);
    const candidates = pathsByFilename.get(filename) ?? [];
    candidates.push(indexedPath);
    pathsByFilename.set(filename, candidates);
  }
  return { paths: indexedPaths, pathsByFilename };
}

function exactPath(
  index: PathIndex,
  sourcePath: string,
  target: string,
  rooted: boolean,
): string | undefined {
  if (!rooted) {
    const relative = path.posix.normalize(
      path.posix.join(path.posix.dirname(sourcePath), target),
    );
    if (
      relative !== ".." &&
      !relative.startsWith("../") &&
      index.paths.has(relative)
    ) {
      return relative;
    }
  }
  const leavesRoot = target === ".." || target.startsWith("../");
  return !leavesRoot && index.paths.has(target) ? target : undefined;
}

type FilenameLookup =
  | { state: "unique"; path: string }
  | { state: "ambiguous" }
  | { state: "missing" };

function filenamePath(index: PathIndex, target: string): FilenameLookup {
  const candidates = index.pathsByFilename.get(path.posix.basename(target));
  if (candidates?.length === 1) {
    return { state: "unique", path: candidates[0]! };
  }
  return { state: candidates === undefined ? "missing" : "ambiguous" };
}

/**
 * Build a resolver from the complete discovered Document and Material sets.
 * Resolution never consults filesystem order: exact paths win, while filename
 * fallback succeeds only when its candidate is unique.
 */
export function createWikilinkResolver(
  documentPaths: readonly string[],
  materialPaths: readonly string[] = [],
): ResolveWikilink {
  const documents = createPathIndex(documentPaths);
  const materials = createPathIndex(materialPaths);

  return (sourcePath, target) => {
    const normalizedTarget = safeTarget(target);
    if (normalizedTarget === undefined) {
      return { state: "missing" };
    }

    const rooted = target.trim().startsWith("/");
    const external = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target.trim());
    const leavesRoot =
      normalizedTarget === ".." || normalizedTarget.startsWith("../");
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target.trim())) {
      return { state: "missing" };
    }

    const exactMaterial = external
      ? undefined
      : exactPath(materials, sourcePath, normalizedTarget, rooted);
    if (exactMaterial !== undefined) {
      return {
        state: "resolved",
        targetKind: "material",
        path: exactMaterial,
      };
    }
    const normalizedDocumentTarget = markdownPath(normalizedTarget);
    const exactDocument = exactPath(
      documents,
      sourcePath,
      normalizedDocumentTarget,
      rooted,
    );
    if (exactDocument !== undefined) {
      return {
        state: "resolved",
        targetKind: "document",
        path: exactDocument,
      };
    }

    if (external || leavesRoot) {
      return { state: "missing" };
    }

    const materialByFilename = filenamePath(materials, normalizedTarget);
    if (materialByFilename.state === "ambiguous") {
      return { state: "ambiguous" };
    }
    if (materialByFilename.state === "unique") {
      return {
        state: "resolved",
        targetKind: "material",
        path: materialByFilename.path,
      };
    }
    const documentByFilename = filenamePath(
      documents,
      normalizedDocumentTarget,
    );
    if (documentByFilename.state === "ambiguous") {
      return { state: "ambiguous" };
    }
    if (documentByFilename.state === "unique") {
      return {
        state: "resolved",
        targetKind: "document",
        path: documentByFilename.path,
      };
    }
    return { state: "missing" };
  };
}

export function documentRoute(documentPath: string): string {
  return `/documents/${documentPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function materialRoute(
  documentPath: string,
  materialId: string,
): string {
  const parameters = new URLSearchParams({
    document: documentPath,
    id: materialId,
  });
  return `/api/materials?${parameters}`;
}
