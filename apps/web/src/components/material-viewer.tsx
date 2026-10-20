import { useQuery } from "@tanstack/react-query";
import {
  Download,
  ExternalLink,
  FileImage,
  FileText,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useRef, useState, type RefObject } from "react";

import {
  fetchDocument,
  isMissingRequest,
  materialUrl,
  type MaterialReference,
} from "../api";
import { ru } from "../i18n/ru";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";

// IDs are positional. Track path and role so a live reordering cannot silently
// replace the file the reader chose with another file occupying the same ID.
function materialIdentity(material: MaterialReference): string {
  return JSON.stringify([material.kind, material.path]);
}

export function formatMaterialSize(size: number | null): string {
  if (size === null) return ru.unknownSize;
  if (size < 1024) return ru.bytes(size);
  if (size < 1024 * 1024) return ru.kilobytes((size / 1024).toFixed(1));
  return ru.megabytes((size / (1024 * 1024)).toFixed(1));
}

function MaterialPreview({
  material,
  documentPath,
  revision,
}: {
  material: MaterialReference;
  documentPath: string;
  revision: number;
}) {
  const [zoom, setZoom] = useState(100);
  const [failed, setFailed] = useState(false);
  const url = materialUrl(documentPath, material.id, revision);
  if (material.status !== "available" || failed) {
    return (
      <div className="material-state" role="status">
        <FileText aria-hidden="true" />
        <p>
          {material.status === "missing"
            ? ru.materialMissing
            : material.status === "invalid"
              ? ru.materialInvalid
              : ru.materialLoadFailed}
        </p>
        {failed && <Button onClick={() => setFailed(false)}>{ru.retry}</Button>}
      </div>
    );
  }
  if (material.preview === "image") {
    return (
      <>
        <div className="image-controls" role="group" aria-label={ru.imageZoom}>
          <Button
            className="icon-button"
            aria-label={ru.zoomOut}
            disabled={zoom <= 50}
            onClick={() => setZoom((value) => value - 25)}
          >
            <ZoomOut aria-hidden="true" />
          </Button>
          <output aria-live="polite">{zoom}%</output>
          <Button
            className="icon-button"
            aria-label={ru.zoomIn}
            disabled={zoom >= 200}
            onClick={() => setZoom((value) => value + 25)}
          >
            <ZoomIn aria-hidden="true" />
          </Button>
          <Button className="secondary-button" onClick={() => setZoom(100)}>
            {ru.fitWidth}
          </Button>
        </div>
        <div className="image-scroll">
          <img
            className="image-preview"
            src={url}
            alt={material.name}
            style={{ width: `${zoom}%` }}
            onError={() => setFailed(true)}
          />
        </div>
      </>
    );
  }
  if (material.preview === "pdf") {
    return (
      <>
        <iframe
          className="pdf-preview"
          title={`${ru.pdfPreview}: ${material.name}`}
          src={url}
          onError={() => setFailed(true)}
        />
        <p className="preview-help">{ru.pdfPreviewHelp}</p>
      </>
    );
  }
  return (
    <div className="material-state">
      <FileText aria-hidden="true" />
      <p>{ru.unsupportedPreview}</p>
      <a
        className="material-open"
        href={materialUrl(documentPath, material.id, revision, {
          download: true,
        })}
        download={material.name}
      >
        <Download aria-hidden="true" />
        {ru.downloadMaterial}
      </a>
    </div>
  );
}

export function MaterialViewer({
  documentPath,
  initialMaterial,
  close,
  returnFocusRef,
}: {
  documentPath: string;
  initialMaterial?: MaterialReference;
  close: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [selectedIdentity, setSelectedIdentity] = useState(() =>
    initialMaterial ? materialIdentity(initialMaterial) : undefined,
  );
  const documentQuery = useQuery({
    queryKey: ["document", documentPath],
    queryFn: () => fetchDocument(documentPath),
    retry: false,
  });
  const representation = documentQuery.data;
  const materials = representation
    ? [
        ...representation.materials.sourceMaterials,
        ...representation.materials.attachments,
      ]
    : [];
  const selected = materials.find(
    (material) => materialIdentity(material) === selectedIdentity,
  );
  const available = selected?.status === "available";

  return (
    <Modal
      className="file-viewer"
      label={ru.fileViewer}
      initialFocusRef={closeButtonRef}
      returnFocusRef={returnFocusRef}
      close={close}
    >
      <header className="viewer-header">
        <div>
          <h2>{selected?.name ?? ru.files}</h2>
          <p>{representation?.title ?? documentPath}</p>
        </div>
        <div className="viewer-actions">
          {available && selected.preview !== "unsupported" && (
            <a
              className="secondary-button"
              aria-label={ru.openSeparately}
              href={materialUrl(
                documentPath,
                selected.id,
                representation?.revision,
              )}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink aria-hidden="true" />
              <span>{ru.openSeparately}</span>
            </a>
          )}
          {available && (
            <a
              className="secondary-button"
              aria-label={ru.downloadMaterial}
              href={materialUrl(
                documentPath,
                selected.id,
                representation?.revision,
                { download: true },
              )}
              download={selected.name}
            >
              <Download aria-hidden="true" />
              <span>{ru.downloadMaterial}</span>
            </a>
          )}
          <Button
            ref={closeButtonRef}
            className="icon-button"
            aria-label={ru.closeFileViewer}
            onClick={close}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </header>
      {documentQuery.isPending ? (
        <div className="material-state" role="status">
          {ru.loadingFiles}
        </div>
      ) : documentQuery.isError ? (
        <div className="material-state" role="status">
          <p>
            {isMissingRequest(documentQuery.error)
              ? ru.documentUnavailableBody
              : ru.serverUnavailableBody}
          </p>
          <Button onClick={() => void documentQuery.refetch()}>
            {ru.retry}
          </Button>
        </div>
      ) : (
        <div className="viewer-layout">
          <nav className="viewer-files" aria-label={ru.files}>
            <p className="eyebrow">
              {ru.allFiles} · {materials.length}
            </p>
            <ul className="material-list">
              {materials.map((material) => (
                <li key={materialIdentity(material)}>
                  <button
                    type="button"
                    aria-pressed={
                      materialIdentity(material) === selectedIdentity
                    }
                    onClick={() =>
                      setSelectedIdentity(materialIdentity(material))
                    }
                  >
                    {material.preview === "image" ? (
                      <FileImage aria-hidden="true" />
                    ) : (
                      <FileText aria-hidden="true" />
                    )}
                    <span>
                      <strong>{material.name}</strong>
                      <small>
                        {material.kind === "source-material"
                          ? ru.sourceMaterial
                          : ru.attachment}
                      </small>
                      <small>
                        {material.status === "available"
                          ? `${material.mimeType} · ${formatMaterialSize(material.size)}`
                          : material.status === "missing"
                            ? ru.materialMissing
                            : ru.materialInvalid}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <section className="viewer-stage" aria-label={ru.materialContent}>
            {selected && representation ? (
              <MaterialPreview
                key={JSON.stringify([
                  selectedIdentity,
                  representation.revision,
                  selected.id,
                ])}
                documentPath={documentPath}
                revision={representation.revision}
                material={selected}
              />
            ) : (
              <div className="material-state" role="status">
                <FileText aria-hidden="true" />
                <p>
                  {selectedIdentity
                    ? ru.materialNoLongerReferenced
                    : materials.length === 0
                      ? ru.noFiles
                      : ru.chooseFile}
                </p>
              </div>
            )}
          </section>
        </div>
      )}
      <footer className="viewer-footer">
        <span>{selected?.path}</span>
        <Button className="text-button" onClick={close}>
          {ru.backToDocument}
        </Button>
      </footer>
    </Modal>
  );
}
