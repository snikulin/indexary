import path from "node:path";

export type WikilinkState = "resolved" | "missing" | "ambiguous";

export interface WikilinkResolution {
  state: WikilinkState;
  path?: string;
}

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
    value.includes("\0") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    }) ||
    /^[a-zA-Z]:/.test(value)
  ) {
    return undefined;
  }

  const withoutRootMarker = value.startsWith("/") ? value.slice(1) : value;
  const normalized = path.posix.normalize(withoutRootMarker);
  if (normalized === ".") {
    return undefined;
  }
  return markdownPath(normalized);
}

/**
 * Build a resolver from the complete discovered Document set. Resolution never
 * consults filesystem order: exact paths win, while filename fallback succeeds
 * only when its candidate is unique.
 */
export function createWikilinkResolver(
  documentPaths: readonly string[],
): ResolveWikilink {
  const paths = new Set(documentPaths);
  const pathsByFilename = new Map<string, string[]>();

  for (const documentPath of [...paths].sort((left, right) =>
    left.localeCompare(right, "en"),
  )) {
    const filename = path.posix.basename(documentPath);
    const candidates = pathsByFilename.get(filename) ?? [];
    candidates.push(documentPath);
    pathsByFilename.set(filename, candidates);
  }

  return (sourcePath, target) => {
    const normalizedTarget = safeTarget(target);
    if (normalizedTarget === undefined) {
      return { state: "missing" };
    }

    if (!target.trim().startsWith("/")) {
      const relativeCandidate = path.posix.normalize(
        path.posix.join(path.posix.dirname(sourcePath), normalizedTarget),
      );
      if (
        relativeCandidate !== ".." &&
        !relativeCandidate.startsWith("../") &&
        paths.has(relativeCandidate)
      ) {
        return { state: "resolved", path: relativeCandidate };
      }
    }

    const leavesRoot =
      normalizedTarget === ".." || normalizedTarget.startsWith("../");
    if (!leavesRoot && paths.has(normalizedTarget)) {
      return { state: "resolved", path: normalizedTarget };
    }

    if (leavesRoot || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target.trim())) {
      return { state: "missing" };
    }
    const candidates = pathsByFilename.get(
      path.posix.basename(normalizedTarget),
    );
    if (candidates?.length === 1) {
      return { state: "resolved", path: candidates[0] };
    }
    return { state: candidates === undefined ? "missing" : "ambiguous" };
  };
}

export function documentRoute(documentPath: string): string {
  return `/documents/${documentPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}
