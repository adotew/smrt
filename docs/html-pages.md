# Writing HTML pages for Smrt

Smrt shows `.html` files from the library as interactive pages. These rules make a page look
native in the app, in light and dark mode. Follow them when generating pages.

## Style

Smrt adds its own stylesheet to every page. It already styles `body` (font, colours, a centred
720px reading column), headings, links, lists, `code`/`pre`, tables, blockquotes, `details`,
buttons, inputs, selects and textareas.

- Write semantic HTML and let those defaults do the work.
- Don't set a font, colour or background on `html` or `body`, and don't add a CSS reset. Any
  rule you write wins over the app's, so restyling these breaks the native look.
- Style only what's specific to the page, such as a quiz option or a chart's container. Use these
  variables for colours, so that part follows light and dark mode:

| Variable          | Use                                      |
| ----------------- | ---------------------------------------- |
| `--smrt-bg`       | Page background                          |
| `--smrt-fg`       | Text                                     |
| `--smrt-muted`    | Secondary text                           |
| `--smrt-surface`  | Subtle fills: cards, code, hovered rows  |
| `--smrt-border`   | Borders and dividers                     |
| `--smrt-accent`   | Links, focus rings, selected states      |
| `--smrt-accent-fg`| Text on `--smrt-accent`                  |
| `--smrt-radius`   | Corner radius                            |
| `--smrt-font`     | Body font                                |
| `--smrt-mono`     | Code font                                |

```html
<style>
  .option { padding: 12px; border: 1px solid var(--smrt-border); border-radius: var(--smrt-radius); }
  .option.selected { border-color: var(--smrt-accent); }
</style>
```

A page that needs a look of its own can set anything; its rules override the app's. For a
full-bleed layout such as a canvas or a dashboard, drop the reading column:

```css
body { max-width: none; margin: 0; padding: 0; }
```

## Behaviour

- Prefer one self-contained file: inline `<style>` and `<script>`. Files next to the page
  (`assets/app.js`) also load.
- Scripts run. `alert`, `confirm`, `prompt` and forms work.
- The network works, but the user may be offline, so a page should still be usable without
  CDN scripts.
- Links with `target="_blank"` open in the user's browser.
- Not available: the app itself (`parent`, `top`), `localStorage`, `sessionStorage`, cookies, and
  `fetch` of files next to the page. Keep state in memory.
