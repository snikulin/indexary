import { useQuery } from "@tanstack/react-query";
import {
  BookOpenText,
  ChevronRight,
  FileText,
  FolderClosed,
  Menu,
  PanelRightOpen,
  Search,
  X,
} from "lucide-react";
import { useState } from "react";

import { fetchHomeDocument } from "./api";
import { Button } from "./components/ui/button";
import { ru } from "./i18n/ru";

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

function Navigation({ close }: { close?: () => void }) {
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
        className="tree-item active"
        href="/"
        aria-current="page"
        onClick={close}
      >
        <BookOpenText aria-hidden="true" />
        <span>{ru.home}</span>
      </a>
      <div className="tree-label folders-label">{ru.folders}</div>
      <div className="tree-item muted" aria-disabled="true">
        <FolderClosed aria-hidden="true" />
        <span>{ru.foldersPlaceholder}</span>
        <ChevronRight aria-hidden="true" />
      </div>
    </nav>
  );
}

function Context({ close }: { close?: () => void }) {
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
        {contextSections.map((section, index) => (
          <button
            key={section}
            className={index === 0 ? "selected" : ""}
            type="button"
          >
            {section}
          </button>
        ))}
      </div>
      <div className="empty-context">
        <FileText aria-hidden="true" />
        <p>{ru.emptyContext}</p>
      </div>
    </aside>
  );
}

function DocumentView() {
  const documentQuery = useQuery({
    queryKey: ["document", "index.md"],
    queryFn: fetchHomeDocument,
    retry: false,
  });

  if (documentQuery.isPending) {
    return <div className="document-state">{ru.loading}</div>;
  }

  if (documentQuery.isError) {
    return (
      <div className="document-state error-state" role="status">
        <FileText aria-hidden="true" />
        <h1>{ru.unavailableTitle}</h1>
        <p>{ru.unavailableBody}</p>
        <Button onClick={() => void documentQuery.refetch()}>{ru.retry}</Button>
      </div>
    );
  }

  return (
    <article className="document">
      <div className="document-kicker">/{documentQuery.data.path}</div>
      <h1>{documentQuery.data.title}</h1>
      <div
        className="document-body"
        dangerouslySetInnerHTML={{ __html: documentQuery.data.html }}
      />
    </article>
  );
}

export function Atlas() {
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
          <Navigation />
        </div>
        <main className="document-column">
          <DocumentView />
        </main>
        <div className="desktop-panel">
          <Context />
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
              <Navigation close={closeDrawers} />
            ) : (
              <Context close={closeDrawers} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
