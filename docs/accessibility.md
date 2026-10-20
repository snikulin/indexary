# Accessibility checks

Indexary's critical Atlas journey is automated in Playwright for Chromium and
Firefox. The default quality gate uses the supported host Chromium. Run the same
suite with Playwright's Firefox build after installing that browser once:

```sh
mise exec -- pnpm exec playwright install firefox
INDEXARY_BROWSER=firefox mise exec -- pnpm test:browser:smoke
```

WebKit is best effort and can be exercised with `INDEXARY_BROWSER=webkit` after
installing its Playwright browser build.

## Focused manual keyboard check

Run `mise run dev`, use desktop, tablet and phone widths, and complete this check
without a pointer. The Document has no permanent side panels at any width:

1. Press `Tab`; the Russian skip link must become visible and move focus to the
   Document area.
2. Reach the navigation button and visible search action in the sticky toolbar.
   Open navigation, follow folder and Document links, then reach a Document tag,
   resolved wikilinks and every visible action with `Tab` and `Shift+Tab`. Focus
   must always have an orange outline.
3. Press `Ctrl+K` (or `Cmd+K`), type a query, use arrow keys to choose a result,
   and press `Enter`. `Escape` must close search and restore focus to its opener.
4. Open a single Source Material directly from the Document action, or choose
   from All files when several files are referenced. Source Materials and
   Attachments share one list. Switch between an image, a PDF, an unsupported
   format and a missing file. Check image zoom, open separately and download.
5. Open navigation and the file viewer at each width. Focus must enter the close
   button, remain inside on repeated `Tab`/`Shift+Tab`, close with `Escape`, and
   return to the opener without moving the reading position. Check keyboard
   behavior inside the browser's embedded PDF viewer too. Its controls and PDF
   support vary by browser; open separately and download remain available.
6. Follow a wikilink and a backlink, then use browser Back and Forward. Repeat
   from a search result and a tag-filtered result. Reopen search and verify that
   the last query/filter are retained within the current browser tab.
7. While a focused Document action is visible, externally update the Document.
   Confirm the updated state is announced and that focus remains usable. Delete
   the active Document and confirm the Russian missing-Document status appears.
   While viewing a file, reorder or remove references externally: the selected
   path must remain selected or show an unavailable state, never silently change
   to another file. Close the viewer and confirm focus is usable even when its
   opening action disappeared.

Inspect the reading layout around 1100/1101 px: adding a pixel must not introduce
panels or squeeze the text. Check heading sizes, nested list markers and numbering,
wide table scrolling, long filenames, and expanded Document properties at phone
width. Linked Documents and backlinks are below the text; properties expand from
the Document's actions.

Also inspect loading, empty folder, missing Home Document, missing Document,
degraded Document, missing Source Material, ambiguous link, empty search, and
server-error states. Each must be distinct, understandable in Russian, and must
not leave an inert visible control.
