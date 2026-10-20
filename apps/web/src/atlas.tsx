import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderClosed,
  Menu,
  Link2,
  Home,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import {
  documentRoute,
  fetchCatalog,
  fetchDocument,
  fetchSearch,
  folderRoute,
  isMissingRequest,
  type DocumentRepresentation,
  type MaterialReference,
} from "./api";
import { Button } from "./components/ui/button";
import { Modal } from "./components/ui/modal";
import { MaterialViewer } from "./components/material-viewer";
import { ru } from "./i18n/ru";

export type AtlasSelection =
  | { kind: "document"; path: string; root?: boolean }
  | { kind: "folder"; path: string };

interface SearchCriteria {
  query: string;
  tag?: string;
}

type Overlay =
  | { kind: "navigation" }
  | { kind: "search" }
  | {
      kind: "files";
      documentPath: string;
      initialMaterial?: MaterialReference;
    };

function savedSearch(): SearchCriteria {
  try {
    const value = JSON.parse(
      sessionStorage.getItem("indexary:search") ?? "null",
    ) as SearchCriteria | null;
    if (
      value &&
      typeof value.query === "string" &&
      (value.tag === undefined || typeof value.tag === "string")
    )
      return { query: value.query, tag: value.tag };
  } catch {
    /* Browser storage is optional. */
  }
  return { query: "" };
}

function parentFolder(itemPath: string): string {
  const segments = itemPath.split("/");
  segments.pop();
  return segments.join("/");
}

function lastDocument(): string | undefined {
  try {
    const value = localStorage.getItem("indexary:last-document");
    if (
      value === null ||
      value === "index.md" ||
      value.startsWith("/") ||
      value.split("/").includes("..")
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function Navigation({
  selection,
  close,
  closeButtonRef,
  openSearch,
}: {
  selection: AtlasSelection;
  close?: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
  openSearch: () => void;
}) {
  const folderPath =
    selection.kind === "folder" ? selection.path : parentFolder(selection.path);
  const catalogQuery = useQuery({
    queryKey: ["catalog", folderPath],
    queryFn: () => fetchCatalog(folderPath),
    retry: false,
  });
  const [recent] = useState(lastDocument);
  const parent = parentFolder(folderPath);

  return (
    <nav className="navigation" aria-label={ru.knowledgeBase}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{ru.atlas}</p>
          <h2>{ru.knowledgeBase}</h2>
        </div>
        {close ? (
          <Button
            ref={closeButtonRef}
            className="icon-button"
            onClick={close}
            aria-label={ru.close}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="navigation-content">
        <button
          className="search-field"
          type="button"
          aria-keyshortcuts="Control+K Meta+K"
          onClick={() => openSearch()}
        >
          <Search aria-hidden="true" />
          <span>{ru.searchPlaceholder}</span>
        </button>

        <div className="tree-label">{ru.document}</div>
        <a
          className={`tree-item ${selection.kind === "document" && selection.root ? "active" : ""}`}
          href="/"
          aria-current={
            selection.kind === "document" && selection.root ? "page" : undefined
          }
          onClick={close}
        >
          <BookOpenText aria-hidden="true" />
          <span>{ru.home}</span>
        </a>
        {recent ? (
          <a
            className="tree-item recent-item"
            href={documentRoute(recent)}
            onClick={close}
          >
            <FileText aria-hidden="true" />
            <span>{ru.lastDocument}</span>
          </a>
        ) : null}

        <div className="tree-label folders-label">{ru.folderContents}</div>
        {folderPath !== "" ? (
          <a className="tree-item" href={folderRoute(parent)} onClick={close}>
            <ChevronLeft aria-hidden="true" />
            <span>{parent === "" ? ru.rootFolder : parent}</span>
          </a>
        ) : null}

        {catalogQuery.isPending ? (
          <p className="tree-status" role="status">
            {ru.loadingCatalog}
          </p>
        ) : catalogQuery.isError ? (
          <div className="tree-status" role="status">
            <p>
              {isMissingRequest(catalogQuery.error)
                ? ru.catalogUnavailable
                : ru.catalogServerError}
            </p>
            <Button onClick={() => void catalogQuery.refetch()}>
              {ru.retry}
            </Button>
          </div>
        ) : (
          <>
            <ul className="tree-list" aria-label={ru.folders}>
              {catalogQuery.data.folders.map((folder) => (
                <li key={folder.path}>
                  <a
                    className={`tree-item ${selection.kind === "folder" && selection.path === folder.path ? "active" : ""}`}
                    href={folderRoute(folder.path)}
                    onClick={close}
                  >
                    <FolderClosed aria-hidden="true" />
                    <span>{folder.name}</span>
                    <ChevronRight aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
            <ul className="tree-list" aria-label={ru.documents}>
              {catalogQuery.data.documents
                .filter((document) => document.path !== "index.md")
                .map((document) => {
                  const isHome = document.path === "index.md";
                  const active =
                    selection.kind === "document" &&
                    selection.path === document.path;
                  return (
                    <li key={document.path}>
                      <a
                        className={`tree-item ${active ? "active" : ""}`}
                        href={isHome ? "/" : documentRoute(document.path)}
                        aria-current={active ? "page" : undefined}
                        onClick={close}
                      >
                        <FileText aria-hidden="true" />
                        <span>{document.title}</span>
                      </a>
                    </li>
                  );
                })}
            </ul>
            {catalogQuery.data.folders.length === 0 &&
            catalogQuery.data.documents.length === 0 ? (
              <p className="tree-status">{ru.emptyFolder}</p>
            ) : null}
            {catalogQuery.data.diagnostics.length > 0 ? (
              <section
                className="catalog-diagnostics"
                aria-label={ru.catalogDiagnostics}
              >
                <AlertTriangle aria-hidden="true" />
                <p>
                  {ru.catalogWarnings(catalogQuery.data.diagnostics.length)}
                </p>
              </section>
            ) : null}
          </>
        )}
      </div>
    </nav>
  );
}

function SearchDialog({
  criteria,
  setCriteria,
  close,
  returnFocusRef,
}: {
  criteria: SearchCriteria;
  setCriteria: (criteria: SearchCriteria) => void;
  close: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const limitationsId = useId();
  const activeResultId = useId();
  const { query, tag } = criteria;
  const [activeIndex, setActiveIndex] = useState(0);
  const resultLinks = useRef<Array<HTMLAnchorElement | null>>([]);
  const hasCriteria = query.trim() !== "" || tag !== undefined;
  const searchQuery = useQuery({
    queryKey: ["search", query, tag],
    queryFn: () => fetchSearch(query, tag),
    enabled: hasCriteria,
    retry: false,
  });
  const results = searchQuery.data?.results ?? [];
  const activeResult = results[activeIndex];

  useEffect(() => {
    setActiveIndex(0);
  }, [query, tag]);

  useEffect(() => {
    resultLinks.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, results.length - 1)));
  }, [results.length]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (results.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        (current) => (current - 1 + results.length) % results.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      resultLinks.current[activeIndex]?.click();
    }
  }

  return (
    <Modal
      className="search-dialog"
      label={ru.search}
      initialFocusRef={inputRef}
      returnFocusRef={returnFocusRef}
      close={close}
    >
      <div className="search-heading">
        <div>
          <p className="eyebrow">{ru.knowledgeBase}</p>
          <h2 id="search-heading">{ru.search}</h2>
        </div>
        <Button className="icon-button" onClick={close} aria-label={ru.close}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <label className="search-dialog-field">
        <Search aria-hidden="true" />
        <span className="sr-only">{ru.searchPlaceholder}</span>
        <input
          ref={inputRef}
          type="search"
          placeholder={ru.searchPlaceholder}
          value={query}
          role="searchbox"
          aria-controls={resultsId}
          aria-describedby={`${limitationsId} ${activeResultId}`}
          onChange={(event) =>
            setCriteria({ ...criteria, query: event.target.value })
          }
          onKeyDown={handleKeyDown}
        />
        <kbd>{ru.searchShortcut}</kbd>
      </label>
      {tag === undefined ? null : (
        <div className="active-tag-filter">
          <span>{ru.tagFilter(tag)}</span>
          <button
            type="button"
            aria-label={ru.clearTagFilter}
            onClick={() => setCriteria({ query })}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      <div id={resultsId} className="search-results" aria-live="polite">
        {!hasCriteria ? (
          <p className="search-state" role="status">
            {ru.searchPrompt}
          </p>
        ) : searchQuery.isPending ? (
          <p className="search-state" role="status">
            {ru.searchLoading}
          </p>
        ) : searchQuery.isError ? (
          <div className="search-state" role="status">
            <p>{ru.searchFailed}</p>
            <Button onClick={() => void searchQuery.refetch()}>
              {ru.retry}
            </Button>
          </div>
        ) : results.length === 0 ? (
          <p className="search-state" role="status">
            {ru.searchEmpty}
          </p>
        ) : (
          <>
            <p className="search-count" role="status">
              {ru.searchCount(results.length)}
            </p>
            <ul className="search-result-list">
              {results.map((result, index) => (
                <li key={result.path}>
                  <a
                    ref={(element) => {
                      resultLinks.current[index] = element;
                    }}
                    className={index === activeIndex ? "active" : ""}
                    href={
                      result.path === "index.md"
                        ? "/"
                        : documentRoute(result.path)
                    }
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={close}
                  >
                    <strong>{result.title}</strong>
                    <small>/{result.path}</small>
                    <p className="search-snippet">
                      {result.snippet.map((part, partIndex) =>
                        part.highlighted ? (
                          <mark key={partIndex}>{part.text}</mark>
                        ) : (
                          <span key={partIndex}>{part.text}</span>
                        ),
                      )}
                    </p>
                    {result.tags.length === 0 ? null : (
                      <span className="search-result-tags">
                        {result.tags.join(" · ")}
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <p id={activeResultId} className="sr-only" aria-live="polite">
        {activeResult
          ? ru.activeSearchResult(
              activeIndex + 1,
              results.length,
              activeResult.title,
            )
          : ""}
      </p>
      <p id={limitationsId} className="search-limitations">
        {ru.searchLimitations}
      </p>
    </Modal>
  );
}

function DocumentContext({
  representation,
}: {
  representation: DocumentRepresentation;
}) {
  if (
    representation.outgoingLinks.length + representation.backlinks.length ===
    0
  )
    return null;
  return (
    <section
      id="document-relationships"
      className="document-context"
      aria-label={ru.context}
    >
      <h2>{ru.relatedDocuments}</h2>
      <section className="relationships" aria-labelledby="links-heading">
        <h3 id="links-heading">{ru.outgoingLinks}</h3>
        {representation.outgoingLinks.length === 0 ? (
          <p>{ru.noOutgoingLinks}</p>
        ) : (
          <ul aria-label={ru.outgoingLinks}>
            {representation.outgoingLinks.map((link, index) => (
              <li key={`${link.target}-${index}`}>
                {link.state === "resolved" && link.path ? (
                  <a href={documentRoute(link.path)}>{link.label}</a>
                ) : (
                  <span className={`relationship-${link.state}`}>
                    {link.label}
                  </span>
                )}
                <small>{ru.wikilinkState[link.state]}</small>
                <p>{link.snippet}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="relationships" aria-labelledby="backlinks-heading">
        <h3 id="backlinks-heading">{ru.backlinks}</h3>
        {representation.backlinks.length === 0 ? (
          <p>{ru.noBacklinks}</p>
        ) : (
          <ul aria-label={ru.backlinks}>
            {representation.backlinks.map((backlink, index) => (
              <li key={`${backlink.path}-${index}`}>
                <a href={documentRoute(backlink.path)}>{backlink.title}</a>
                <p>{backlink.snippet}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function DocumentProperties({
  representation,
}: {
  representation: DocumentRepresentation;
}) {
  return (
    <details className="document-properties">
      <summary>{ru.details}</summary>
      <div className="properties">
        <h2>{ru.properties}</h2>
        <dl>
          <div>
            <dt>{ru.documentPath}</dt>
            <dd>/{representation.path}</dd>
          </div>
          {representation.properties.map((property) => (
            <div key={property.name}>
              <dt>{property.name}</dt>
              <dd>{property.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}

function DocumentView({
  selection,
  openSearch,
  openFiles,
}: {
  selection: Extract<AtlasSelection, { kind: "document" }>;
  openSearch: (tag: string) => void;
  openFiles: (
    documentPath: string,
    initialMaterial?: MaterialReference,
  ) => void;
}) {
  const documentPath = selection.path;
  const viewRef = useRef<HTMLElement>(null);
  const focusedControl = useRef<
    { kind: "link" | "button"; value: string } | undefined
  >(undefined);
  const documentQuery = useQuery({
    queryKey: ["document", documentPath],
    queryFn: () => fetchDocument(documentPath),
    retry: false,
  });

  useLayoutEffect(() => {
    const container = viewRef.current;
    const identity = focusedControl.current;
    if (
      container === null ||
      identity === undefined ||
      container.contains(document.activeElement) ||
      document.activeElement !== document.body
    ) {
      return;
    }

    const selector = identity.kind === "link" ? "a[href]" : "button";
    const replacement = Array.from(
      container.querySelectorAll<HTMLElement>(selector),
    ).find((element) =>
      identity.kind === "link"
        ? element.getAttribute("href") === identity.value
        : element.textContent?.trim() === identity.value,
    );
    (replacement ?? container).focus();
  }, [documentQuery.data?.revision, documentQuery.isError]);

  function rememberFocusedControl(event: FocusEvent<HTMLElement>) {
    const target = event.target;
    if (target instanceof HTMLAnchorElement) {
      focusedControl.current = {
        kind: "link",
        value: target.getAttribute("href") ?? "",
      };
    } else if (target instanceof HTMLButtonElement) {
      focusedControl.current = {
        kind: "button",
        value: target.textContent?.trim() ?? "",
      };
    } else {
      focusedControl.current = undefined;
    }
  }

  function forgetFocusedControl(event: FocusEvent<HTMLElement>) {
    if (
      event.relatedTarget instanceof Node &&
      !event.currentTarget.contains(event.relatedTarget)
    ) {
      focusedControl.current = undefined;
    }
  }

  useEffect(() => {
    if (documentQuery.data && documentQuery.data.path !== "index.md") {
      try {
        localStorage.setItem("indexary:last-document", documentQuery.data.path);
      } catch {
        // A disabled browser store must not prevent browsing.
      }
    }
  }, [documentQuery.data]);

  if (documentQuery.isPending) {
    return (
      <div className="document-state" role="status">
        {ru.loading}
      </div>
    );
  }

  if (documentQuery.isError) {
    const missing = isMissingRequest(documentQuery.error);
    return (
      <div
        ref={viewRef as RefObject<HTMLDivElement | null>}
        className="document-state error-state"
        role="status"
        tabIndex={-1}
      >
        <FileText aria-hidden="true" />
        <h1>
          {missing
            ? selection.root
              ? ru.unavailableTitle
              : ru.documentUnavailableTitle
            : ru.serverUnavailableTitle}
        </h1>
        <p>
          {missing
            ? selection.root
              ? ru.unavailableBody
              : ru.documentUnavailableBody
            : ru.serverUnavailableBody}
        </p>
        <Button onClick={() => void documentQuery.refetch()}>{ru.retry}</Button>
      </div>
    );
  }

  const representation = documentQuery.data;
  const files = [
    ...representation.materials.sourceMaterials,
    ...representation.materials.attachments,
  ];
  const sources = representation.materials.sourceMaterials;
  const folder = parentFolder(representation.path);
  const folders = folder ? folder.split("/") : [];

  return (
    <article
      ref={viewRef as RefObject<HTMLElement | null>}
      className="document"
      tabIndex={-1}
      onFocusCapture={rememberFocusedControl}
      onBlurCapture={forgetFocusedControl}
    >
      <nav className="document-kicker" aria-label={ru.documentPath}>
        <a href={folderRoute("")}>{ru.knowledgeBase}</a>
        {folders.map((name, index) => (
          <span key={folders.slice(0, index + 1).join("/")}>
            <ChevronRight aria-hidden="true" />
            <a href={folderRoute(folders.slice(0, index + 1).join("/"))}>
              {name}
            </a>
          </span>
        ))}
      </nav>
      <h1>{documentQuery.data.title}</h1>
      {documentQuery.data.tags.length > 0 ? (
        <ul className="document-tags" aria-label={ru.tags}>
          {documentQuery.data.tags.map((tag) => (
            <li key={tag}>
              <button type="button" onClick={() => openSearch(tag)}>
                {tag}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="document-actions">
        {sources.length > 0 && (
          <Button
            onClick={() =>
              openFiles(
                representation.path,
                sources.length === 1 ? sources[0] : undefined,
              )
            }
          >
            <BookOpenText aria-hidden="true" />
            {sources.length === 1
              ? ru.openOriginal
              : `${ru.sources} · ${sources.length}`}
          </Button>
        )}
        {files.length > 0 && (
          <Button
            className="secondary-button"
            onClick={() =>
              openFiles(
                representation.path,
                files.length === 1 ? files[0] : undefined,
              )
            }
          >
            <FileText aria-hidden="true" />
            {ru.allFiles} · {files.length}
          </Button>
        )}
        {representation.outgoingLinks.length + representation.backlinks.length >
          0 && (
          <a
            className="relationship-shortcut"
            href="#document-relationships"
            aria-label={ru.showRelationships}
          >
            <Link2 aria-hidden="true" />
            {ru.relatedDocuments}
          </a>
        )}
        <DocumentProperties representation={representation} />
      </div>
      {documentQuery.data.diagnostics.length > 0 ? (
        <section
          className="document-diagnostics"
          aria-label={ru.diagnostics}
          role="status"
        >
          <strong>{ru.degradedDocument}</strong>
          {documentQuery.data.diagnostics.map((diagnostic) => (
            <p key={diagnostic.code}>{diagnostic.message}</p>
          ))}
        </section>
      ) : null}
      <div
        className="document-body"
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
            "a[href]",
          );
          if (!link) return;
          const url = new URL(link.href, window.location.href);
          if (
            url.origin !== window.location.origin ||
            url.pathname !== "/api/materials" ||
            url.searchParams.get("document") !== representation.path
          )
            return;
          const material = files.find(
            (file) => file.id === url.searchParams.get("id"),
          );
          if (material) {
            event.preventDefault();
            openFiles(representation.path, material);
          }
        }}
        dangerouslySetInnerHTML={{ __html: representation.html }}
      />
      <DocumentContext representation={representation} />
    </article>
  );
}

function FolderView({ folderPath }: { folderPath: string }) {
  const catalogQuery = useQuery({
    queryKey: ["catalog", folderPath],
    queryFn: () => fetchCatalog(folderPath),
    retry: false,
  });

  if (catalogQuery.isPending) {
    return (
      <div className="document-state" role="status">
        {ru.loadingCatalog}
      </div>
    );
  }
  if (catalogQuery.isError) {
    const missing = isMissingRequest(catalogQuery.error);
    return (
      <div className="document-state error-state" role="status">
        <FolderClosed aria-hidden="true" />
        <h1>
          {missing ? ru.folderUnavailableTitle : ru.serverUnavailableTitle}
        </h1>
        <p>{missing ? ru.folderUnavailableBody : ru.serverUnavailableBody}</p>
        <Button onClick={() => void catalogQuery.refetch()}>{ru.retry}</Button>
      </div>
    );
  }

  return (
    <section className="folder-view" aria-labelledby="folder-heading">
      <div className="document-kicker">
        /{catalogQuery.data.path || ru.rootFolder}
      </div>
      <h1 id="folder-heading">{catalogQuery.data.name}</h1>
      <p>{ru.folderIntroduction}</p>
      {catalogQuery.data.diagnostics.length > 0 && (
        <section
          className="catalog-diagnostics"
          aria-label={ru.catalogDiagnostics}
        >
          <AlertTriangle aria-hidden="true" />
          <p>{ru.catalogWarnings(catalogQuery.data.diagnostics.length)}</p>
        </section>
      )}
      <ul className="folder-entries" aria-label={ru.folderContents}>
        {catalogQuery.data.folders.map((folder) => (
          <li key={folder.path}>
            <a href={folderRoute(folder.path)}>
              <FolderClosed aria-hidden="true" />
              <span>{folder.name}</span>
              <ChevronRight aria-hidden="true" />
            </a>
          </li>
        ))}
        {catalogQuery.data.documents.map((document) => (
          <li key={document.path}>
            <a
              href={
                document.path === "index.md"
                  ? "/"
                  : documentRoute(document.path)
              }
            >
              <FileText aria-hidden="true" />
              <span>{document.title}</span>
            </a>
          </li>
        ))}
      </ul>
      {catalogQuery.data.folders.length === 0 &&
      catalogQuery.data.documents.length === 0 ? (
        <p className="empty-folder">{ru.emptyFolder}</p>
      ) : null}
    </section>
  );
}

export function Atlas({
  selection = { kind: "document", path: "index.md", root: true },
}: {
  selection?: AtlasSelection;
}) {
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [criteria, setCriteria] = useState<SearchCriteria>(savedSearch);
  const returnFocusRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  const openOverlay = useCallback((next: Overlay) => {
    if (document.activeElement instanceof HTMLElement)
      returnFocusRef.current = document.activeElement;
    setOverlay(next);
  }, []);
  const openSearch = useCallback(
    (tag?: string) => {
      // Closing navigation first restores a visible opener when search closes.
      if (overlay?.kind !== "navigation") {
        if (document.activeElement instanceof HTMLElement)
          returnFocusRef.current = document.activeElement;
      }
      if (tag !== undefined) setCriteria({ query: "", tag });
      setOverlay({ kind: "search" });
    },
    [overlay?.kind],
  );
  const openFiles = useCallback(
    (documentPath: string, initialMaterial?: MaterialReference) =>
      openOverlay({ kind: "files", documentPath, initialMaterial }),
    [openOverlay],
  );

  useEffect(() => {
    closeOverlay();
  }, [selection.kind, selection.path, closeOverlay]);

  useEffect(() => {
    try {
      sessionStorage.setItem("indexary:search", JSON.stringify(criteria));
    } catch {
      /* Browser storage is optional. */
    }
  }, [criteria]);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        // Do not replace a file modal while focus is inside its embedded viewer.
        if (overlay?.kind !== "files") openSearch();
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [openSearch, overlay?.kind]);

  return (
    <div className="app-shell">
      <div
        className="application-content"
        aria-hidden={overlay ? "true" : undefined}
        inert={overlay ? true : undefined}
      >
        <a className="skip-link" href="#document-content">
          {ru.skipToDocument}
        </a>
        <header className="topbar">
          <Button
            className="icon-button"
            aria-label={ru.openNavigation}
            aria-haspopup="dialog"
            aria-expanded={overlay?.kind === "navigation"}
            onClick={() => openOverlay({ kind: "navigation" })}
          >
            <Menu aria-hidden="true" />
          </Button>
          <a className="brand" href="/">
            <span className="brand-mark">{ru.productMark}</span>
            <strong>{ru.productName}</strong>
          </a>
          <a className="home-link" href="/" aria-label={ru.home}>
            <Home aria-hidden="true" />
            <span>{ru.home}</span>
          </a>
          <button
            className="global-search"
            type="button"
            aria-label={ru.searchPlaceholder}
            aria-keyshortcuts="Control+K Meta+K"
            onClick={() => openSearch()}
          >
            <Search aria-hidden="true" />
            <span className="search-desktop-label">{ru.searchPlaceholder}</span>
            <span className="search-compact-label">{ru.searchAction}</span>
            <kbd>{ru.searchShortcut}</kbd>
          </button>
        </header>
        <main id="document-content" className="document-column" tabIndex={-1}>
          {selection.kind === "folder" ? (
            <FolderView folderPath={selection.path} />
          ) : (
            <DocumentView
              selection={selection}
              openSearch={openSearch}
              openFiles={openFiles}
            />
          )}
        </main>
      </div>
      {overlay?.kind === "navigation" && (
        <Modal
          className="navigation-dialog"
          label={ru.navigationDialog}
          initialFocusRef={closeButtonRef}
          returnFocusRef={returnFocusRef}
          close={closeOverlay}
        >
          <Navigation
            selection={selection}
            close={closeOverlay}
            closeButtonRef={closeButtonRef}
            openSearch={() => openSearch()}
          />
        </Modal>
      )}
      {overlay?.kind === "search" && (
        <SearchDialog
          criteria={criteria}
          setCriteria={setCriteria}
          close={closeOverlay}
          returnFocusRef={returnFocusRef}
        />
      )}
      {overlay?.kind === "files" && (
        <MaterialViewer
          documentPath={overlay.documentPath}
          initialMaterial={overlay.initialMaterial}
          close={closeOverlay}
          returnFocusRef={returnFocusRef}
        />
      )}
    </div>
  );
}
