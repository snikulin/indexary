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
import { useEffect, useState } from "react";

import {
  documentRoute,
  fetchCatalog,
  fetchDocument,
  folderRoute,
  materialUrl,
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
}: {
  selection: AtlasSelection;
  close?: () => void;
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
        <input type="search" placeholder={ru.searchPlaceholder} disabled />
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
  const [activeSection, setActiveSection] = useState<string>(ru.properties);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string>();

  useEffect(() => {
    setActiveSection(ru.properties);
    setSelectedMaterialId(undefined);
  }, [documentPath]);

  const materialKind =
    activeSection === ru.sources
      ? "sourceMaterials"
      : activeSection === ru.attachments
        ? "attachments"
        : undefined;
  const materials =
    materialKind === undefined
      ? []
      : (documentQuery.data?.materials[materialKind] ?? []);
  const selectedMaterial =
    materials.find((material) => material.id === selectedMaterialId) ??
    materials[0];

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
      <div
        className="context-tabs"
        role="tablist"
        aria-label={ru.contextSections}
      >
        {contextSections.map((section) => (
          <button
            key={section}
            className={section === activeSection ? "selected" : ""}
            type="button"
            role="tab"
            aria-selected={section === activeSection}
            onClick={() => {
              setActiveSection(section);
              setSelectedMaterialId(undefined);
            }}
          >
            {section}
          </button>
        ))}
      </div>
      {documentQuery.data ? (
        activeSection === ru.properties ? (
          <section
            className="properties"
            role="tabpanel"
            aria-labelledby="properties-heading"
          >
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
        ) : materialKind !== undefined ? (
          <MaterialPanel
            documentPath={documentQuery.data.path}
            heading={activeSection}
            materials={materials}
            selected={selectedMaterial}
            select={setSelectedMaterialId}
          />
        ) : (
          <div className="empty-context" role="tabpanel">
            <FileText aria-hidden="true" />
            <p>{ru.emptyContext}</p>
          </div>
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
    return `${size} Б`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} КБ`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

function MaterialPanel({
  documentPath,
  heading,
  materials,
  selected,
  select,
}: {
  documentPath: string;
  heading: string;
  materials: MaterialReference[];
  selected: MaterialReference | undefined;
  select: (id: string) => void;
}) {
  return (
    <section className="materials" role="tabpanel" aria-label={heading}>
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
                      : ru.materialUnavailable}
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
                  {selected.diagnostic.message}
                </p>
              ) : selected.preview === "image" ? (
                <img
                  className="material-preview image-preview"
                  src={materialUrl(documentPath, selected.id)}
                  alt={selected.name}
                />
              ) : selected.preview === "pdf" ? (
                <iframe
                  className="material-preview pdf-preview"
                  src={materialUrl(documentPath, selected.id)}
                  title={`${ru.pdfPreview}: ${selected.name}`}
                />
              ) : (
                <a
                  className="material-open"
                  href={materialUrl(documentPath, selected.id)}
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

function DocumentView({
  selection,
}: {
  selection: Extract<AtlasSelection, { kind: "document" }>;
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
            <li key={tag}>{tag}</li>
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
  const closeDrawers = () => setDrawers({ navigation: false, context: false });

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
          <Navigation selection={selection} />
        </div>
        <main className="document-column">
          {selection.kind === "folder" ? (
            <FolderView folderPath={selection.path} />
          ) : (
            <DocumentView selection={selection} />
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
              <Navigation selection={selection} close={closeDrawers} />
            ) : (
              <Context selection={selection} close={closeDrawers} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
