import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

/** Native modal isolation also contains keyboard focus inside embedded PDF viewers. */
export function Modal({
  children,
  label,
  className,
  initialFocusRef,
  returnFocusRef,
  close,
}: {
  children: ReactNode;
  label: string;
  className: string;
  initialFocusRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
  close: () => void;
}) {
  const containerRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const container = containerRef.current!;
    const returnTarget = returnFocusRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    container.showModal();
    (initialFocusRef.current ?? container).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "Tab") {
        const controls = Array.from(
          container.querySelectorAll<HTMLElement>(focusableSelector),
        ).filter(
          (element) => !element.closest('[hidden], [aria-hidden="true"]'),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (!first || !last) {
          event.preventDefault();
          container.focus();
        } else if (
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
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      container.close();
      document.body.style.overflow = previousOverflow;
      const target = returnTarget?.isConnected
        ? returnTarget
        : document.getElementById("document-content");
      target?.focus({ preventScroll: true });
    };
  }, [close, initialFocusRef, returnFocusRef]);

  return (
    <dialog
      ref={containerRef}
      className={`modal ${className}`}
      aria-label={label}
      aria-modal="true"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          close();
      }}
    >
      {children}
    </dialog>
  );
}
