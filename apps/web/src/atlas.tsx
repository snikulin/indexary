import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderClosed,
  Menu,
  PanelRightOpen,
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
  materialUrl,
  type DocumentRepresentation,
  type MaterialReference,
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

export type ContextSectionId =
  | "source-materials"
  | "outgoing-links"
  | "backlinks"
  | "attachments"
  | "properties";

const contextSections: readonly ContextSectionId[] = [
  "source-materials",
  "outgoing-links",
  "backlinks",
  "attachments",
  "properties",
];

const contextSectionLabels: Record<ContextSectionId, string> = {
  "source-materials": ru.sources,
  "outgoing-links": ru.outgoingLinks,
  backlinks: ru.backlinks,
  attachments: ru.attachments,
  properties: ru.properties,
};

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

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "iframe",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function useModalFocus(
  containerRef: RefObject<HTMLElement | null>,
  initialFocusRef: RefObject<HTMLElement | null>,
  returnFocusRef: RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    const container = containerRef.current;
    const returnTarget = returnFocusRef.current;
    if (container === null) {
      return;
    }

    const focusInitial = () => {
      const target =
        initialFocusRef.current ??
        container.querySelector<HTMLElement>(focusableSelector);
      target?.focus();
    };
    focusInitial();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !container.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !container.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (returnTarget?.isConnected) {
        returnTarget.focus();
      }
    };
  }, [close, containerRef, initialFocusRef, returnFocusRef]);
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
  returnFocusRef,
}: {
  initialTag?: string;
  close: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const limitationsId = useId();
  const activeResultId = useId();
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
  const activeResult = results[activeIndex];

  useModalFocus(dialogRef, inputRef, returnFocusRef, close);

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
      <div className="search-backdrop" aria-hidden="true" onClick={close} />
      <section
        ref={dialogRef}
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-heading"
        aria-describedby={limitationsId}
        tabIndex={-1}
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
            onChange={(event) => setQuery(event.target.value)}
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
              onClick={() => setTag(undefined)}
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
      </section>
    </div>
  );
}

function Context({
  selection,
  close,
  closeButtonRef,
}: {
  selection: AtlasSelection;
  close?: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const tabsId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const documentPath =
    selection.kind === "document" ? selection.path : undefined;
  const documentQuery = useQuery({
    queryKey: ["document", documentPath],
    queryFn: () => fetchDocument(documentPath!),
    enabled: documentPath !== undefined,
    retry: false,
  });
  const [activeSection, setActiveSection] =
    useState<ContextSectionId>("properties");
  const [selectedMaterialId, setSelectedMaterialId] = useState<string>();

  useEffect(() => {
    setActiveSection("properties");
    setSelectedMaterialId(undefined);
  }, [documentPath]);

  const materialKind =
    activeSection === "source-materials"
      ? "sourceMaterials"
      : activeSection === "attachments"
        ? "attachments"
        : undefined;
  const materials =
    materialKind === undefined
      ? []
      : (documentQuery.data?.materials[materialKind] ?? []);
  const selectedMaterial =
    materials.find((material) => material.id === selectedMaterialId) ??
    materials[0];
  const activeTabId = `${tabsId}-tab-${activeSection}`;
  const activePanelId = `${tabsId}-panel-${activeSection}`;

  function selectTab(index: number) {
    const section = contextSections[index];
    if (section === undefined) {
      return;
    }
    setActiveSection(section);
    setSelectedMaterialId(undefined);
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % contextSections.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + contextSections.length) % contextSections.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = contextSections.length - 1;
    }
    if (nextIndex !== undefined) {
      event.preventDefault();
      selectTab(nextIndex);
    }
  }

  return (
    <aside className="context-panel" aria-label={ru.context}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{ru.document}</p>
          <h2>{ru.context}</h2>
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
      {selection.kind === "document" ? (
        <div
          className="context-tabs"
          role="tablist"
          aria-label={ru.contextSections}
        >
          {contextSections.map((section, index) => (
            <button
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              key={section}
              id={`${tabsId}-tab-${section}`}
              className={section === activeSection ? "selected" : ""}
              type="button"
              role="tab"
              aria-selected={section === activeSection}
              aria-controls={`${tabsId}-panel-${section}`}
              tabIndex={section === activeSection ? 0 : -1}
              onClick={() => {
                setActiveSection(section);
                setSelectedMaterialId(undefined);
              }}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {contextSectionLabels[section]}
            </button>
          ))}
        </div>
      ) : null}
      {selection.kind === "folder" ? (
        <div className="empty-context" role="status">
          <FileText aria-hidden="true" />
          <p>{ru.contextForFolder}</p>
        </div>
      ) : documentQuery.isPending ? (
        <div className="empty-context" role="status">
          <FileText aria-hidden="true" />
          <p>{ru.loadingContext}</p>
        </div>
      ) : documentQuery.isError ? (
        <div className="empty-context" role="status">
          <AlertTriangle aria-hidden="true" />
          <p>
            {isMissingRequest(documentQuery.error)
              ? ru.contextUnavailable
              : ru.contextServerError}
          </p>
          <Button onClick={() => void documentQuery.refetch()}>
            {ru.retry}
          </Button>
        </div>
      ) : documentQuery.data ? (
        materialKind !== undefined ? (
          <MaterialPanel
            documentPath={documentQuery.data.path}
            revision={documentQuery.data.revision}
            heading={contextSectionLabels[activeSection]}
            materials={materials}
            selected={selectedMaterial}
            select={setSelectedMaterialId}
            panelId={activePanelId}
            labelledBy={activeTabId}
          />
        ) : (
          <ContextSection
            document={documentQuery.data}
            section={activeSection}
            panelId={activePanelId}
            labelledBy={activeTabId}
          />
        )
      ) : (
        <div className="empty-context">
          <FileText aria-hidden="true" />
          <p>{ru.emptyContext}</p>
        </div>
      )}
    </aside>
  );
}

function formatMaterialSize(size: number | null): string {
  if (size === null) {
    return ru.unknownSize;
  }
  if (size < 1024) {
    return ru.bytes(size);
  }
  if (size < 1024 * 1024) {
    return ru.kilobytes((size / 1024).toFixed(1));
  }
  return ru.megabytes((size / (1024 * 1024)).toFixed(1));
}

function MaterialPanel({
  documentPath,
  revision,
  heading,
  materials,
  selected,
  select,
  panelId,
  labelledBy,
}: {
  documentPath: string;
  revision: number;
  heading: string;
  materials: MaterialReference[];
  selected: MaterialReference | undefined;
  select: (id: string) => void;
  panelId: string;
  labelledBy: string;
}) {
  return (
    <section
      id={panelId}
      className="materials"
      role="tabpanel"
      aria-labelledby={labelledBy}
      tabIndex={0}
    >
      <h3>{heading}</h3>
      {materials.length === 0 ? (
        <p className="empty-materials">{ru.noMaterials}</p>
      ) : (
        <>
          <ul className="material-list">
            {materials.map((material) => (
              <li key={material.id}>
                <button
                  type="button"
                  className={material.id === selected?.id ? "selected" : ""}
                  aria-pressed={material.id === selected?.id}
                  onClick={() => select(material.id)}
                >
                  <span>{material.name}</span>
                  <small>
                    {material.status === "available"
                      ? material.mimeType
                      : material.status === "missing"
                        ? ru.materialMissing
                        : ru.materialInvalid}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {selected ? (
            <div className="material-detail">
              <h4>{selected.name}</h4>
              <dl>
                <div>
                  <dt>{ru.materialType}</dt>
                  <dd>{selected.mimeType}</dd>
                </div>
                <div>
                  <dt>{ru.materialSize}</dt>
                  <dd>{formatMaterialSize(selected.size)}</dd>
                </div>
              </dl>
              {selected.diagnostic ? (
                <p className="material-diagnostic" role="status">
                  {selected.status === "missing"
                    ? ru.materialMissing
                    : ru.materialInvalid}
                </p>
              ) : selected.preview === "image" ? (
                <img
                  className="material-preview image-preview"
                  src={materialUrl(documentPath, selected.id, revision)}
                  alt={selected.name}
                />
              ) : selected.preview === "pdf" ? (
                <iframe
                  className="material-preview pdf-preview"
                  src={materialUrl(documentPath, selected.id, revision)}
                  title={`${ru.pdfPreview}: ${selected.name}`}
                />
              ) : (
                <a
                  className="material-open"
                  href={materialUrl(documentPath, selected.id, revision)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink aria-hidden="true" />
                  {ru.openMaterial}
                </a>
              )}
            </div>
          ) : (
            <p className="empty-materials">{ru.noMaterials}</p>
          )}
        </>
      )}
    </section>
  );
}

function ContextSection({
  document,
  section,
  panelId,
  labelledBy,
}: {
  document: DocumentRepresentation;
  section: ContextSectionId;
  panelId: string;
  labelledBy: string;
}) {
  if (section === "outgoing-links") {
    return (
      <section
        id={panelId}
        className="relationships"
        role="tabpanel"
        aria-labelledby={labelledBy}
        tabIndex={0}
      >
        <h3 id="links-heading">{ru.outgoingLinks}</h3>
        {document.outgoingLinks.length === 0 ? (
          <p>{ru.noOutgoingLinks}</p>
        ) : (
          <ul aria-label={ru.outgoingLinks}>
            {document.outgoingLinks.map((link, index) => (
              <li key={`${link.target}-${index}`}>
                {link.state === "resolved" && link.path ? (
                  <a href={documentRoute(link.path)}>{link.label}</a>
                ) : (
                  <span className={`relationship-${link.state}`}>
                    {link.label}
                  </span>
                )}
                <small>{ru.wikilinkState[link.state]}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  if (section === "backlinks") {
    return (
      <section
        id={panelId}
        className="relationships"
        role="tabpanel"
        aria-labelledby={labelledBy}
        tabIndex={0}
      >
        <h3 id="backlinks-heading">{ru.backlinks}</h3>
        {document.backlinks.length === 0 ? (
          <p>{ru.noBacklinks}</p>
        ) : (
          <ul aria-label={ru.backlinks}>
            {document.backlinks.map((backlink, index) => (
              <li key={`${backlink.path}-${index}`}>
                <a href={documentRoute(backlink.path)}>{backlink.title}</a>
                <p>{backlink.snippet}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section
      id={panelId}
      className="properties"
      role="tabpanel"
      aria-labelledby={labelledBy}
      tabIndex={0}
    >
      <h3 id="properties-heading">{ru.properties}</h3>
      {document.properties.length > 0 ? (
        <dl>
          {document.properties.map((property) => (
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

  return (
    <article
      ref={viewRef as RefObject<HTMLElement | null>}
      className="document"
      tabIndex={-1}
      onFocusCapture={rememberFocusedControl}
      onBlurCapture={forgetFocusedControl}
    >
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

function AtlasDrawer({
  kind,
  selection,
  close,
  openSearch,
  returnFocusRef,
}: {
  kind: "navigation" | "context";
  selection: AtlasSelection;
  close: () => void;
  openSearch: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useModalFocus(drawerRef, closeButtonRef, returnFocusRef, close);

  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" aria-hidden="true" onClick={close} />
      <div
        ref={drawerRef}
        id={`${kind}-drawer`}
        className={`drawer drawer-${kind}`}
        role="dialog"
        aria-modal="true"
        aria-label={
          kind === "navigation" ? ru.navigationDialog : ru.contextDialog
        }
        tabIndex={-1}
      >
        {kind === "navigation" ? (
          <Navigation
            selection={selection}
            close={close}
            closeButtonRef={closeButtonRef}
            openSearch={openSearch}
          />
        ) : (
          <Context
            selection={selection}
            close={close}
            closeButtonRef={closeButtonRef}
          />
        )}
      </div>
    </div>
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
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const searchReturnFocusRef = useRef<HTMLElement>(null);
  const closeDrawers = useCallback(
    () => setDrawers({ navigation: false, context: false }),
    [],
  );
  const closeSearch = useCallback(() => setSearch({ open: false }), []);
  const openSearch = useCallback(
    (tag?: string) => {
      const activeElement = document.activeElement;
      searchReturnFocusRef.current =
        drawers.navigation && navigationButtonRef.current
          ? navigationButtonRef.current
          : drawers.context && contextButtonRef.current
            ? contextButtonRef.current
            : activeElement instanceof HTMLElement
              ? activeElement
              : null;
      closeDrawers();
      setSearch(tag === undefined ? { open: true } : { open: true, tag });
    },
    [closeDrawers, drawers.context, drawers.navigation],
  );

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [openSearch]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const desktop = window.matchMedia("(min-width: 1101px)");
    const handleDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) {
        closeDrawers();
      }
    };
    desktop.addEventListener("change", handleDesktop);
    return () => desktop.removeEventListener("change", handleDesktop);
  }, [closeDrawers]);

  const drawerOpen = drawers.navigation || drawers.context;
  const backgroundHidden = drawerOpen || search.open;

  return (
    <div className="app-shell">
      <div
        className="application-content"
        aria-hidden={backgroundHidden ? "true" : undefined}
        inert={backgroundHidden ? true : undefined}
      >
        <a className="skip-link" href="#document-content">
          {ru.skipToDocument}
        </a>
        <header className="topbar">
          <Button
            ref={navigationButtonRef}
            className="icon-button mobile-only"
            aria-label={ru.openNavigation}
            aria-controls="navigation-drawer"
            aria-expanded={drawers.navigation}
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
            ref={contextButtonRef}
            className="icon-button mobile-only"
            aria-label={ru.openContext}
            aria-controls="context-drawer"
            aria-expanded={drawers.context}
            onClick={() => setDrawers({ navigation: false, context: true })}
          >
            <PanelRightOpen aria-hidden="true" />
          </Button>
        </header>

        <div className="atlas-grid">
          <div className="desktop-panel">
            <Navigation selection={selection} openSearch={openSearch} />
          </div>
          <main id="document-content" className="document-column" tabIndex={-1}>
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
      </div>

      {drawerOpen ? (
        <AtlasDrawer
          kind={drawers.navigation ? "navigation" : "context"}
          selection={selection}
          close={closeDrawers}
          openSearch={openSearch}
          returnFocusRef={
            drawers.navigation ? navigationButtonRef : contextButtonRef
          }
        />
      ) : null}

      {search.open ? (
        <SearchDialog
          initialTag={search.tag}
          close={closeSearch}
          returnFocusRef={searchReturnFocusRef}
        />
      ) : null}
    </div>
  );
}
