# Accessibility checks

Indexary's critical Atlas journey is automated in Playwright for Chromium and
Firefox. The default quality gate uses the supported host Chromium. Run the same
suite with Playwright's Firefox build after installing that browser once:

```sh
mise exec -- pnpm exec playwright install firefox
INDEXARY_BROWSER=firefox mise exec -- pnpm test:browser
```

WebKit is best effort and can be exercised with `INDEXARY_BROWSER=webkit` after
installing its Playwright browser build.

## Focused manual keyboard check

Run `mise run dev`, use a viewport wider than 1100 px and then a tablet viewport
between 768 and 1100 px, and complete this check without a pointer:

1. Press `Tab`; the Russian skip link must become visible and move focus to the
   Document area.
2. Reach navigation, folder and Document links, a Document tag, resolved
   wikilinks, and every visible action with `Tab` and `Shift+Tab`. Focus must
   always have an orange outline.
3. Press `Ctrl+K` (or `Cmd+K`), type a query, use arrow keys to choose a result,
   and press `Enter`. `Escape` must close search and restore focus to its opener.
4. Move among context tabs with `Left`, `Right`, `Home`, and `End`. Use `Enter`
   to select Source Materials and Attachments, including image/PDF previews and
   the explicit open action for unsupported formats.
5. At tablet width, open both navigation and context drawers. Focus must enter
   the close button, remain inside on repeated `Tab`/`Shift+Tab`, close with
   `Escape`, and return to the matching toolbar button.
6. Follow a wikilink and a backlink, then use browser Back and Forward. Repeat
   from a search result and a tag-filtered result.
7. While a focused Document action is visible, externally update the Document.
   Confirm the updated state is announced and that focus remains usable. Delete
   the active Document and confirm the Russian missing-Document status appears.

Also inspect loading, empty folder, missing Home Document, missing Document,
degraded Document, missing Source Material, ambiguous link, empty search, and
server-error states. Each must be distinct, understandable in Russian, and must
not leave an inert visible control.
