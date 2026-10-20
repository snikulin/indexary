import "@testing-library/jest-dom/vitest";

// jsdom has no native top layer; real focus isolation is covered in Playwright.
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  },
  close: {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  },
});
