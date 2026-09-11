import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderClosed,
  Menu,
  PanelRightOpen,
  Search,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  documentRoute,
  fetchCatalog,
  fetchDocument,
  fetchSearch,
  folderRoute,
} from "./api";
import { Button } from "./components/ui/button";
import { ru } from "./i18n/ru";

export type AtlasSelection =
  | { kind: "document"; path: string; root?: boolean }
  | { kind: "folder"; path: string };

interface DrawerState {
  navigation: boolean;
  context: boolean;
}

const contextSections = [
  ru.sources,
  ru.outgoingLinks,
  ru.backlinks,
  ru.attachments,
  ru.properties,
] as const;

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
  openSearch,
}: {
  selection: AtlasSelection;
  close?: () => void;
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
          <Button className="icon-button" onClick={close} aria-label={ru.close}>
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <label className="search-field">
        <Search aria-hidden="true" />
        <span className="sr-only">{ru.searchPlaceholder}</span>
        <input
          type="search"
          placeholder={ru.searchPlaceholder}
          value=""
          readOnly
          aria-keyshortcuts="Control+K Meta+K"
          onFocus={openSearch}
          onClick={openSearch}
        />
      </label>

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
        <a className="tree-item recent-item" href={documentRoute(recent)}>
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
        <p className="tree-status">{ru.loadingCatalog}</p>
      ) : catalogQuery.isError ? (
        <p className="tree-status">{ru.catalogUnavailable}</p>
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
            {catalogQuery.data.documents.map((document) => {
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
              <p>{ru.catalogWarnings(catalogQuery.data.diagnostics.length)}</p>
            </section>
          ) : null}
        </>
      )}
    </nav>
  );
}

function SearchDialog({
  initialTag,
  close,
}: {
  initialTag?: string;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState(initialTag);
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

  useEffect(() => {
    setActiveIndex(0);
  }, [query, tag]);

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
    <div className="search-layer">
      <button
        className="search-backdrop"
        type="button"
        aria-label={ru.closeSearch}
        onClick={close}
      />
      <section
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-heading"
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
            type="search"
            placeholder={ru.searchPlaceholder}
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd>⌘/Ctrl K</kbd>
        </label>
        {tag === undefined ? null : (
          <div className="active-tag-filter">
            <span>{ru.tagFilter(tag)}</span>
            <button
              type="button"
              aria-label={ru.clearTagFilter}
              onClick={() => setTag(undefined)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="search-results" aria-live="polite">
          {!hasCriteria ? (
            <p className="search-state">{ru.searchPrompt}</p>
          ) : searchQuery.isPending ? (
            <p className="search-state">{ru.searchLoading}</p>
          ) : searchQuery.isError ? (
            <div className="search-state" role="status">
              <p>{ru.searchFailed}</p>
              <Button onClick={() => void searchQuery.refetch()}>
                {ru.retry}
              </Button>
            </div>
          ) : results.length === 0 ? (
            <p className="search-state">{ru.searchEmpty}</p>
          ) : (
            <>
              <p className="search-count">{ru.searchCount(results.length)}</p>
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
        <p className="search-limitations">{ru.searchLimitations}</p>
      </section>
    </div>
  );
}

function Context({
  selection,
  close,
}: {
  selection: AtlasSelection;
  close?: () => void;
}) {
  const documentPath =
    selection.kind === "document" ? selection.path : undefined;
  const documentQuery = useQuery({
    queryKey: ["document", documentPath],
    queryFn: () => fetchDocument(documentPath!),
    enabled: documentPath !== undefined,
    retry: false,
  });

  return (
    <aside className="context-panel" aria-label={ru.context}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{ru.document}</p>
          <h2>{ru.context}</h2>
        </div>
        {close ? (
          <Button className="icon-button" onClick={close} aria-label={ru.close}>
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <div className="context-tabs" aria-label={ru.contextSections}>
        {contextSections.map((section) => (
          <button
            key={section}
            className={section === ru.properties ? "selected" : ""}
            type="button"
          >
            {section}
          </button>
        ))}
      </div>
      {documentQuery.data ? (
        <section className="properties" aria-labelledby="properties-heading">
          <h3 id="properties-heading">{ru.properties}</h3>
          {documentQuery.data.properties.length > 0 ? (
            <dl>
              {documentQuery.data.properties.map((property) => (
                <div key={property.name}>
                  <dt>{property.name}</dt>
                  <dd>{property.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>{ru.noProperties}</p>
          )}
        </section>
      ) : (
        <div className="empty-context">
          <FileText aria-hidden="true" />
          <p>{ru.emptyContext}</p>
        </div>
      )}
    </aside>
  );
}

function DocumentView({
  selection,
  openSearch,
}: {
  selection: Extract<AtlasSelection, { kind: "document" }>;
  openSearch: (tag: string) => void;
}) {
  const documentPath = selection.path;
  const documentQuery = useQuery({
    queryKey: ["document", documentPath],
    queryFn: () => fetchDocument(documentPath),
    retry: false,
  });

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
    return <div className="document-state">{ru.loading}</div>;
  }

  if (documentQuery.isError) {
    return (
      <div className="document-state error-state" role="status">
        <FileText aria-hidden="true" />
        <h1>
          {selection.root ? ru.unavailableTitle : ru.documentUnavailableTitle}
        </h1>
        <p>
          {selection.root ? ru.unavailableBody : ru.documentUnavailableBody}
        </p>
        <Button onClick={() => void documentQuery.refetch()}>{ru.retry}</Button>
      </div>
    );
  }

  return (
    <article className="document">
      <div className="document-kicker">/{documentQuery.data.path}</div>
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
      {documentQuery.data.diagnostics.length > 0 ? (
        <section className="document-diagnostics" aria-label={ru.diagnostics}>
          {documentQuery.data.diagnostics.map((diagnostic) => (
            <p key={diagnostic.code}>{diagnostic.message}</p>
          ))}
        </section>
      ) : null}
      <div
        className="document-body"
        dangerouslySetInnerHTML={{ __html: documentQuery.data.html }}
      />
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
    return <div className="document-state">{ru.loadingCatalog}</div>;
  }
  if (catalogQuery.isError) {
    return (
      <div className="document-state error-state" role="status">
        <FolderClosed aria-hidden="true" />
        <h1>{ru.folderUnavailableTitle}</h1>
        <p>{ru.folderUnavailableBody}</p>
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
  const [drawers, setDrawers] = useState<DrawerState>({
    navigation: false,
    context: false,
  });
  const [search, setSearch] = useState<{
    open: boolean;
    tag?: string;
  }>({ open: false });
  const closeDrawers = () => setDrawers({ navigation: false, context: false });
  const openSearch = (tag?: string) => {
    closeDrawers();
    setSearch(tag === undefined ? { open: true } : { open: true, tag });
  };

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <Button
          className="icon-button mobile-only"
          aria-label={ru.openNavigation}
          onClick={() => setDrawers({ navigation: true, context: false })}
        >
          <Menu aria-hidden="true" />
        </Button>
        <a className="brand" href="/">
          <span className="brand-mark">{ru.productMark}</span>
          <span>
            <strong>{ru.productName}</strong>
            <small>{ru.atlas}</small>
          </span>
        </a>
        <div className="topbar-spacer" />
        <Button
          className="icon-button mobile-only"
          aria-label={ru.openContext}
          onClick={() => setDrawers({ navigation: false, context: true })}
        >
          <PanelRightOpen aria-hidden="true" />
        </Button>
      </header>

      <div className="atlas-grid">
        <div className="desktop-panel">
          <Navigation selection={selection} openSearch={openSearch} />
        </div>
        <main className="document-column">
          {selection.kind === "folder" ? (
            <FolderView folderPath={selection.path} />
          ) : (
            <DocumentView selection={selection} openSearch={openSearch} />
          )}
        </main>
        <div className="desktop-panel">
          <Context selection={selection} />
        </div>
      </div>

      {drawers.navigation || drawers.context ? (
        <div className="drawer-layer">
          <button
            className="drawer-backdrop"
            aria-label={ru.close}
            onClick={closeDrawers}
          />
          <div className="drawer">
            {drawers.navigation ? (
              <Navigation
                selection={selection}
                close={closeDrawers}
                openSearch={openSearch}
              />
            ) : (
              <Context selection={selection} close={closeDrawers} />
            )}
          </div>
        </div>
      ) : null}

      {search.open ? (
        <SearchDialog
          initialTag={search.tag}
          close={() => setSearch({ open: false })}
        />
      ) : null}
    </div>
  );
}
