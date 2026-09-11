import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  interpretDocument,
  type DocumentRepresentation,
  unreadableDocument,
} from "./document.js";

const HOME_DOCUMENT_PATH = "index.md";

export type KnowledgeBaseStatus =
  | { state: "initializing" }
  | { state: "ready" }
  | { state: "home-document-unavailable" };

export interface KnowledgeBase {
  initialize(): Promise<void>;
  status(): KnowledgeBaseStatus;
  openHomeDocument(): Promise<
    DocumentRepresentation<typeof HOME_DOCUMENT_PATH> | undefined
  >;
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

export function createKnowledgeBase(configuredRoot: string): KnowledgeBase {
  let canonicalRoot: string | undefined;
  let homeDocument:
    DocumentRepresentation<typeof HOME_DOCUMENT_PATH> | undefined;
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

      try {
        homeDocument = await interpretDocument(
          HOME_DOCUMENT_PATH,
          await readFile(canonicalCandidate, "utf8"),
        );
      } catch {
        homeDocument = unreadableDocument(HOME_DOCUMENT_PATH);
      }
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
