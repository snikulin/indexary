import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

export interface TreeEntry {
  path: string;
  mode: number;
  kind: "directory" | "file" | "link" | "other";
  content?: Buffer;
  target?: string;
}

export async function captureTree(root: string): Promise<TreeEntry[]> {
  const snapshot: TreeEntry[] = [];

  async function visit(
    directory: string,
    relativeDirectory = "",
  ): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const metadata = await lstat(absolutePath);

      if (entry.isDirectory()) {
        snapshot.push({
          path: relativePath,
          mode: metadata.mode,
          kind: "directory",
        });
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        snapshot.push({
          path: relativePath,
          mode: metadata.mode,
          kind: "file",
          content: await readFile(absolutePath),
        });
      } else if (entry.isSymbolicLink()) {
        snapshot.push({
          path: relativePath,
          mode: metadata.mode,
          kind: "link",
          target: await readlink(absolutePath),
        });
      } else {
        snapshot.push({
          path: relativePath,
          mode: metadata.mode,
          kind: "other",
        });
      }
    }
  }

  await visit(root);
  return snapshot;
}
