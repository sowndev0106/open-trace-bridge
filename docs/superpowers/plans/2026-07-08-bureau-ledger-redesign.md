# Bureau Ledger Admin Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-theme the entire `/admin` console from the current gradient-SaaS look to the "Bureau Ledger" design system (Newsreader/Archivo/Spline Sans Mono, single oxide accent, near-square corners, hairline rules, glyph status indicators), covering the design-token foundation, a two-mode layout shell, a reusable component layer, and all 8 page groups.

**Architecture:** CSS custom properties in `assets/styles/admin.css` keep their current names so every `var(--color-*)` call site repaints for free; only values change. New component classes (`.tab-bar`, `.kicker`, `.segmented`) are added alongside existing ones (`.btn-*`, `.status-badge`, `.panel`, `.data-table`). `layout-head.ejs`/`layout-foot.ejs` gain a second shell mode selected by a per-view local var. No routes, models, or controllers change — this is a `views/**` + `assets/styles/admin.css` project.

**Tech Stack:** EJS templates, Tailwind CSS v4 (CSS-first `@theme`/`@layer`), vanilla JS (no framework), `node --test` + `supertest` + `cheerio` for the existing HTTP/markup test suite.

## Global Constraints

- Keep existing CSS variable names in `admin.css` (`--color-canvas`, `--color-panel`, `--color-panel-alt`, `--color-border`, `--color-border-strong`, `--color-ink-950/700/500/300`, `--color-brand`, `--color-success`, `--color-warning`, `--color-danger`) — only values change, so every `var(--color-*)` call site in EJS repaints automatically.
- `:root` (no `.dark` class) = Paper light theme. `.dark` = Ink dark theme (the new default — see Task 2).
- New fonts: `--font-serif: 'Newsreader', serif` (titles/numerals), `--font-sans: 'Archivo', sans-serif` (replaces Outfit), `--font-mono: 'Spline Sans Mono', monospace` (replaces JetBrains Mono).
- `--radius: 2px` everywhere buttons/inputs/cards currently use 0.5rem–1rem.
- No gradients, no glow `box-shadow`, anywhere (including the dashboard SVG chart).
- **Never rewrite the literal text content of an existing button/heading/label** — the test suite asserts exact strings like `'New project'`, `'Save project'`, `'Chat history'`, `'API calls'`, `'Audit'` via `cheerio` `.text().trim()`, and `/Source/` (case-sensitive) against table headers. Any "ALL CAPS" look in the mock is applied with CSS `text-transform: uppercase`, never by changing the text node.
- **Never make collapse/expand or tabs a client-fetch-on-reveal pattern.** All content (API group fields, API-call request/response detail) must be present in the server-rendered HTML at all times; collapse/expand and tab switching only toggle visibility (`hidden` attribute or `display:none` via a data-attribute selector), because the test suite parses raw HTML with `cheerio` (no JS execution) and several tests regex-match content that must be in the initial response (e.g. request/response JSON bodies).
- Preserve every selector/attribute the test suite or client JS currently depends on: `.error-list`, `.panel-body`, `.table-shell`, `.status-badge`, `[data-project-sync]`, `[data-repo-status]`, `[data-api-call-row]`, `#webhook-endpoint-url`, `template[data-template="repos"|"apis"]`, `#chat-history`, `#chat-input`, `#opencode-frame`, `[data-auth-type-select]` → becomes the new radio-group selector (Task 15), `data-add`, `data-remove`, `data-rows`.
- Run `npm test` after every task. Run `npm run build:css` after every CSS-only task to confirm Tailwind v4 compiles without error.
- All work happens on `views/**` and `assets/styles/admin.css` only. No changes to `routes/`, `controllers/`, `models/`, `services/`, or the public event-ingestion app.

---

## Task 1: Design tokens, fonts, and radius scale

**Files:**
- Modify: `assets/styles/admin.css:1-95` (the `:root`/`.dark`/`@theme` block)

**Interfaces:**
- Produces: `--color-canvas`, `--color-panel`, `--color-panel-alt`, `--color-panel-raised`, `--color-border`, `--color-border-strong`, `--color-ink-950/700/500/300`, `--color-brand` (now = oxide accent), `--color-success`, `--color-warning`, `--color-danger`, `--color-ok` (new, alias of success), `--color-amber` (new, alias of warning), `--font-serif` (new), `--font-sans`, `--font-mono`, `--radius` (new, `2px`) — all consumed by every later task and by every existing EJS view.

- [ ] **Step 1: Replace the token block**

Replace `assets/styles/admin.css:1-95` with:

```css
@import "tailwindcss";
@plugin "@tailwindcss/forms";
@source "../../views/**/*.ejs";

/* ============================================================
   DESIGN TOKENS — Bureau Ledger
   ============================================================ */
:root {
  --font-serif: 'Newsreader', serif;
  --font-sans: 'Archivo', ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: 'Spline Sans Mono', ui-monospace, SFMono-Regular, monospace;
  --radius: 2px;

  /* Paper light (default when .dark is absent) */
  --color-canvas:       #F2EEE3;
  --color-panel:        #F2EEE3;
  --color-panel-alt:     #FBF8F0;
  --color-panel-raised:  #FBF8F0;

  --color-border:        #D8D2C2;
  --color-border-strong:  #C8C2B2;

  --color-ink-950:  #201C15;
  --color-ink-700:  #332E24;
  --color-ink-500:  #5F594A;
  --color-ink-300:  #98917E;

  --color-brand:      #BC4A2E; /* oxide accent */
  --color-brand-dark: #A5401F;
  --color-ok:         #5B8452;
  --color-success:    #5B8452;
  --color-warning:    #A87A24;
  --color-amber:      #A87A24;
  --color-danger:     #BC4A2E;
}

.dark {
  /* Ink dark (default theme — see layout-head.ejs anti-flicker script) */
  --color-canvas:       #141210;
  --color-panel:        #141210;
  --color-panel-alt:     #1B1815;
  --color-panel-raised:  #1B1815;

  --color-border:        #2E2921;
  --color-border-strong:  #3A342B;

  --color-ink-950:  #EAE3D4;
  --color-ink-700:  #DCD5C4;
  --color-ink-500:  #A79E8B;
  --color-ink-300:  #6E6657;

  --color-brand:      #D65A3C; /* oxide accent */
  --color-brand-dark: #C24A2E;
  --color-ok:         #8CB878;
  --color-success:    #8CB878;
  --color-warning:    #D9A644;
  --color-amber:      #D9A644;
  --color-danger:     #D65A3C;
}

/* Tailwind theme bridge */
@theme {
  --font-serif: var(--font-serif);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --color-canvas:    var(--color-canvas);
  --color-panel:     var(--color-panel);
  --color-panel-alt: var(--color-panel-alt);
  --color-border:    var(--color-border);
  --color-ink-950:   var(--color-ink-950);
  --color-ink-700:   var(--color-ink-700);
  --color-ink-500:   var(--color-ink-500);
  --color-brand:     var(--color-brand);
  --color-success:   var(--color-success);
  --color-danger:    var(--color-danger);
  /* legacy aliases so existing EJS classes still compile */
  --color-ink-300:   var(--color-ink-300);
  --color-line:      var(--color-border);
}
```

Notes on what was deleted vs. kept: `--grad-brand`, `--grad-canvas`, and `--color-brand-glow` are dropped entirely (no gradients/glow anywhere in this theme). Every later task that referenced them (buttons, avatars, chat bubbles) is rewritten in its own task to use flat colors instead.

- [ ] **Step 2: Verify the build**

Run: `npm run build:css`
Expected: exits 0, `public/styles/admin.css` is regenerated with no Tailwind errors (a leftover `var(--grad-brand)`/`var(--color-brand-glow)` reference anywhere else in the file at this point is fine — those rules are rewritten in Tasks 3–7; this step only confirms the token block itself compiles).

- [ ] **Step 3: Run the existing suite**

Run: `npm test`
Expected: all tests still pass — this task only changes CSS custom property *values*, not any selector or markup the tests inspect.

- [ ] **Step 4: Commit**

```bash
git add assets/styles/admin.css
git commit -m "style: replace admin theme tokens with Bureau Ledger palette"
```

---

## Task 2: Fonts and dark-default theme script

**Files:**
- Modify: `views/layout-head.ejs:7-23`
- Modify: `views/login.ejs:7-9`

**Interfaces:**
- Consumes: `.dark` class toggling contract (`document.documentElement.classList`) — unchanged from current code.
- Produces: page `<head>` now loads Newsreader/Archivo/Spline Sans Mono instead of Outfit/JetBrains Mono; dark is the fallback theme when no `localStorage` preference is stored.

- [ ] **Step 1: Update `layout-head.ejs` font links and default-theme script**

Replace `views/layout-head.ejs:7-23` with:

```html
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400;1,6..72,500&family=Archivo:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/styles/admin.css">
  <!-- TOAST UI Editor Style -->
  <link rel="stylesheet" href="https://uicdn.toast.com/editor/3.2.2/toastui-editor.min.css" />
  <script>
    // Initialize theme before layout renders to avoid flicker.
    // Ink (dark) is the default theme; Paper (light) only applies when
    // explicitly stored or explicitly preferred by the OS AND never overridden.
    (function() {
      var stored = localStorage.getItem('color-theme');
      var dark = stored ? stored === 'dark' : true;
      document.documentElement.classList.toggle('dark', dark);
    })();
  </script>
```

- [ ] **Step 2: Update `login.ejs` font link**

Replace `views/login.ejs:7-9`:

```html
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400;1,6..72,500&family=Archivo:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

(This is only the `<link>` swap — the rest of `login.ejs` is rewritten wholesale in Task 10.)

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: pass — no markup this task touches is asserted on by tests.

- [ ] **Step 4: Commit**

```bash
git add views/layout-head.ejs views/login.ejs
git commit -m "style: load Bureau Ledger fonts and default to dark theme"
```

---

## Task 3: Button, status-glyph, and kicker components

**Files:**
- Modify: `assets/styles/admin.css` — button block (currently lines ~388–440), status-badge block (currently lines ~481–537)
- Add: `.kicker` component to `assets/styles/admin.css`
- Test: `tests/adminUi.test.js` (add one assertion)

**Interfaces:**
- Produces: `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger` (restyled, same class names), `.status-badge` + `.status-active/muted/error/syncing` (restyled with `::before` glyph, same class names and literal text content), `.kicker` (new).
- Consumes: `--color-*`, `--font-mono`, `--radius` from Task 1.

- [ ] **Step 1: Add a regression test locking literal status text**

The existing test `tests/adminUi.test.js` (line ~530) already asserts
`$('[data-repo-status] .status-badge').text().trim() === 'error'`. Add one more
assertion next to it confirming the class-based glyph approach doesn't touch
text content project-list-side too. Find this test:

```js
test('projects list shows a source sync badge per project', async () => {
```

Add after the existing `assert.strictEqual($('[data-project-sync]').first().text().trim(), 'success');` line:

```js
  // Glyphs are CSS ::before content, not DOM text — the raw status string
  // must still be the only text node inside the badge.
  assert.strictEqual($('[data-project-sync]').first().find('*').length, 0);
```

- [ ] **Step 2: Run it to confirm current behavior already satisfies the new assertion**

Run: `node --test tests/adminUi.test.js`
Expected: PASS (this assertion documents an existing invariant we must not break in Step 3 — it's a guard rail, not new behavior).

- [ ] **Step 3: Rewrite the button block**

Replace the `/* ── Buttons ── */` block in `assets/styles/admin.css` (currently
`.btn` through `.inline-form`) with:

```css
  /* ── Buttons ── */
  .btn {
    display: inline-flex;
    min-height: 2.25rem;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    border-radius: var(--radius);
    border: 1px solid transparent;
    padding: 0 0.875rem;
    font-family: var(--font-sans);
    font-size: 0.8125rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    cursor: pointer;
    transition: opacity 0.15s, border-color 0.15s;
    text-decoration: none;
  }

  .btn:active { opacity: 0.8; }

  .btn-primary {
    background: var(--color-ink-950);
    color: var(--color-canvas);
    border-color: var(--color-ink-950);
  }
  .btn-primary:hover { opacity: 0.88; }

  .btn-secondary {
    background: transparent;
    border-color: var(--color-border-strong);
    color: var(--color-ink-500);
  }
  .btn-secondary:hover {
    color: var(--color-ink-950);
    border-color: var(--color-ink-950);
  }

  .btn-danger {
    background: transparent;
    border-color: color-mix(in srgb, var(--color-danger) 40%, transparent);
    color: var(--color-danger);
  }
  .btn-danger:hover {
    border-color: var(--color-danger);
  }

  .inline-form { display: inline-flex; }
```

- [ ] **Step 4: Rewrite the status-badge block**

Replace the `/* ── Status badges ── */` block (`.status-badge` through the
`pulse-dot` keyframes usage on `.status-syncing`) with:

```css
  /* ── Status glyphs (no pill, no border — Bureau Ledger) ── */
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4375rem;
    font-family: var(--font-mono);
    font-size: 0.75rem;
    letter-spacing: 0.02em;
  }
  .status-badge::before {
    content: '';
    display: inline-block;
    font-size: 0.9em;
    line-height: 1;
  }

  .status-active { color: var(--color-ok); }
  .status-active::before { content: '\25CF'; } /* ● */

  .status-muted { color: var(--color-ink-300); }
  .status-muted::before { content: '\25CB'; } /* ○ */

  .status-error { color: var(--color-danger); }
  .status-error::before { content: '\2715'; } /* ✕ */

  .status-syncing { color: var(--color-amber); }
  .status-syncing::before {
    content: '\25C6'; /* ◆ */
    animation: pulse-dot 1.2s ease-in-out infinite;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.35; }
  }
```

- [ ] **Step 5: Add the `.kicker` component**

Add immediately after the status-badge block:

```css
  /* ── Kicker (section labels, breadcrumbs, meta notes) ── */
  .kicker {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-ink-300);
  }
  .kicker-amber { color: var(--color-amber); }
  .kicker a { color: inherit; text-decoration: none; }
  .kicker a:hover { color: var(--color-brand); }
```

- [ ] **Step 6: Run the test and the full suite**

Run: `node --test tests/adminUi.test.js`
Expected: PASS (the Step 1 assertion and every pre-existing assertion in the file).

Run: `npm test`
Expected: all pass. Run: `npm run build:css` — expected exit 0.

- [ ] **Step 7: Commit**

```bash
git add assets/styles/admin.css tests/adminUi.test.js
git commit -m "style: rebuild buttons and status badges as invert-fill/glyph components"
```

---

## Task 4: Panel, table, and error-box components

**Files:**
- Modify: `assets/styles/admin.css` — `.panel`/`.panel-body` block, `.table-shell`/`.data-table` block, `.error`/`.error-list` block, `.empty-state` block

**Interfaces:**
- Produces: `.panel`, `.panel-body`, `.table-shell`, `.data-table`, `.error`, `.error-list`, `.empty-state` (all same class names, restyled).
- Consumes: tokens from Task 1.

- [ ] **Step 1: Rewrite the panel block**

```css
  /* ── Panels ── */
  .panel {
    border-radius: var(--radius);
    border: 1px solid var(--color-border);
    background: var(--color-panel);
  }

  .panel-body {
    padding: 1.25rem;
  }

  @media (min-width: 640px) { .panel-body { padding: 1.5rem; } }

  .panel-metric { cursor: default; }
```

(The `.accent-*` metric-bar classes and `.panel:hover` lift are removed — the
new dashboard metrics are hairline-divided columns, not bordered cards; Task
11 stops using `.accent-*`/`.panel-metric` on the dashboard entirely, but the
classes are left harmless/no-op here rather than deleted, since nothing else
in this task references them.)

- [ ] **Step 2: Rewrite the table block**

```css
  /* ── Tables ── */
  .table-shell {
    overflow: hidden;
    border-radius: var(--radius);
    border: 1px solid var(--color-border);
    background: var(--color-panel);
  }

  .table-scroll { overflow-x: auto; }

  .data-table {
    min-width: 100%;
    text-align: left;
    font-family: var(--font-sans);
    font-size: 0.8125rem;
    border-collapse: collapse;
  }

  .data-table thead {
    border-bottom: 1px solid var(--color-border);
  }

  .data-table thead th {
    padding: 0.625rem 1rem;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-ink-300);
  }

  .data-table td {
    padding: 0.75rem 1rem;
    vertical-align: top;
    color: var(--color-ink-700);
    border-bottom: 1px solid var(--color-border);
  }

  .data-table tbody tr:last-child td { border-bottom: none; }

  .data-table .num { text-align: right; font-family: var(--font-mono); }
  .data-table .emphasis { font-family: var(--font-serif); font-size: 1rem; color: var(--color-ink-950); }
```

- [ ] **Step 3: Rewrite the error block**

```css
  /* ── Alerts ── */
  .error {
    border-radius: var(--radius);
    border: 1px solid color-mix(in srgb, var(--color-danger) 45%, transparent);
    background: transparent;
    padding: 0.875rem 1rem;
    font-size: 0.8125rem;
    color: var(--color-ink-700);
  }
  .error > p:first-child {
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-danger);
  }

  .error-list {
    margin-top: 0.5rem;
    list-style: none;
    padding-left: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .error-list li::before { content: '\2014\0020'; color: var(--color-danger); } /* "— " */
```

- [ ] **Step 4: Rewrite the empty-state block**

```css
  /* ── Empty state ── */
  .empty-state {
    border-radius: var(--radius);
    border: 1px dashed var(--color-border-strong);
    background: var(--color-panel);
    padding: 3.5rem 1.5rem;
    text-align: center;
  }
```

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: all pass — `.error-list`, `.panel-body`, `.table-shell` class names
are unchanged, and the test suite only checks for their presence/`li` text
content, not their CSS.

Run: `npm run build:css` — expected exit 0.

- [ ] **Step 6: Commit**

```bash
git add assets/styles/admin.css
git commit -m "style: rebuild panels, tables, and alerts as hairline ledger components"
```

---

## Task 5: Form fields, tab-bar, and segmented control

**Files:**
- Modify: `assets/styles/admin.css` — base-layer form control rules (currently lines ~123–176)
- Add: `.tab-bar`/`.tab-item`/`.tab-item-active`, `.segmented` to `assets/styles/admin.css`

**Interfaces:**
- Produces: restyled `input[type=text|password|url|number]`, `textarea`, `select`; new `.tab-bar`, `.tab-item`, `.tab-item-active`, `.tab-count`; new `.segmented`, `.segmented-option`, `.segmented-option input:checked + span`.
- Consumes: tokens from Task 1. Consumed by: Task 7 (project-form tabs), Task 15 (repo auth-type segmented control), Task 18 (workspace tab bar).

- [ ] **Step 1: Rewrite base form-control rules**

Replace `assets/styles/admin.css:123-176` (label + form-control rules) with:

```css
  label {
    display: block;
    font-family: var(--font-sans);
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-ink-500);
  }

  /* Form controls */
  input[type="text"],
  input[type="password"],
  input[type="url"],
  input[type="number"],
  textarea,
  select {
    margin-top: 0.5rem;
    width: 100%;
    border-radius: var(--radius);
    border: 1px solid var(--color-border-strong);
    background: var(--color-panel-alt);
    padding: 0.5625rem 0.75rem;
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    color: var(--color-ink-950);
    transition: border-color 0.15s;
    outline: none;
  }

  input[type="text"]:focus,
  input[type="password"]:focus,
  input[type="url"]:focus,
  input[type="number"]:focus,
  textarea:focus,
  select:focus {
    border-color: var(--color-brand);
  }

  textarea {
    min-height: 8rem;
    line-height: 1.6;
    resize: vertical;
  }

  select {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3E%3Cpath stroke='%2398917E' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.625rem center;
    background-size: 1.1em;
    padding-right: 2.25rem;
    appearance: none;
    font-family: var(--font-sans);
  }
```

- [ ] **Step 2: Add `.tab-bar`**

Append to the components layer in `assets/styles/admin.css`:

```css
  /* ── Tab bar (project-form tabs, workspace tabs) ── */
  .tab-bar {
    display: flex;
    align-items: baseline;
    gap: 1.75rem;
    border-bottom: 1px solid var(--color-border);
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
  }

  .tab-item {
    padding: 0.875rem 0 0.75rem;
    margin-bottom: -1px;
    border-bottom: 2px solid transparent;
    font-family: var(--font-sans);
    font-size: 0.8125rem;
    color: var(--color-ink-500);
    text-decoration: none;
    background: none;
    border-top: none;
    border-left: none;
    border-right: none;
    cursor: pointer;
  }

  .tab-item-active {
    border-bottom-color: var(--color-brand);
    color: var(--color-ink-950);
    font-weight: 600;
  }

  .tab-count {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--color-ink-300);
    margin-left: 0.25rem;
  }

  .tab-bar-note {
    margin-left: auto;
    padding: 0.875rem 0 0.75rem;
  }
```

- [ ] **Step 3: Add `.segmented`**

```css
  /* ── Segmented control (radio-based, no JS required for styling) ── */
  .segmented {
    display: flex;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius);
    overflow: hidden;
    margin-top: 0.5rem;
  }

  .segmented-option {
    flex: 1;
    position: relative;
  }

  .segmented-option input {
    position: absolute;
    opacity: 0;
    inset: 0;
    margin: 0;
    cursor: pointer;
  }

  .segmented-option span {
    display: block;
    text-align: center;
    padding: 0.5625rem 0;
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    color: var(--color-ink-500);
    border-left: 1px solid var(--color-border-strong);
  }
  .segmented-option:first-child span { border-left: none; }

  .segmented-option input:checked + span {
    background: var(--color-border);
    color: var(--color-ink-950);
  }

  .segmented-option input:focus-visible + span {
    outline: 2px solid var(--color-brand);
    outline-offset: -2px;
  }
```

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: all pass (no markup changed yet — `.tab-bar`/`.segmented` are unused
until Tasks 7/15/18 wire them into EJS).

Run: `npm run build:css` — expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add assets/styles/admin.css
git commit -m "style: add form-field restyle, tab-bar, and segmented-control components"
```

---

## Task 6: TOAST UI Editor and markdown code-block theming (both modes)

**Files:**
- Modify: `assets/styles/admin.css:803-855` (TOAST UI dark-mode overrides)

**Interfaces:**
- Produces: `.toastui-editor-*` overrides scoped under both `:root` (light) and `.dark` (dark) instead of `.dark`-only; `.chat-bubble-agent pre` recolored.

- [ ] **Step 1: Replace the TOAST UI override block**

Replace `assets/styles/admin.css:803-855` (everything from
`/* TOAST UI Editor Dark Mode */` to the end of the file) with:

```css
/* ============================================================
   TOAST UI Editor — Bureau Ledger theming (both modes)
   ============================================================ */
.toastui-editor-defaultUI {
  border-color: var(--color-border) !important;
  background-color: var(--color-panel-alt) !important;
  border-radius: var(--radius) !important;
}
.toastui-editor-toolbar {
  background-color: var(--color-panel-alt) !important;
  border-bottom: 1px solid var(--color-border) !important;
}
.toastui-editor-toolbar .toastui-editor-button {
  color: var(--color-ink-500) !important;
  border-color: transparent !important;
}
.toastui-editor-toolbar .toastui-editor-button:hover {
  background-color: var(--color-border) !important;
}
.toastui-editor-main {
  background-color: var(--color-panel-alt) !important;
}
.toastui-editor-main-tab {
  background-color: var(--color-panel-alt) !important;
  border-bottom: 1px solid var(--color-border) !important;
}
.toastui-editor-main-tab .toastui-editor-tabs .tab-item.active {
  background-color: var(--color-panel-alt) !important;
  border-color: var(--color-border) !important;
  color: var(--color-brand) !important;
}
.toastui-editor-editor,
.toastui-editor-md-preview {
  background-color: var(--color-panel-alt) !important;
  color: var(--color-ink-950) !important;
  font-family: var(--font-mono) !important;
}
.toastui-editor-contents { color: var(--color-ink-700) !important; }
.toastui-editor-contents p,
.toastui-editor-contents h1,
.toastui-editor-contents h2,
.toastui-editor-contents h3,
.toastui-editor-contents h4,
.toastui-editor-contents h5,
.toastui-editor-contents h6 { color: var(--color-ink-950) !important; }
.toastui-editor-ww-container,
.toastui-editor-md-container {
  background-color: var(--color-panel-alt) !important;
}
.toastui-editor-md-tab-container,
.toastui-editor-ww-tab-container {
  background-color: var(--color-panel-alt) !important;
}
.ProseMirror { color: var(--color-ink-950) !important; }

/* ============================================================
   Markdown-rendered code blocks (chat, conversation detail)
   ============================================================ */
.chat-bubble-agent pre,
.msg-content pre {
  overflow-x: auto;
  padding: 0.75rem;
  border-radius: var(--radius);
  background: var(--color-panel-alt);
  color: var(--color-ink-700);
  margin: 0.5rem 0;
  border: 1px solid var(--color-border);
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}
```

- [ ] **Step 2: Run the suite**

Run: `npm test`
Expected: all pass (this task only changes CSS on classes injected by a
third-party library and rendered markdown; no test asserts on these).

Run: `npm run build:css` — expected exit 0.

- [ ] **Step 3: Commit**

```bash
git add assets/styles/admin.css
git commit -m "style: theme TOAST UI editor and markdown code blocks for both modes"
```

---

## Task 7: Layout shell — sidebar (`index`) vs breadcrumb (`detail`) modes

**Files:**
- Modify: `views/layout-head.ejs` (full rewrite of the shell markup, lines 25–124)
- Modify: `views/layout-foot.ejs` (close the new shell structure)
- Modify: `assets/styles/admin.css` — add sidebar CSS, remove old topbar CSS
- Test: `tests/adminUi.test.js` (add shell-mode assertions)

**Interfaces:**
- Consumes: a local var `layoutShell` (`'index'` or `'detail'`, default `'detail'`) that each view sets via `<% const layoutShell = 'index' %>` **before** `<%- include('../layout-head') %>`. Also consumes `activeProjects` (array of `{id, slug, sync_status}`) for the sidebar's live project list when `layoutShell === 'index'` — passed in by the dashboard/list controllers (see Step 1 note on data).
- Produces: `.sidebar-shell`, `.sidebar`, `.sidebar-nav-item`, `.sidebar-nav-item-active`, `.sidebar-register`, `.sidebar-foot`, `.detail-breadcrumb` — new classes later tasks style content inside.

- [ ] **Step 1: Decide the data source for the sidebar project list without touching controllers**

`layout-head.ejs` is included by every admin view; it does not have direct DB
access. Rather than adding a new controller dependency (out of scope per the
Global Constraints — no controller changes), the sidebar project list reuses
`typeof sidebarProjects !== 'undefined' ? sidebarProjects : []` and renders
nothing if the calling view didn't pass it. Task 11 (dashboard) and Task 13
(projects list) — the only two views that use the `index` shell — already
have the full project list in scope (`dashboard/index.ejs` already receives
`allProjects`; `projects/list.ejs` already receives `projects`), so those
tasks pass `sidebarProjects: allProjects` / `sidebarProjects: projects` into
the `layout-head` include. No controller changes needed.

- [ ] **Step 2: Rewrite `layout-head.ejs` body markup**

Replace `views/layout-head.ejs:25-124` (from `<body>` to the `<main
class="app-container">` line) with:

```html
<body>
<div class="app-shell">
<% var _shell = typeof layoutShell !== 'undefined' ? layoutShell : 'detail'; %>
<% var _sidebarProjects = typeof sidebarProjects !== 'undefined' ? sidebarProjects : []; %>

<% if (_shell === 'index') { %>
  <div class="sidebar-shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div style="font-family:var(--font-serif);font-size:1.1875rem;font-weight:500;line-height:1.1">
          OpenTraceBridge<span style="color:var(--color-brand)">.</span>
        </div>
        <div class="kicker" style="margin-top:0.3125rem">Admin console — private</div>
      </div>

      <nav class="sidebar-nav" aria-label="Primary navigation">
        <a id="nav-dashboard" class="sidebar-nav-item" href="/admin/dashboard">
          <span class="kicker" style="width:1.25rem">01</span><span>Dashboard</span>
        </a>
        <a id="nav-projects" class="sidebar-nav-item" href="/admin/projects">
          <span class="kicker" style="width:1.25rem">02</span><span>Projects</span>
        </a>
      </nav>

      <% if (_sidebarProjects.length) { %>
        <div class="kicker" style="padding:1.5rem 1.25rem 0.5rem">Register — <%= _sidebarProjects.length %></div>
        <div class="sidebar-register">
          <% _sidebarProjects.forEach(function(p) { %>
            <div class="sidebar-register-item">
              <span class="status-badge status-<%=
                p.sync_status === 'success' ? 'active' :
                p.sync_status === 'error' ? 'error' :
                p.sync_status === 'syncing' || p.sync_status === 'pending' ? 'syncing' : 'muted'
              %>"></span>
              <span><%= p.slug %></span>
            </div>
          <% }); %>
        </div>
      <% } %>

      <div class="sidebar-foot">
        <button id="theme-toggle" type="button">
          <span id="theme-toggle-label">◐ Dark — switch to light</span>
        </button>
        <form method="post" action="/admin/logout">
          <button type="submit">← Log out</button>
        </form>
      </div>
    </aside>

    <main class="app-container">
<% } else { %>
    <main class="app-container">
<% } %>
```

- [ ] **Step 3: Rewrite the theme-toggle / nav-active script**

Replace the existing `<script>` block that follows (the one wiring
`theme-toggle`, `icon-sun`/`icon-moon`, and active-nav detection) with:

```html
      <script>
        document.addEventListener('DOMContentLoaded', function() {
          var isDark = document.documentElement.classList.contains('dark');
          var btn = document.getElementById('theme-toggle');
          var label = document.getElementById('theme-toggle-label');

          function applyLabel(dark) {
            if (label) label.textContent = dark ? '◐ Dark — switch to light' : '◑ Light — switch to dark';
          }
          applyLabel(isDark);

          if (btn) {
            btn.addEventListener('click', function() {
              isDark = !isDark;
              document.documentElement.classList.toggle('dark', isDark);
              localStorage.setItem('color-theme', isDark ? 'dark' : 'light');
              applyLabel(isDark);
            });
          }

          var path = window.location.pathname;
          var navDashboard = document.getElementById('nav-dashboard');
          var navProjects  = document.getElementById('nav-projects');
          if (navDashboard && path.startsWith('/admin/dashboard')) {
            navDashboard.classList.add('sidebar-nav-item-active');
          } else if (navProjects && (path.startsWith('/admin/projects') || path.startsWith('/admin/conversations'))) {
            navProjects.classList.add('sidebar-nav-item-active');
          }
        });
      </script>
```

Note: this task only builds the sidebar shell. The `detail` shell's
breadcrumb (`← Projects / Edit entry no. 01`) is added per-page in Tasks
14/18/21 via a `.detail-breadcrumb` `.kicker` line each view renders itself
right before its `.page-title`, since the breadcrumb text is page-specific
("← Projects / Edit entry", "← Payments API / Audit", etc.) and doesn't
belong in the shared shell partial.

- [ ] **Step 4: Update `layout-foot.ejs`**

Replace `views/layout-foot.ejs` entirely:

```html
  </main>
  <% if (typeof layoutShell !== 'undefined' && layoutShell === 'index') { %></div><% } %>
</div>
</body>
</html>
```

- [ ] **Step 5: Add sidebar CSS, remove old topbar CSS**

In `assets/styles/admin.css`, replace the `/* ── Topbar ── */` through
`/* ── Page header typography ── */` blocks (the `.topbar`, `.topbar-inner`,
`.brand-mark`, `.nav-link`, `.nav-link-active` rules) with:

```css
  .app-shell {
    min-height: 100vh;
    background: var(--color-canvas);
  }

  .app-container {
    margin: 0 auto;
    width: 100%;
    max-width: 72rem;
    padding: 2rem 2.5rem;
  }

  /* ── Sidebar shell (index pages: Dashboard, Projects) ── */
  .sidebar-shell {
    display: flex;
    min-height: 100vh;
  }

  .sidebar {
    width: 216px;
    flex: none;
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    padding: 1.5rem 0 1rem;
  }

  .sidebar-brand {
    padding: 0 1.25rem 1.375rem;
    border-bottom: 1px solid var(--color-border);
  }

  .sidebar-nav {
    padding: 1rem 0 0;
    display: flex;
    flex-direction: column;
  }

  .sidebar-nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5625rem 1.25rem;
    border-left: 2px solid transparent;
    font-family: var(--font-sans);
    font-size: 0.8125rem;
    color: var(--color-ink-500);
    text-decoration: none;
  }

  .sidebar-nav-item-active {
    border-left-color: var(--color-brand);
    background: color-mix(in srgb, var(--color-brand) 6%, transparent);
    color: var(--color-ink-950);
    font-weight: 600;
  }
  .sidebar-nav-item-active .kicker { color: var(--color-brand); }

  .sidebar-register {
    display: flex;
    flex-direction: column;
  }

  .sidebar-register-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 1.25rem;
    font-family: var(--font-mono);
    font-size: 0.71875rem;
    color: var(--color-ink-500);
  }
  .sidebar-register-item .status-badge { font-size: 0.5rem; }

  .sidebar-foot {
    margin-top: auto;
    border-top: 1px solid var(--color-border);
    padding: 0.75rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .sidebar-foot button {
    background: none;
    border: none;
    padding: 0;
    font-family: var(--font-sans);
    font-size: 0.75rem;
    color: var(--color-ink-500);
    text-align: left;
    cursor: pointer;
  }
  .sidebar-foot button:hover { color: var(--color-ink-950); }
  .sidebar-foot form button { color: var(--color-danger); opacity: 0.85; }

  /* ── Page header typography ── */
```

(Leave the existing `.page-kicker`/`.page-title`/`.page-subtitle` rules in
place immediately after — they're restyled in Step 6, not removed.)

- [ ] **Step 6: Retype page-header typography to serif/mono**

Replace the `.page-kicker`/`.page-title`/`.page-subtitle`/`.section-heading`
rules with:

```css
  .page-kicker {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-ink-300);
  }

  .page-title {
    margin-top: 0.375rem;
    font-family: var(--font-serif);
    font-size: 2.125rem;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--color-ink-950);
    line-height: 1.15;
  }

  .page-subtitle {
    margin-top: 0.5rem;
    max-width: 48rem;
    font-family: var(--font-sans);
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--color-ink-500);
  }

  .section-heading {
    font-family: var(--font-sans);
    font-size: 0.875rem;
    font-weight: 700;
    color: var(--color-ink-950);
    letter-spacing: -0.01em;
  }
```

- [ ] **Step 7: Add shell-mode assertions to the test suite**

Since neither `dashboard/index.ejs` nor `projects/list.ejs` sets
`layoutShell` yet (that happens in Tasks 11/13), the shell defaults to
`detail` for every page right now — verify that explicitly so this task is
independently testable. Add to `tests/adminUi.test.js`:

```js
test('layout defaults to the detail shell (no sidebar) until a page opts into index', async () => {
  seedProject();
  const page = await agent.get('/admin/projects').expect(200);
  const $ = cheerio.load(page.text);
  assert.strictEqual($('.sidebar-shell').length, 0);
  assert.strictEqual($('.app-shell > .app-container').length, 1);
});
```

- [ ] **Step 8: Run it, then the full suite**

Run: `node --test tests/adminUi.test.js`
Expected: the new test PASSes. Watch for failures in `'admin layout links the
compiled Tailwind stylesheet and serves it'` (asserts `/\.app-shell|\.btn|\.panel/`
against the compiled CSS — still true) and any test relying on the old
`.topbar`/`nav-link` markup (none do, per the earlier audit).

Run: `npm test`
Expected: all pass.

Run: `npm run build:css` — expected exit 0.

- [ ] **Step 9: Commit**

```bash
git add views/layout-head.ejs views/layout-foot.ejs assets/styles/admin.css tests/adminUi.test.js
git commit -m "feat: add two-mode layout shell (sidebar index / breadcrumb detail)"
```

---

## Task 8: Dashboard metrics ledger row and range-picker links

**Files:**
- Modify: `views/dashboard/index.ejs:1-91` (header + metric cards + shell opt-in)
- Test: `tests/dashboard.test.js` (add range-link assertion)

**Interfaces:**
- Consumes: `.sidebar-shell` from Task 7, `.data-table`/`.kicker` components. `layoutShell`/`sidebarProjects` locals from Task 7.
- Produces: no change to controller-supplied `totals`/`chart`/`perProject`/`allProjects`/`days`/`filterProjectId` variables — same data, new markup.

- [ ] **Step 1: Opt into the `index` shell**

At the very top of `views/dashboard/index.ejs`, before the layout-head
include, add:

```html
<% const layoutShell = 'index'; const sidebarProjects = allProjects; %>
<%- include('../layout-head') %>
```

Replacing the current line 1 (`<%- include('../layout-head') %>`).

- [ ] **Step 2: Rewrite the header and range picker**

Replace `views/dashboard/index.ejs:3-24` with:

```html
<section style="margin-bottom:2rem;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--color-border);padding-bottom:1.125rem">
  <div>
    <p class="kicker">System ledger</p>
    <h1 class="page-title">The week in <em style="font-style:italic;color:var(--color-brand)">numbers</em></h1>
  </div>
  <div style="display:flex;align-items:baseline;gap:1.25rem;flex-wrap:wrap">
    <div style="display:flex;gap:0.875rem;font-family:var(--font-mono);font-size:0.71875rem">
      <% [7, 30, 90].forEach(function(d) { %>
        <a href="?days=<%= d %><%= filterProjectId ? '&project=' + filterProjectId : '' %>"
           style="text-decoration:none;padding-bottom:0.1875rem;<%= days === d
             ? 'color:var(--color-ink-950);border-bottom:2px solid var(--color-brand)'
             : 'color:var(--color-ink-300)' %>"><%= d %>D</a>
      <% }); %>
    </div>
    <form method="get" style="display:flex">
      <input type="hidden" name="days" value="<%= days %>">
      <select name="project" onchange="this.form.submit()" style="width:12rem;margin-top:0">
        <option value="">All projects ▾</option>
        <% allProjects.forEach(function(p) { %>
          <option value="<%= p.id %>" <%= filterProjectId === p.id ? 'selected' : '' %>><%= p.name %></option>
        <% }); %>
      </select>
    </form>
  </div>
</section>
```

- [ ] **Step 3: Rewrite the metric row**

Replace `views/dashboard/index.ejs:26-91` (the `<!-- Metric Cards -->`
section) with:

```html
<!-- Metric ledger row -->
<section style="margin-bottom:1.5rem;display:grid;grid-template-columns:repeat(2,1fr);border-bottom:1px solid var(--color-border)">
  <style>
    @media(min-width:640px){#metric-grid{grid-template-columns:repeat(3,1fr)}}
    @media(min-width:1024px){#metric-grid{grid-template-columns:repeat(6,1fr)}}
  </style>
  <div id="metric-grid" style="display:contents">

    <% function metricCell(kicker, value, trend, trendGood) { %>
    <% } %>

    <div style="padding:1.25rem 1.125rem 1.125rem 0;border-right:1px solid var(--color-border)">
      <p class="kicker">Questions</p>
      <p style="margin-top:0.625rem;font-family:var(--font-serif);font-size:2rem;font-weight:500;line-height:1;color:var(--color-ink-950)"><%= totals.questions.toLocaleString() %></p>
      <p style="margin-top:0.5rem;font-family:var(--font-mono);font-size:0.65625rem;color:var(--color-ok)">+12% W/W</p>
    </div>

    <div style="padding:1.25rem 1.125rem;border-right:1px solid var(--color-border)">
      <p class="kicker">Avg response</p>
      <p style="margin-top:0.625rem;font-family:var(--font-serif);font-size:2rem;font-weight:500;line-height:1;color:var(--color-ink-950)">
        <%= totals.totalRuns ? Math.round(perProject.reduce((a,r)=>a+(r.avgDurationMs||0)*r.totalRuns,0)/totals.totalRuns).toLocaleString()+'ms' : 'n/a' %>
      </p>
    </div>

    <div style="padding:1.25rem 1.125rem;border-right:1px solid var(--color-border)">
      <p class="kicker">Error rate</p>
      <p style="margin-top:0.625rem;font-family:var(--font-serif);font-size:2rem;font-weight:500;line-height:1;color:<%= totals.totalRuns && (100*totals.errorRuns/totals.totalRuns) > 0 ? 'var(--color-danger)' : 'var(--color-ink-950)' %>">
        <%= totals.totalRuns ? (100*totals.errorRuns/totals.totalRuns).toFixed(1)+'%' : 'n/a' %>
      </p>
    </div>

    <div style="padding:1.25rem 1.125rem;border-right:1px solid var(--color-border)">
      <p class="kicker">API calls</p>
      <p style="margin-top:0.625rem;font-family:var(--font-serif);font-size:2rem;font-weight:500;line-height:1;color:var(--color-ink-950)"><%= totals.apiCallCount.toLocaleString() %></p>
    </div>

    <div style="padding:1.25rem 1.125rem;border-right:1px solid var(--color-border)">
      <p class="kicker">Tokens</p>
      <p style="margin-top:0.625rem;font-family:var(--font-serif);font-size:2rem;font-weight:500;line-height:1;color:var(--color-ink-950)">
        <%= (totals.totalTokensInput+totals.totalTokensOutput) ? (totals.totalTokensInput+totals.totalTokensOutput).toLocaleString() : 'n/a' %>
      </p>
      <p style="margin-top:0.5rem;font-family:var(--font-mono);font-size:0.65625rem;color:var(--color-ink-300)">IN <%= totals.totalTokensInput.toLocaleString() %> / OUT <%= totals.totalTokensOutput.toLocaleString() %></p>
    </div>

    <div style="padding:1.25rem 0 1.125rem 1.125rem">
      <p class="kicker">Total cost</p>
      <p style="margin-top:0.625rem;font-family:var(--font-serif);font-size:2rem;font-weight:500;line-height:1;color:var(--color-ink-950)">
        <%= totals.totalCostUsd ? '$'+totals.totalCostUsd.toFixed(4) : 'n/a' %>
      </p>
    </div>

  </div><!-- /metric-grid -->
</section>
```

Remove the leftover unused `<% function metricCell(...) { %><% } %>` stub —
it was a false start; delete those two lines before committing.

- [ ] **Step 4: Add a regression test for the range-picker links**

Add to `tests/dashboard.test.js`:

```js
test('dashboard range picker renders as links, not a select', async () => {
  seedProject();
  const page = await agent.get('/admin/dashboard?days=30').expect(200);
  const $ = cheerio.load(page.text);
  assert.strictEqual($('select[name="days"]').length, 0);
  assert.strictEqual($('a[href="?days=7"]').length, 1);
  assert.strictEqual($('a[href="?days=30"]').length, 1);
  assert.strictEqual($('a[href="?days=90"]').length, 1);
});
```

Add `cheerio.load(...)` is already imported at the top of the file — no new
import needed.

- [ ] **Step 5: Run it, then the existing dashboard tests**

Run: `node --test tests/dashboard.test.js`
Expected: all PASS, including the pre-existing
`'dashboard renders stat cards and respects the days filter'` (still greps
for `/Questions/`, `/Error rate/`, `/API calls/`, `/Payment/` — all still
literal substrings in the new markup) and
`'dashboard shows n/a for projects with no runs yet'` (`/n\/a/` still present).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add views/dashboard/index.ejs tests/dashboard.test.js
git commit -m "feat: rebuild dashboard metrics as a hairline ledger row with link-based range picker"
```

---

## Task 9: Dashboard chart — remove gradient/glow, single-accent peak

**Files:**
- Modify: `views/dashboard/index.ejs` (the `<!-- Chart -->` section, now shifted down by Task 8's edits — locate by the `<!-- Chart -->` comment)

**Interfaces:**
- Consumes: the same `chart` array and `pathD`/`areaD`/`getX`/`getY` computation already in the file — only the `<svg>` markup and its `<defs>` change, not the geometry math.

- [ ] **Step 1: Rewrite the chart panel wrapper**

Change the section's opening tag from `<section class="panel panel-body"
style="margin-bottom:1.5rem">` to `<section style="margin-bottom:1.5rem;
padding-top:1.375rem;border-top:1px solid var(--color-border)">` (drop the
`.panel`/`.panel-body` bordered-card treatment — the chart now sits directly
in the page flow under a hairline rule, per the mock).

- [ ] **Step 2: Rewrite the section header (drop the gradient legend swatch)**

Replace:

```html
    <div style="display:flex;align-items:center;gap:0.5rem;font-size:0.75rem;color:var(--color-ink-500)">
      <span style="display:inline-block;width:0.75rem;height:0.1875rem;border-radius:9999px;background:linear-gradient(90deg,#4f6ef7,#7c3aed)"></span>
      Questions / day
    </div>
```

with:

```html
    <div class="kicker">Peak <%= chart.length ? Math.max(...chart.map(r=>r.count)) : 0 %></div>
```

- [ ] **Step 3: Remove gradient/glow `<defs>`, redraw the line and dots**

Replace the `<defs>` block (the two `<linearGradient>`s and the `<filter
id="glow">`) with just the clip path:

```html
      <defs>
        <clipPath id="chart-clip">
          <rect x="<%= PL %>" y="<%= PT %>" width="<%= CW %>" height="<%= CH %>"/>
        </clipPath>
      </defs>
```

Replace the area-fill and line-stroke `<path>` elements:

```html
      <!-- Line, no fill, no glow -->
      <path d="<%= pathD %>" fill="none"
            stroke="var(--color-ink-950)" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round"
            clip-path="url(#chart-clip)"/>
```

(Drop the `areaD` fill `<path>` entirely — the mock's chart has no area fill,
only a line. `areaD` stays computed in the EJS `<% %>` block above since
removing the computation isn't necessary and keeps the diff minimal, but the
`<path d="<%= areaD %>" ...>` element itself is deleted.)

Replace the per-point dot-drawing loop:

```html
      <!-- Points: small ink dots, one larger accent dot at the peak -->
      <% var _peak = chart.length ? Math.max(...chart.map(r=>r.count)) : null; %>
      <% chart.forEach(function(row, idx) { %>
        <% var x = getX(idx), y = getY(row.count); %>
        <% if (row.count === _peak) { %>
          <circle cx="<%= x %>" cy="<%= y %>" r="4" fill="var(--color-brand)"></circle>
          <text x="<%= x %>" y="<%= y - 12 %>" text-anchor="middle" font-family="Spline Sans Mono" font-size="10" fill="var(--color-brand)"><%= row.count %></text>
        <% } else { %>
          <circle cx="<%= x %>" cy="<%= y %>" r="2.5" fill="var(--color-canvas)" stroke="var(--color-ink-950)" stroke-width="1.5"></circle>
        <% } %>
      <% }); %>
```

- [ ] **Step 4: Recolor gridlines, axis text, and the hover dot**

Change every `stroke="var(--color-border)"` grid `<line>` — already token-
based, no change needed. Change axis `<text fill="var(--color-ink-500)"
.../>` — already token-based, no change needed.

In the hover-tooltip `<script>` block further down, change:

```js
        dot.setAttribute('r', '5.5');
        dot.setAttribute('fill', '#4f6ef7');
        dot.setAttribute('stroke', 'white');
```

to:

```js
        dot.setAttribute('r', '5.5');
        dot.setAttribute('fill', 'var(--color-brand)');
        dot.setAttribute('stroke', 'var(--color-canvas)');
```

and the matching `mouseleave` handler's:

```js
        dot.setAttribute('r', '3.5');
        dot.setAttribute('fill', 'white');
        dot.setAttribute('stroke', '#4f6ef7');
```

to:

```js
        dot.setAttribute('r', '2.5');
        dot.setAttribute('fill', 'var(--color-canvas)');
        dot.setAttribute('stroke', 'var(--color-ink-950)');
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/dashboard.test.js`
Expected: PASS — no test inspects SVG internals, only page-level text.

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Manual visual check**

This is the first genuinely visual task — no automated test can confirm the
chart *looks* right. Note for the final QA task (Task 22): verify the chart
renders a single ink-colored line with one accent dot at the peak, no
gradient fill, in both themes.

- [ ] **Step 7: Commit**

```bash
git add views/dashboard/index.ejs
git commit -m "style: strip gradient/glow from the dashboard chart, single accent peak dot"
```

---

## Task 10: Dashboard "by project" table restyle

**Files:**
- Modify: `views/dashboard/index.ejs` (the `<!-- Per-project table -->` section)

**Interfaces:**
- Consumes: `.data-table .num`/`.emphasis` from Task 4, `perProject` array (unchanged).

- [ ] **Step 1: Restyle the table header bar**

Replace the `<div style="padding:1rem 1.25rem;border-bottom:...">` header row
above the table with:

```html
<section>
  <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:0.75rem">
    <p class="section-heading">By project</p>
    <p class="kicker"><%= days %>-day window</p>
  </div>
```

(Drop the `.table-shell` wrapper's own header bar — the section title now
sits above the table, matching the mock's ledger-table pattern where the
table has no card chrome around it, just a top border.)

- [ ] **Step 2: Add `.num`/`.emphasis` classes to table cells**

In the `<table class="data-table">` body, change the numeric `<td>` elements
(Questions, Avg duration, API calls, Tokens, Cost) to include `class="num"`,
and the project-name `<td>`'s inner link to use `--font-serif`:

```html
          <td>
            <a href="/admin/projects/<%= row.project.id %>/conversations"
               class="emphasis" style="text-decoration:none;color:var(--color-ink-950)">
              <%= row.project.name %>
            </a>
            <div class="kicker" style="margin-top:0.125rem"><%= row.project.slug %></div>
          </td>
          <td class="num" style="color:var(--color-ink-950)"><%= row.questions.toLocaleString() %></td>
          <td class="num"><%= row.avgDurationMs != null ? Math.round(row.avgDurationMs).toLocaleString()+'ms' : 'n/a' %></td>
          <td class="num">
            <% if (row.totalRuns) {
                 const errPct = 100 * row.errorRate;
            %>
              <span class="status-badge <%= errPct > 20 ? 'status-error' : (errPct > 0 ? 'status-syncing' : 'status-active') %>">
                <%= errPct.toFixed(1) %>%
              </span>
            <% } else { %>
              <span style="color:var(--color-ink-300);font-size:0.8125rem">n/a</span>
            <% } %>
          </td>
          <td class="num"><%= row.apiCallCount.toLocaleString() %></td>
          <td class="num">
            <%= (row.totalTokensInput != null && row.totalTokensOutput != null) ? (row.totalTokensInput+row.totalTokensOutput).toLocaleString() : 'n/a' %>
          </td>
          <td class="num" style="color:var(--color-ok);font-weight:600">
            <%= row.totalCostUsd != null ? '$'+row.totalCostUsd.toFixed(4) : 'n/a' %>
          </td>
```

Keep the `colspan="7"` empty-row and `<thead>` cells as-is (already using
`.data-table` header styling from Task 4).

- [ ] **Step 3: Close the new wrapper**

Ensure the section wraps the `.table-scroll`/`table.data-table` block and
closes with `</section>` (replacing the old `.table-shell` closing `</div>`
if the wrapper element type changed from `<section class="table-shell">` —
keep `.table-shell`/`.table-scroll` classes on the inner scroll div so the
Task-1-established `assert.match(response.text, /table-shell/)` type checks
elsewhere in the suite (used on the Projects and Conversations pages, not
this one) are unaffected; this page never asserted `table-shell` itself, so
either wrapping choice is safe — keep `table-shell`/`table-scroll` on the
`<div>` immediately around `<table>` for visual consistency with other pages.

- [ ] **Step 4: Run tests**

Run: `node --test tests/dashboard.test.js`
Expected: PASS (`/Payment/`, `/Questions/`, `/Error rate/`, `/API calls/`,
`/n\/a/` all still literal substrings).

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add views/dashboard/index.ejs
git commit -m "style: restyle dashboard by-project table to the ledger table component"
```

---

## Task 11: Projects list restyle + icon removal

**Files:**
- Modify: `views/projects/list.ejs`

**Interfaces:**
- Consumes: `.sidebar-shell` (Task 7), `.data-table`/`.kicker`/`.btn-*` (Tasks 3–4). Same `projects` array, unchanged.

- [ ] **Step 1: Opt into the `index` shell**

Replace line 1 with:

```html
<% const layoutShell = 'index'; const sidebarProjects = projects; %>
<%- include('../layout-head') %>
```

- [ ] **Step 2: Rewrite the header (remove the `+` SVG icon)**

Replace `views/projects/list.ejs:7-17`:

```html
<section style="margin-bottom:1.5rem;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--color-border);padding-bottom:1.125rem">
  <div>
    <p class="kicker">Register · <%= projects.length %> entries</p>
    <h1 class="page-title">Projects</h1>
  </div>
  <a href="/admin/projects/new" class="btn btn-primary">New project</a>
</section>

<div style="display:flex;gap:2.25rem;padding:1rem 0;border-bottom:1px solid var(--color-border);margin-bottom:1.5rem;font-family:var(--font-mono);font-size:0.6875rem;color:var(--color-ink-300);flex-wrap:wrap">
  <span>EVENT ENDPOINT — <span style="color:var(--color-ink-500)">/api/events/:slug</span></span>
  <span>SCOPE — <span style="color:var(--color-ink-500)">single admin</span></span>
  <span>STORAGE — <span style="color:var(--color-ink-500)">sqlite</span></span>
</div>
```

(This drops the old "Quick stats" 3-card grid entirely — its content is
folded into the mono meta row above the table, matching mock `3c`.)

- [ ] **Step 3: Delete the "Quick stats" section**

Remove `views/projects/list.ejs:19-33` (the old `<!-- Quick stats -->`
`<section>`) — its content moved into Step 2's meta row.

- [ ] **Step 4: Restyle the empty state (remove gradient icon)**

Replace the empty-state `<section class="empty-state">` block:

```html
<% if (!projects.length) { %>
  <section class="empty-state">
    <div style="width:3.25rem;height:3.25rem;border:1px solid var(--color-border-strong);border-radius:var(--radius);display:flex;align-items:center;justify-content:center;margin:0 auto 1.25rem;font-family:var(--font-serif);font-size:1.25rem;color:var(--color-brand)">OT</div>
    <h2 style="font-family:var(--font-serif);font-size:1.125rem;font-weight:500;color:var(--color-ink-950)">No projects yet</h2>
    <p style="margin-top:0.5rem;font-size:0.8125rem;color:var(--color-ink-500)">Create your first project to start receiving Teams events and routing investigations.</p>
    <a href="/admin/projects/new" class="btn btn-primary" style="margin-top:1.5rem">New project</a>
  </section>
<% } else { %>
```

- [ ] **Step 5: Restyle the table (icon-less actions, bracketed keyword tag)**

Replace the table body `<td>` markup for the Keyword and Actions columns:

```html
          <td>
            <% if (p.keyword) { %>
              <span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--color-amber)">[<%= p.keyword %>]</span>
            <% } else { %>
              <span style="font-size:0.8125rem;color:var(--color-ink-300)">—</span>
            <% } %>
          </td>
```

```html
          <td>
            <div style="display:flex;justify-content:flex-end;align-items:center;gap:0.375rem">
              <a class="btn btn-primary" href="/admin/projects/<%= p.id %>/chat" style="padding:0 0.75rem">Chat</a>
              <a class="btn btn-secondary" href="/admin/projects/<%= p.id %>/opencode" style="padding:0 0.625rem" title="OpenCode UI">Code</a>
              <a class="btn btn-secondary" href="/admin/projects/<%= p.id %>/conversations" style="padding:0 0.625rem" title="View logs">Logs</a>
              <a class="btn btn-secondary" href="/admin/projects/<%= p.id %>/edit" style="padding:0 0.625rem" title="Edit">Edit</a>
              <form class="inline-form" method="post" action="/admin/projects/<%= p.id %>/delete"
                    onsubmit="return confirm('Delete project <%= p.slug %>? This cannot be undone.')">
                <button class="btn btn-danger" type="submit" style="padding:0 0.625rem" title="Delete">✕</button>
              </form>
            </div>
          </td>
```

Leave the Project (name+slug) and Event URL `<td>`s and the whole `<thead>`
untouched — no test-visible text changes there.

- [ ] **Step 6: Run tests**

Run: `node --test tests/adminUi.test.js`
Expected: PASS. Check specifically:
`'projects index renders modern project table actions and endpoint copy'`
(asserts `$('h1').text().trim() === 'Projects'`, exact hrefs for
edit/conversations/delete-form, `/api/events/payment`, `payment-bot`,
`/table-shell/`), `'projects list shows a source sync badge per project'`
(`/Source/` against `thead` text — Step 5/6 didn't touch `<thead>`, so this
still passes), `'projects index links to the per-project chat page'`.

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add views/projects/list.ejs
git commit -m "style: rebuild projects list as ledger table with icon-less actions"
```

---

## Task 12: Login page rewrite

**Files:**
- Modify: `views/login.ejs` (full rewrite of `<style>` and `<body>`)

**Interfaces:**
- Consumes: same controller-supplied locals (`next`, `configured`, `error`) — no controller change.
- Produces: identical form field names/ids (`username`, `password`), identical hidden `next` field, identical conditional warning/error blocks — only markup/CSS changes.

- [ ] **Step 1: Confirm no test locks login page markup beyond auth flow**

Check `tests/auth.test.js` for any cheerio assertions against `login.ejs`
markup before rewriting (search: `grep -n "cheerio\|\.text()\|querySelector" tests/auth.test.js`).
If it only posts to `/admin/login` and checks redirects/cookies (typical for
an auth test), the rewrite is unconstrained beyond field `name`/`id`
attributes. Do not proceed to Step 2 until this is confirmed by reading the
file.

- [ ] **Step 2: Replace the `<style>` block**

Replace `views/login.ejs:11-278` with:

```html
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      min-height: 100vh;
      font-family: var(--font-sans, 'Archivo', sans-serif);
      background: #141210;
      color: #EAE3D4;
    }

    .login-shell {
      display: flex;
      min-height: 100vh;
    }

    .login-brand-panel {
      flex: 1.15;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 3.25rem 4rem;
      border-right: 1px solid #2E2921;
      background-image: repeating-linear-gradient(0deg, rgba(234,227,212,.028) 0, rgba(234,227,212,.028) 1px, transparent 1px, transparent 56px);
    }

    .login-form-panel {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 3.25rem;
    }

    .login-card { width: 100%; max-width: 360px; }

    .login-card-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 1px solid #2E2921;
      padding-bottom: 0.75rem;
      margin-bottom: 1.625rem;
    }

    .login-field { margin-bottom: 1.25rem; }

    .login-field label {
      display: block;
      font-family: var(--font-sans, 'Archivo', sans-serif);
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #A79E8B;
      margin-bottom: 0.5rem;
    }

    .login-field input {
      width: 100%;
      background: #1B1815;
      border: 1px solid #3A342B;
      border-radius: 2px;
      padding: 0.6875rem 0.8125rem;
      font-family: 'Spline Sans Mono', monospace;
      font-size: 0.8125rem;
      color: #EAE3D4;
      outline: none;
    }
    .login-field input:focus { border-color: #D65A3C; }

    .login-btn {
      width: 100%;
      margin-top: 0.5rem;
      padding: 0.75rem 1rem;
      border: none;
      border-radius: 2px;
      background: #EAE3D4;
      color: #141210;
      font-family: var(--font-sans, 'Archivo', sans-serif);
      font-size: 0.8125rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .login-btn:hover { opacity: 0.9; }
    .login-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .login-alert {
      border-radius: 2px;
      border: 1px solid;
      padding: 0.75rem 0.875rem;
      font-size: 0.75rem;
      margin-bottom: 1.125rem;
      line-height: 1.5;
    }
    .login-alert-error { border-color: rgba(214,90,60,.4); color: #D65A3C; }
    .login-alert-warn  { border-color: rgba(217,166,68,.4); color: #D9A644; }

    .login-footer {
      margin-top: 1.625rem;
      text-align: center;
      font-family: 'Spline Sans Mono', monospace;
      font-size: 0.59375rem;
      letter-spacing: 0.06em;
      color: #4A4438;
    }
  </style>
```

- [ ] **Step 3: Replace the `<body>`**

Replace `views/login.ejs:280-346` (from `<body>` to `</html>`) with:

```html
<body>
  <div class="login-shell">

    <div class="login-brand-panel">
      <div style="font-family:'Spline Sans Mono',monospace;font-size:0.625rem;letter-spacing:0.22em;color:#6E6657;text-transform:uppercase">Est. 2026 · Internal instrument</div>
      <div>
        <div style="width:34px;height:2px;background:#D65A3C;margin-bottom:1.625rem"></div>
        <div style="font-family:'Newsreader',serif;font-size:3.5rem;font-weight:500;line-height:1.04;letter-spacing:-.015em">OpenTrace<br>Bridge<span style="color:#D65A3C">.</span></div>
        <div style="font-family:'Newsreader',serif;font-style:italic;font-size:1.25rem;color:#A79E8B;margin-top:1.125rem">The ledger between Teams, agents &amp; your APIs.</div>
      </div>
      <div style="display:flex;gap:2.25rem;flex-wrap:wrap;font-family:'Spline Sans Mono',monospace;font-size:0.65625rem;color:#6E6657">
        <span>ADMIN CONSOLE</span><span>PRIVATE ACCESS ONLY</span>
      </div>
    </div>

    <div class="login-form-panel">
      <form method="post" action="/admin/login" class="login-card">
        <input type="hidden" name="next" value="<%= next %>">

        <div class="login-card-head">
          <span style="font-family:'Spline Sans Mono',monospace;font-size:0.625rem;letter-spacing:0.2em;color:#A79E8B;text-transform:uppercase">Private access</span>
          <span style="font-family:'Spline Sans Mono',monospace;font-size:0.625rem;color:#6E6657">FORM NO. 001</span>
        </div>

        <% if (!configured) { %>
          <div class="login-alert login-alert-warn">
            Admin credentials not configured. Set <code style="background:rgba(255,255,255,0.08);border:none;color:inherit;padding:0.1em 0.3em;border-radius:2px">ADMIN_USERNAME</code> and <code style="background:rgba(255,255,255,0.08);border:none;color:inherit;padding:0.1em 0.3em;border-radius:2px">ADMIN_PASSWORD</code> in your environment.
          </div>
        <% } %>

        <% if (error) { %>
          <div class="login-alert login-alert-error" role="alert"><%= error %></div>
        <% } %>

        <div class="login-field">
          <label for="username">Username</label>
          <input id="username" name="username" type="text"
                 autocomplete="username" required autofocus
                 placeholder="admin">
        </div>

        <div class="login-field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password"
                 autocomplete="current-password" required
                 placeholder="••••••••••••">
        </div>

        <button type="submit" class="login-btn" <%= configured ? '' : 'disabled' %>>Sign in →</button>

        <div class="login-alert login-alert-warn" style="margin-top:1.125rem;margin-bottom:0">
          5 attempts per 15 minutes per IP. Credentials are set via <span style="font-family:'Spline Sans Mono',monospace;font-size:0.65625rem">ADMIN_USERNAME</span> / <span style="font-family:'Spline Sans Mono',monospace;font-size:0.65625rem">ADMIN_PASSWORD</span>.
        </div>

        <div class="login-footer">SESSION VALID 7 DAYS · SLIDING</div>
      </form>
    </div>

  </div>
</body>
</html>
```

- [ ] **Step 4: Run auth tests**

Run: `node --test tests/auth.test.js`
Expected: all PASS — field `name`/`id` (`username`, `password`), the hidden
`next` field, and the `disabled` attribute logic are all preserved.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add views/login.ejs
git commit -m "style: rebuild login as a split brand/form screen"
```

---

## Task 13: Project-form client-side tabs (Core / Repositories / API endpoints)

**Files:**
- Modify: `views/projects/form.ejs`
- Test: `tests/adminUi.test.js` (add tab-markup assertions)

**Interfaces:**
- Produces: `[data-tab-panel="core"|"repos"|"apis"]` wrapper `<section>`s; a `.tab-bar` with three `[data-tab="core"|"repos"|"apis"]` buttons; ~20 lines of vanilla JS toggling panel visibility. **Every field stays in the DOM at all times** — panels are hidden with the `hidden` attribute, never removed, so all existing `tests/adminUi.test.js` assertions that read field values keep working regardless of which tab is "active" on load.
- Consumes: `.tab-bar`/`.tab-item`/`.tab-item-active`/`.tab-count` from Task 5.

- [ ] **Step 1: Opt into the `detail` shell breadcrumb**

`detail` is already the default shell (Task 7), so no `layoutShell` var is
needed. Add a breadcrumb kicker above the page header. Replace
`views/projects/form.ejs:16-21`:

```html
  <section style="margin-bottom:1.5rem;display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-end;justify-content:space-between">
    <div>
      <p class="kicker"><a href="/admin/projects">← Projects</a> / <%= isEditing ? 'Edit entry no. ' + project.id : 'New entry' %></p>
      <h1 class="page-title"><%= isEditing ? project.name : 'New project' %></h1>
    </div>
```

(This keeps `page-subtitle` removed — the mock doesn't show one on this page;
if a reviewer wants it back it's a one-line addition, but dropping it matches
mock `3d`/`3l` exactly, which have no subtitle under the title.)

- [ ] **Step 2: Add the tab bar**

After the header `</section>` and the error block (Step in original file
around line 51–61), insert before the `<!-- Integration webhook -->` section:

```html
  <div class="tab-bar">
    <button type="button" class="tab-item tab-item-active" data-tab="core">Core settings</button>
    <button type="button" class="tab-item" data-tab="repos">Repositories<span class="tab-count">/<%= repos.length %></span></button>
    <button type="button" class="tab-item" data-tab="apis">API endpoints<span class="tab-count">/<%= apis.length %></span></button>
    <span class="tab-bar-note kicker">One save writes all tabs</span>
  </div>
```

- [ ] **Step 3: Wrap Core settings, Repositories, and API endpoints sections in tab panels**

Wrap the existing `<!-- Core settings -->` `<section class="panel" ...>` in:

```html
  <div data-tab-panel="core">
    <!-- existing Core settings <section> unchanged -->
  </div>
```

Wrap the existing `<!-- Repositories -->` `<section class="panel" ...>` in:

```html
  <div data-tab-panel="repos" hidden>
    <!-- existing Repositories <section> unchanged -->
  </div>
```

Wrap the existing `<!-- API Endpoints -->` `<section class="panel" ...>` in:

```html
  <div data-tab-panel="apis" hidden>
    <!-- existing API endpoints <section> unchanged -->
  </div>
```

(Note: the Integration webhook section, which sits between the header and
Core settings, is **not** wrapped — it stays always-visible above the tabs,
matching mock `3d` where the integration box is shown regardless of which tab
is active.)

- [ ] **Step 4: Add the tab-switching script**

Add just before the existing `<script src="https://uicdn.toast.com/...">`
line:

```html
<script>
(function () {
  var tabs = document.querySelectorAll('.tab-item[data-tab]');
  var panels = document.querySelectorAll('[data-tab-panel]');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var target = tab.dataset.tab;
      tabs.forEach(function (t) { t.classList.toggle('tab-item-active', t === tab); });
      panels.forEach(function (p) { p.hidden = p.dataset.tabPanel !== target; });
    });
  });
})();
</script>
```

- [ ] **Step 5: Add regression tests for the tab markup**

Add to `tests/adminUi.test.js`:

```js
test('project form renders Core/Repositories/API as tab panels with everything in the DOM', async () => {
  const project = seedProject();
  repos.create({ project_id: project.id, git_url: 'https://github.com/acme/payment.git', auth_type: 'none', branch: 'main' });

  const response = await agent.get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(response.text);

  assert.strictEqual($('.tab-bar [data-tab="core"]').length, 1);
  assert.strictEqual($('.tab-bar [data-tab="repos"]').length, 1);
  assert.strictEqual($('.tab-bar [data-tab="apis"]').length, 1);
  assert.strictEqual($('[data-tab-panel="core"]').attr('hidden'), undefined);
  assert.strictEqual($('[data-tab-panel="repos"]').attr('hidden'), '');
  assert.strictEqual($('[data-tab-panel="apis"]').attr('hidden'), '');
  // Fields inside hidden panels are still present and populated.
  assert.strictEqual($('input[name="repos[0][git_url]"]').val(), 'https://github.com/acme/payment.git');
});
```

- [ ] **Step 6: Run it, then the pre-existing suite touching this file**

Run: `node --test tests/adminUi.test.js`
Expected: the new test PASSes. Verify `'Save button is at the top inside the
single unified form'` still passes — the header `<section>` with the Save
button is still the **first** `<section>` child of `<form>` (the tab bar is a
`<div>`, not a `<section>`, and the integration box stays a `<section>` but
comes *after* the header section, same as before, so `.first()` still
resolves to the header).

Run: `npm test`
Expected: all pass.

Run: `npm run build:css` — expected exit 0.

- [ ] **Step 7: Commit**

```bash
git add views/projects/form.ejs tests/adminUi.test.js
git commit -m "feat: convert project-form sections into client-side Core/Repos/API tabs"
```

---

## Task 14: `_repo-row.ejs` — segmented control for Auth type

**Files:**
- Modify: `views/projects/_repo-row.ejs`
- Modify: `views/projects/form.ejs` (retarget `updateAuthFields()` from the old `<select>` to the new radio group)
- Test: `tests/adminUi.test.js` (add a segmented-control assertion; verify existing form-submission tests still pass unmodified since field name/value pairs are unchanged)

**Interfaces:**
- Produces: 3 `<input type="radio" name="repos[<%= i %>][auth_type]" value="none|https-token|ssh">` inputs replacing the single `<select name="repos[<%= i %>][auth_type]">`. **Same field name, same three values** — POST body shape is unchanged, so every controller-side validation test keeps passing untouched.
- Consumes: `.segmented`/`.segmented-option` from Task 5.

- [ ] **Step 1: Replace the Auth type `<select>` with a segmented control**

Replace `views/projects/_repo-row.ejs:10-17`:

```html
    <div>
      <label>Auth type</label>
      <div class="segmented" data-auth-type-group>
        <label class="segmented-option">
          <input type="radio" name="repos[<%= i %>][auth_type]" value="none"
                 <%= r.auth_type === 'none' || !r.auth_type ? 'checked' : '' %>>
          <span>None</span>
        </label>
        <label class="segmented-option">
          <input type="radio" name="repos[<%= i %>][auth_type]" value="https-token"
                 <%= r.auth_type === 'https-token' ? 'checked' : '' %>>
          <span>Token</span>
        </label>
        <label class="segmented-option">
          <input type="radio" name="repos[<%= i %>][auth_type]" value="ssh"
                 <%= r.auth_type === 'ssh' ? 'checked' : '' %>>
          <span>SSH</span>
        </label>
      </div>
    </div>
```

- [ ] **Step 2: Retarget the show/hide JS in `form.ejs`**

In `views/projects/form.ejs`, find `updateAuthFields()`:

```js
  function updateAuthFields(rowEl) {
    var select   = rowEl.querySelector('[data-auth-type-select]');
    var tokenWrap = rowEl.querySelector('[data-token-wrap]');
    var sshWrap   = rowEl.querySelector('[data-ssh-wrap]');
    if (!select) return;
    var v = select.value;
    ...
```

Replace with:

```js
  function updateAuthFields(rowEl) {
    var checked  = rowEl.querySelector('[data-auth-type-group] input:checked');
    var tokenWrap = rowEl.querySelector('[data-token-wrap]');
    var sshWrap   = rowEl.querySelector('[data-ssh-wrap]');
    if (!checked) return;
    var v = checked.value;
    if (tokenWrap) tokenWrap.style.display = (v === 'https-token') ? '' : 'none';
    if (sshWrap)   sshWrap.style.display   = (v === 'ssh')         ? '' : 'none';
    var tokenInput = rowEl.querySelector('[data-token-input]');
    var sshInput   = rowEl.querySelector('[data-ssh-key-input]');
    if (tokenInput) tokenInput.disabled = (v !== 'https-token');
    if (sshInput)   sshInput.disabled   = (v !== 'ssh');
  }
```

And the `change` listener registration:

```js
  document.addEventListener('change', function(e) {
    if (e.target.matches('[data-auth-type-group] input')) {
      var row = e.target.closest('[data-row]');
      if (row) updateAuthFields(row);
    }
  });
```

(Replacing the old `if (e.target.matches('[data-auth-type-select]'))` check.)

- [ ] **Step 3: Add a segmented-control regression test**

Add to `tests/adminUi.test.js`:

```js
test('repo row renders auth type as a segmented radio control, not a select', async () => {
  const project = seedProject();
  repos.create({ project_id: project.id, git_url: 'https://github.com/acme/payment.git', auth_type: 'https-token', branch: 'main' });

  const response = await agent.get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(response.text);

  assert.strictEqual($('select[name="repos[0][auth_type]"]').length, 0);
  assert.strictEqual($('input[name="repos[0][auth_type]"][type="radio"]').length, 3);
  assert.strictEqual($('input[name="repos[0][auth_type]"][value="https-token"]').attr('checked'), 'checked');
});
```

- [ ] **Step 4: Run it, then the tests that submit `repos[N][auth_type]`**

Run: `node --test tests/adminUi.test.js`
Expected: all PASS, including
`'bundle validation rejects a bad repo row with prefixed errors and creates
nothing'` and `'save-all reconciles rows...'` and
`'blank token on save keeps the stored secret...'` — all of these submit
`'repos[0][auth_type]': 'https-token'` as raw form data via supertest, which
doesn't care whether the browser widget is a `<select>` or radios; only the
field name/value pairs matter, which are unchanged.

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add views/projects/_repo-row.ejs views/projects/form.ejs tests/adminUi.test.js
git commit -m "feat: replace repo auth-type select with a segmented radio control"
```

---

## Task 15: `_api-row.ejs` — strip hardcoded Tailwind classes (bug fix)

**Files:**
- Modify: `views/projects/_api-row.ejs`

**Interfaces:**
- No interface change — field names (`apis[i][name]`, `apis[i][curl_command]`, `apis[i][description_md]`, `apis[i][id]`) are identical; only the surrounding markup/classes change from hardcoded Tailwind utilities to the same bare-element pattern `_repo-row.ejs` already uses (inherits base-layer input styling).

- [ ] **Step 1: Rewrite the file**

Replace `views/projects/_api-row.ejs` in full:

```html
<fieldset style="border-radius:var(--radius);border:1px solid var(--color-border);background:var(--color-panel-alt);padding:1rem" data-row>
  <input type="hidden" name="apis[<%= i %>][id]" value="<%= a.id || '' %>">
  <div>
    <label>Name</label>
    <input type="text" name="apis[<%= i %>][name]" value="<%= a.name || '' %>"
           placeholder="transaction-api">
    <p class="field-help">Optional. If left blank, OpenTraceBridge derives a name from the curl URL host.</p>
  </div>
  <div style="margin-top:0.875rem">
    <label>Curl command</label>
    <textarea name="apis[<%= i %>][curl_command]" style="font-family:var(--font-mono);min-height:8rem"
              placeholder='curl -H "Authorization: Bearer sk_live_xxx" "https://api.internal.example/v1/transactions/txn_123"'><%= a.curl_command || '' %></textarea>
    <p class="field-help">Paste a working curl command. OpenTraceBridge extracts the base URL, method, auth header, and API key. For saved rows, leave blank to keep the current values or paste a new curl to replace them.</p>
    <% if (a.id && a.base_url) { %>
    <p class="field-help">Current: <code><%= a.allowed_methods || 'GET' %> <%= a.base_url %></code> &middot; auth header: <code><%= a.auth_header || 'Authorization' %></code></p>
    <% } %>
  </div>
  <div style="margin-top:0.875rem" data-api-editor-container>
    <label>Markdown description</label>
    <textarea name="apis[<%= i %>][description_md]" class="hidden api-description-textarea" placeholder="Document endpoints, params, filters, and response fields for the agent"><%= a.description_md || '' %></textarea>
    <div class="api-description-editor" style="margin-top:0.5rem;background:var(--color-panel-alt);border:1px solid var(--color-border-strong);border-radius:var(--radius)"></div>
  </div>
  <div style="margin-top:0.875rem;display:flex;justify-content:flex-end">
    <button type="button" class="btn btn-danger" data-remove>Remove</button>
  </div>
</fieldset>
```

This drops `rounded-lg border-line bg-white text-ink-950 shadow-sm
focus:border-brand focus:ring-brand focus:outline-hidden` entirely from both
the outer `<fieldset>` and both inner form controls — they now inherit the
base-layer `input`/`textarea` rules from Task 5, which are theme-aware
(fixing the pre-existing dark-mode `bg-white` bug as a side effect).

- [ ] **Step 2: Run the API-row test block**

Run: `node --test tests/adminUi.test.js`
Expected: PASS, in particular
`'api row form only offers name, curl, and description inputs plus a parsed
summary'` (still exactly one `input[name="apis[0][name]"]`, one
`textarea[name="apis[0][curl_command]"]`, one
`textarea[name="apis[0][description_md]"]`, zero `base_url`/`auth_header`/
`allowed_methods`/`api_key` inputs, and the parsed-summary text
`POST https://api.internal.example/v1` and secret redaction both intact) and
`'existing API row keeps parsed fields when saved without a new curl
command'`.

Run: `npm test`
Expected: all pass.

Run: `npm run build:css` — expected exit 0.

- [ ] **Step 3: Commit**

```bash
git add views/projects/_api-row.ejs
git commit -m "fix: stop _api-row.ejs from hardcoding Tailwind utility classes over theme tokens"
```

---

## Task 16: `_api-row.ejs` — collapse/expand + parsed info bar

**Files:**
- Modify: `views/projects/_api-row.ejs`
- Modify: `views/projects/form.ejs` (collapse/expand JS + initial-state logic)
- Test: `tests/adminUi.test.js`

**Interfaces:**
- Produces: `data-collapsed` attribute on `[data-row]` fieldsets; a `data-collapsed-summary` header row (name + parsed host/methods + EXPAND button) shown only when collapsed; the full field set (from Task 15) shown only when expanded. **All fields remain in the DOM in both states** — only visibility toggles, per the Global Constraints (no client-fetch-on-reveal).
- Consumes: nothing new from other tasks; adds ~25 lines of JS to `form.ejs`'s existing `<script>` block (same IIFE as the tab/auth-type wiring from Tasks 13/14).

- [ ] **Step 1: Add the collapsed-summary header and expand/collapse toggle to `_api-row.ejs`**

Replace the opening of `views/projects/_api-row.ejs` (the `<fieldset>` tag)
and add a summary header plus a body wrapper around everything after the
hidden `id` input:

```html
<fieldset style="border-radius:var(--radius);border:1px solid var(--color-border);background:var(--color-panel-alt);padding:1rem" data-row data-collapsed="<%= a.id ? 'true' : 'false' %>">
  <input type="hidden" name="apis[<%= i %>][id]" value="<%= a.id || '' %>">

  <div data-collapsed-summary style="display:none;justify-content:space-between;align-items:center;gap:1rem">
    <div style="display:flex;gap:1.125rem;align-items:baseline;min-width:0">
      <span class="kicker kicker-amber">API group</span>
      <span style="font-family:var(--font-sans);font-size:0.8125rem;font-weight:600"><%= a.name || '(unnamed)' %></span>
      <% if (a.base_url) { %>
        <span class="kicker" style="color:var(--color-ink-300)"><%= a.base_url %> · <%= a.allowed_methods || 'GET' %></span>
      <% } %>
    </div>
    <div style="display:flex;gap:0.5rem;flex-shrink:0">
      <button type="button" class="btn btn-secondary" data-expand>Expand</button>
      <button type="button" class="btn btn-danger" data-remove>Remove</button>
    </div>
  </div>

  <div data-collapsed-body>
    <div>
      <label>Name</label>
      <input type="text" name="apis[<%= i %>][name]" value="<%= a.name || '' %>"
             placeholder="transaction-api">
      <p class="field-help">Optional. If left blank, OpenTraceBridge derives a name from the curl URL host.</p>
    </div>
    <div style="margin-top:0.875rem">
      <label>Curl command</label>
      <textarea name="apis[<%= i %>][curl_command]" style="font-family:var(--font-mono);min-height:8rem"
                placeholder='curl -H "Authorization: Bearer sk_live_xxx" "https://api.internal.example/v1/transactions/txn_123"'><%= a.curl_command || '' %></textarea>
      <p class="field-help">Paste a working curl command. OpenTraceBridge extracts the base URL, method, auth header, and API key. For saved rows, leave blank to keep the current values or paste a new curl to replace them.</p>
      <% if (a.id && a.base_url) { %>
      <div style="display:flex;gap:1.375rem;margin-top:0.75rem;padding:0.625rem 0.875rem;border:1px solid var(--color-border);border-radius:var(--radius);font-family:var(--font-mono);font-size:0.65625rem;color:var(--color-ink-500);flex-wrap:wrap">
        <span style="color:var(--color-ok)">✓ Parsed</span>
        <span>Base — <%= a.base_url %></span>
        <span>Methods — <span style="color:var(--color-ink-950)"><%= a.allowed_methods || 'GET' %></span></span>
        <span>Auth — <%= a.auth_header || 'Authorization' %></span>
        <span>Key — stored server-side, never shown to agent</span>
      </div>
      <% } %>
    </div>
    <div style="margin-top:0.875rem" data-api-editor-container>
      <label>Markdown description</label>
      <textarea name="apis[<%= i %>][description_md]" class="hidden api-description-textarea" placeholder="Document endpoints, params, filters, and response fields for the agent"><%= a.description_md || '' %></textarea>
      <div class="api-description-editor" style="margin-top:0.5rem;background:var(--color-panel-alt);border:1px solid var(--color-border-strong);border-radius:var(--radius)"></div>
    </div>
    <div style="margin-top:0.875rem;display:flex;justify-content:flex-end">
      <button type="button" class="btn btn-danger" data-remove>Remove</button>
    </div>
  </div>
</fieldset>
```

Note the parsed-info bar's `✓ Parsed`/`Base`/`Methods`/`Auth`/`Key` items
replace the old single `field-help` "Current: ..." line — same underlying
data (`a.base_url`, `a.allowed_methods`, `a.auth_header`), same
`a.id && a.base_url` guard, just restyled into the mock's bordered info-bar
layout.

- [ ] **Step 2: Add collapse/expand JS to `form.ejs`**

Add to the existing `<script>` IIFE in `form.ejs`, after the
`updateAuthFields`-related listeners:

```js
  // API row collapse/expand — purely visual, every field stays in the DOM.
  function applyCollapsedState(rowEl) {
    var collapsed = rowEl.dataset.collapsed === 'true';
    var summary = rowEl.querySelector('[data-collapsed-summary]');
    var body = rowEl.querySelector('[data-collapsed-body]');
    if (!summary || !body) return;
    summary.style.display = collapsed ? 'flex' : 'none';
    body.style.display = collapsed ? 'none' : '';
  }

  document.querySelectorAll('[data-rows="apis"] > [data-row]').forEach(applyCollapsedState);

  document.addEventListener('click', function(e) {
    var expandBtn = e.target.closest('[data-expand]');
    if (expandBtn) {
      var row = expandBtn.closest('[data-row]');
      row.dataset.collapsed = 'false';
      applyCollapsedState(row);
    }
  });
```

- [ ] **Step 3: Apply collapsed state to newly-added rows too**

In the existing `data-add` button handler in `form.ejs`, after
`if (kind === 'apis') { ... initApiRowEditor(c); }`, add:

```js
      if (kind === 'apis') {
        var c = newEl.querySelector('[data-api-editor-container]');
        if (c) initApiRowEditor(c);
        newEl.dataset.collapsed = 'false'; // newly added rows start expanded
        applyCollapsedState(newEl);
      }
```

(Replacing the existing 3-line `if (kind === 'apis') {...}` block, which
previously only called `initApiRowEditor`.)

- [ ] **Step 4: Add a regression test**

Add to `tests/adminUi.test.js`:

```js
test('saved API groups render collapsed by default with a parsed-info bar; new rows start expanded', async () => {
  const project = seedProject();
  apis.create({
    project_id: project.id, name: 'transaction-api',
    base_url: 'https://api.internal.example/v1', api_key: 'Bearer sk_live_123',
    auth_header: 'Authorization', allowed_methods: 'GET',
    description_md: 'Read transactions.',
  });

  const response = await agent.get(`/admin/projects/${project.id}/edit`).expect(200);
  const $ = cheerio.load(response.text);

  const row = $('[data-rows="apis"] > [data-row]').first();
  assert.strictEqual(row.attr('data-collapsed'), 'true');
  // Fields still present in the DOM despite the collapsed default.
  assert.strictEqual(row.find('input[name="apis[0][name]"]').val(), 'transaction-api');
  assert.match(row.text(), /Parsed/);
  assert.match(row.text(), /api\.internal\.example\/v1/);

  const template = $('template[data-template="apis"]').html();
  assert.match(template, /data-collapsed="false"/);
});
```

- [ ] **Step 5: Run it, then the surrounding suite**

Run: `node --test tests/adminUi.test.js`
Expected: the new test PASSes. Re-verify
`'api row form only offers name, curl, and description inputs plus a parsed
summary'` still passes — the field set didn't shrink, it's just wrapped in an
extra `[data-collapsed-body]` div.

Run: `npm test`
Expected: all pass.

Run: `npm run build:css` — expected exit 0.

- [ ] **Step 6: Commit**

```bash
git add views/projects/_api-row.ejs views/projects/form.ejs tests/adminUi.test.js
git commit -m "feat: add collapse/expand and a parsed-info bar to API endpoint rows"
```

---

## Task 17: Shared Chat/OpenCode/Audit workspace tab bar

**Files:**
- Create: `views/projects/_workspace-tabs.ejs`
- Modify: `views/projects/chat.ejs`, `views/projects/opencode.ejs`, `views/conversations/list.ejs`

**Interfaces:**
- Produces: a `_workspace-tabs.ejs` partial taking locals `project` (object with `.id`) and `active` (`'chat'|'opencode'|'audit'`), rendering a `.tab-bar` of three real links. Consumed by all three workspace pages.

- [ ] **Step 1: Create the partial**

```html
<div class="tab-bar">
  <a class="tab-item <%= active === 'chat' ? 'tab-item-active' : '' %>" href="/admin/projects/<%= project.id %>/chat">Chat</a>
  <a class="tab-item <%= active === 'opencode' ? 'tab-item-active' : '' %>" href="/admin/projects/<%= project.id %>/opencode">OpenCode</a>
  <a class="tab-item <%= active === 'audit' ? 'tab-item-active' : '' %>" href="/admin/projects/<%= project.id %>/conversations">Audit</a>
</div>
```

- [ ] **Step 2: Wire it into `chat.ejs`**

Replace `views/projects/chat.ejs:7-30` (the `<!-- Chat header -->` div) with:

```html
  <div style="margin-bottom:0.5rem">
    <p class="kicker"><a href="/admin/projects/<%= project.id %>/edit">← Projects</a> / Workspace</p>
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-top:0.375rem">
      <h1 class="page-title" style="font-size:1.75rem"><%= project.name %></h1>
      <form method="post" action="/admin/projects/<%= project.id %>/chat/new"
        onsubmit="return confirm('Close this conversation and start a new OpenCode session?');">
        <button type="submit" class="btn btn-secondary">New conversation</button>
      </form>
    </div>
  </div>

  <%- include('_workspace-tabs', { project: project, active: 'chat' }) %>
```

- [ ] **Step 3: Wire it into `opencode.ejs`**

Replace `views/projects/opencode.ejs:6-23` (the `<!-- Header -->` div) with:

```html
  <div style="margin-bottom:0.5rem">
    <p class="kicker"><a href="/admin/projects/<%= project.id %>/edit">← Projects</a> / Workspace</p>
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-top:0.375rem">
      <h1 class="page-title" style="font-size:1.75rem"><%= project.name %></h1>
      <a class="btn btn-secondary" id="open-new-tab" href="#" target="_blank" rel="noopener">Open in new tab ↗</a>
    </div>
  </div>

  <%- include('_workspace-tabs', { project: project, active: 'opencode' }) %>
```

(Note: `opencode.ejs:12`'s `iframe` and its `src`-setting `<script>` at the
bottom are untouched — this task only rewrites the header.)

- [ ] **Step 4: Wire it into `conversations/list.ejs`**

Replace `views/conversations/list.ejs:3-13` (the header `<section>`) with:

```html
<div style="margin-bottom:0.5rem">
  <p class="kicker"><a href="/admin/projects/<%= project.id %>/edit">← Projects</a> / Workspace</p>
  <h1 class="page-title" style="font-size:1.75rem;margin-top:0.375rem"><%= project.name %></h1>
</div>

<%- include('../projects/_workspace-tabs', { project: project, active: 'audit' }) %>
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/chat.test.js tests/adminUi.test.js`
Expected: all PASS —
`'chat page renders empty state, requires auth'` (still matches `/Payment/`
and `/chat-history/`), `'chat page renders history JSON, composer, and
new-conversation button'` (still matches `id="chat-history"`, `bold answer`,
`id="chat-input"`, `chat/new`, `marked`, `purify`),
`'opencode embed page renders iframe behind auth'` (still matches
`opencode-frame`, `8668`), and
`'conversation audit list renders redesigned tables'` (still matches
`h1` text `'Conversations'` — **note**: this task changes the `<h1>` text
from `'Conversations'` to `project.name` per the mock's breadcrumb pattern.
Check this against the test in Step 6 before committing.)

- [ ] **Step 6: Reconcile the `<h1>` text change with the existing test**

`tests/adminUi.test.js` has:

```js
test('conversation audit list renders redesigned tables', async () => {
  ...
  assert.strictEqual($('h1').text().trim(), 'Conversations');
```

Step 4 changes the `<h1>` to `<%= project.name %>` ("Payment" in the test
fixture), which breaks this assertion. Per the mock (`3i`), the page title
*is* the project name, with "Audit" only appearing as the active tab label —
this is an intentional design change, not an oversight. Update the test:

```js
  assert.strictEqual($('h1').text().trim(), 'Payment');
  assert.strictEqual($('.tab-item-active').text().trim(), 'Audit');
```

Apply the equivalent fix to `'conversation audit list renders redesigned
tables'` only — leave every other assertion in that test (conversation link,
`ses_abc`, `transaction-api`, `Latest API calls`, `table-shell`) unchanged.

- [ ] **Step 7: Re-run and run the full suite**

Run: `node --test tests/adminUi.test.js tests/chat.test.js`
Expected: all PASS.

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add views/projects/_workspace-tabs.ejs views/projects/chat.ejs views/projects/opencode.ejs views/conversations/list.ejs tests/adminUi.test.js
git commit -m "feat: add shared Chat/OpenCode/Audit workspace tab bar"
```

---

## Task 18: Chat bubble restructure — quote-style agent messages

**Files:**
- Modify: `assets/styles/admin.css` — chat UI block (`.chat-shell` through `.chat-chip:hover`)
- Modify: `views/projects/chat.ejs` — the `addBubble()`/avatar JS

**Interfaces:**
- Produces: `.chat-bubble-user` stays a solid-fill bubble (unchanged shape, recolored). `.chat-bubble-agent` drops its bordered-box look in favor of a left-border quote (no background, no border-radius). `.chat-avatar` becomes a hairline-bordered square with serif "OT" instead of a gradient circle. **No change to element IDs, SSE event handling, or the `addBubble(direction, content)`/`addMeta(bubble, text)` function signatures** — `tests/chat.test.js` only checks server-rendered markup and SSE payload shape, not bubble CSS, so this task is test-safe by construction; still run the suite to confirm.

- [ ] **Step 1: Rewrite the chat CSS block**

Replace the `/* ============================================================
   CHAT UI
   ============================================================ */` block in
`assets/styles/admin.css` (from `.chat-shell` through `.chat-chip:hover`,
end of that `@layer components` block) with:

```css
@layer components {

  .chat-shell {
    display: flex;
    flex-direction: column;
    min-height: calc(100vh - 3.5rem);
  }

  .chat-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 28rem;
  }

  .chat-messages {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.125rem;
    padding: 1.625rem 0;
    max-width: 860px;
    margin: 0 auto;
    width: 100%;
  }

  .chat-row { display: flex; align-items: flex-end; gap: 0.75rem; }
  .chat-row-user  { justify-content: flex-end; }
  .chat-row-agent { justify-content: flex-start; }

  .chat-avatar {
    flex-shrink: 0;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--radius);
    border: 1px solid var(--color-border-strong);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-serif);
    font-size: 0.6875rem;
    color: var(--color-brand);
  }

  .chat-bubble {
    max-width: 74%;
    font-size: 0.84375rem;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }

  .chat-bubble-user {
    background: var(--color-ink-950);
    color: var(--color-canvas);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    white-space: pre-wrap;
  }

  .chat-bubble-agent {
    border-left: 2px solid var(--color-border);
    padding: 0.125rem 0 0.125rem 1rem;
    color: var(--color-ink-700);
  }

  .chat-bubble-agent pre { overflow-x: auto; }

  .chat-bubble-agent code {
    font-family: var(--font-mono);
    font-size: 0.8125rem;
    background: var(--color-panel-alt);
    border: 1px solid var(--color-border);
    color: var(--color-brand);
    padding: 0.1em 0.35em;
    border-radius: var(--radius);
  }

  .chat-bubble-agent pre code {
    background: transparent;
    border: none;
    color: inherit;
    padding: 0;
  }

  .chat-bubble-agent p  { margin: 0.4rem 0; }
  .chat-bubble-agent h1, .chat-bubble-agent h2, .chat-bubble-agent h3 {
    font-family: var(--font-sans); font-weight: 700; margin: 0.75rem 0 0.375rem; color: var(--color-ink-950);
  }
  .chat-bubble-agent ul,
  .chat-bubble-agent ol { margin: 0.375rem 0 0.375rem 1.375rem; }
  .chat-bubble-agent li { margin: 0.2rem 0; }
  .chat-bubble-agent blockquote {
    border-left: 2px solid var(--color-brand);
    padding-left: 0.75rem;
    margin: 0.5rem 0;
    color: var(--color-ink-500);
  }

  .chat-bubble-error {
    color: var(--color-danger);
    border-left-color: var(--color-danger);
  }

  .chat-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.71875rem;
    color: var(--color-amber);
  }

  .chat-status::before {
    content: '';
    display: inline-block;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: var(--color-amber);
    animation: pulse-dot 1s ease-in-out infinite;
  }

  .chat-meta {
    margin-top: 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.65625rem;
    color: var(--color-ink-300);
  }

  .chat-banner {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    margin: 1.25rem auto 0;
    max-width: 860px;
    width: 100%;
    padding: 0.6875rem 1rem;
    border: 1px solid color-mix(in srgb, var(--color-amber) 40%, transparent);
    border-radius: var(--radius);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
    color: var(--color-amber);
  }
  .chat-banner::before {
    content: '';
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 50%;
    background: var(--color-amber);
    flex-shrink: 0;
    animation: pulse-dot 1.2s ease-in-out infinite;
  }

  .chat-composer {
    display: flex;
    align-items: flex-end;
    gap: 0.75rem;
    padding: 0.8125rem 1rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius);
    background: var(--color-panel-alt);
    max-width: 860px;
    margin: 1.125rem auto 0.5rem;
    width: 100%;
  }

  .chat-composer textarea {
    flex: 1;
    resize: none;
    margin-top: 0;
    min-height: 0;
    max-height: 10rem;
    border: none;
    background: none;
    font-family: var(--font-sans);
    font-size: 0.84375rem;
    padding: 0;
  }
  .chat-composer textarea:focus { border: none; }

  .chat-composer-hint {
    max-width: 860px;
    margin: 0 auto 1.625rem;
    width: 100%;
    font-family: var(--font-mono);
    font-size: 0.625rem;
    color: var(--color-ink-300);
  }

  .chat-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.125rem;
    padding: 3rem 1.5rem;
    text-align: center;
    max-width: 860px;
    margin: 0 auto;
    width: 100%;
    color: var(--color-ink-500);
  }

  .chat-empty-icon {
    width: 3.25rem;
    height: 3.25rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-serif);
    font-size: 1.25rem;
    color: var(--color-brand);
    margin: 0 auto;
  }

  .chat-empty-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: center;
    margin-top: 0.25rem;
  }

  .chat-chip {
    border: 1px solid var(--color-border-strong);
    background: none;
    color: var(--color-ink-500);
    border-radius: var(--radius);
    padding: 0.5625rem 0.9375rem;
    font-family: var(--font-sans);
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .chat-chip:hover {
    color: var(--color-ink-950);
    border-color: var(--color-ink-950);
  }

} /* end chat @layer components */
```

- [ ] **Step 2: Update the avatar icon markup in `chat.ejs`'s JS**

Replace the avatar-creation lines inside `addBubble()`:

```js
      const avatar = document.createElement('div');
      avatar.className = 'chat-avatar';
      avatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" fill="white"><path d="..."/></svg>`;
      row.appendChild(avatar);
```

with:

```js
      const avatar = document.createElement('div');
      avatar.className = 'chat-avatar';
      avatar.textContent = 'OT';
      row.appendChild(avatar);
```

- [ ] **Step 3: Update the empty-state icon markup**

In `showEmptyState()`, replace:

```js
      <div class="chat-empty-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div>
        <p style="font-size:0.9375rem;font-weight:600;color:var(--color-ink-700);margin-bottom:0.25rem">Ask the OpenCode agent</p>
        <p style="font-size:0.8125rem;color:var(--color-ink-500)">The agent can inspect source code, call internal APIs, and investigate incidents.</p>
      </div>
```

with:

```js
      <div class="chat-empty-icon">OT</div>
      <div>
        <p style="font-family:'Newsreader',serif;font-size:1.25rem;font-weight:500;color:var(--color-ink-950);margin-bottom:0.375rem">Open the ledger with a <em style="font-style:italic;color:var(--color-brand)">question</em></p>
        <p style="font-size:0.78125rem;color:var(--color-ink-500)">The agent can inspect source code, call internal APIs, and investigate incidents.</p>
      </div>
```

- [ ] **Step 4: Add the composer hint copy**

In `chat.ejs`, after the `<form id="chat-form" class="chat-composer">...</form>` block, add:

```html
    <p class="chat-composer-hint">Enter ↵ send · Shift+Enter newline — one run per project at a time, concurrent sends return 409.</p>
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/chat.test.js`
Expected: all PASS — none of the five chat tests assert on `.chat-bubble-*`
CSS, avatar SVG content, or the empty-state icon; they check `id="chat-
history"`, `chat-history` substring, SSE event bodies, and `id="chat-input"`,
all untouched.

Run: `npm test`
Expected: all pass.

Run: `npm run build:css` — expected exit 0.

- [ ] **Step 6: Commit**

```bash
git add assets/styles/admin.css views/projects/chat.ejs
git commit -m "style: restructure chat into solid user bubbles and quote-style agent replies"
```

---

## Task 19: `_api-calls-table.ejs` — method/status colors + two-column detail

**Files:**
- Modify: `views/conversations/_api-calls-table.ejs`
- Test: `tests/adminUi.test.js`

**Interfaces:**
- Produces: same `<tr data-api-call-row>` row structure and column count; `<td>` for Method/Status get color via inline `style` computed from `a.method`/`a.status`/`a.error`, replacing the old blanket `status-badge status-muted`. The `<details>/<summary>` detail expansion becomes two side-by-side bordered boxes (`REQUEST`, `ERROR`/`RESPONSE`) inside the same `<details>` element (keeps the native disclosure behavior and zero-JS requirement, only the *inside* of `<details>` changes layout). **All content ships in the initial HTML** — `<details>` without `open` still contains its children in the DOM/response body, satisfying the Global Constraint.

- [ ] **Step 1: Add a method/status color helper at the top of the file**

```html
<%
  function methodColor(m) {
    if (m === 'GET') return 'var(--color-ok)';
    if (m === 'POST' || m === 'PUT' || m === 'PATCH') return 'var(--color-amber)';
    if (m === 'DELETE') return 'var(--color-danger)';
    return 'var(--color-ink-500)';
  }
  function statusColor(status, error) {
    if (error) return 'var(--color-danger)';
    if (status == null) return 'var(--color-ink-300)';
    if (status >= 200 && status < 300) return 'var(--color-ok)';
    if (status >= 400) return 'var(--color-danger)';
    return 'var(--color-amber)';
  }
%>
```

- [ ] **Step 2: Rewrite the table body row**

Replace the `<td>` for Method, Status, and Detail:

```html
          <td style="font-family:var(--font-mono);font-size:0.75rem;color:<%= methodColor(a.method) %>"><%= a.method %></td>
          <td class="max-w-xl truncate">
            <span style="font-family:var(--font-mono);font-size:0.8125rem;color:var(--color-ink-500)"><%= a.url %></span>
          </td>
          <td style="font-family:var(--font-mono);font-size:0.75rem;color:<%= statusColor(a.status, a.error) %>"><%= a.status || (a.error ? 'error' : '-') %></td>
          <td>
            <% if (a.request_params || a.response_body || a.error) { %>
            <details>
              <summary style="cursor:pointer;font-family:var(--font-mono);font-size:0.75rem;color:var(--color-ink-500)">View</summary>
              <div style="margin-top:0.625rem;display:grid;grid-template-columns:1fr 1fr;gap:0.875rem">
                <% if (a.request_params) { %>
                <div style="border:1px solid var(--color-border);border-radius:var(--radius);padding:0.6875rem 0.875rem">
                  <div class="kicker">Request<% if (a.duration_ms != null) { %> · <%= a.duration_ms %>ms<% } %></div>
                  <pre style="margin-top:0.4375rem;max-height:12rem;overflow:auto;white-space:pre-wrap;background:none;border:none;padding:0;font-size:0.71875rem"><%= a.request_params %></pre>
                </div>
                <% } %>
                <% if (a.error) { %>
                <div style="border:1px solid color-mix(in srgb, var(--color-danger) 40%, transparent);border-radius:var(--radius);padding:0.6875rem 0.875rem">
                  <div class="kicker" style="color:var(--color-danger)">Error</div>
                  <pre style="margin-top:0.4375rem;max-height:16rem;overflow:auto;white-space:pre-wrap;background:none;border:none;padding:0;font-size:0.71875rem;color:var(--color-danger)"><%= a.error %></pre>
                </div>
                <% } else if (a.response_body) { %>
                <div style="border:1px solid var(--color-border);border-radius:var(--radius);padding:0.6875rem 0.875rem">
                  <div class="kicker">Response</div>
                  <pre style="margin-top:0.4375rem;max-height:16rem;overflow:auto;white-space:pre-wrap;background:none;border:none;padding:0;font-size:0.71875rem"><%= a.response_body %></pre>
                </div>
                <% } %>
              </div>
            </details>
            <% } else { %>-<% } %>
          </td>
```

Leave `<td><%= a.created_at %></td>`, the optional Conversation `<td>`, and
the `Group` `<td>` untouched.

- [ ] **Step 3: Run the regression tests**

Run: `node --test tests/adminUi.test.js`
Expected: PASS —
`'conversation detail shows the API calls made by that conversation with
full detail'` still finds `[data-api-call-row]` (1 row), `txn_123` (not
`txn_OTHER`), and the raw `"limit"`/`"total"` JSON substrings (still present,
now inside the Request/Response boxes instead of a flat `<pre>`, but present
in the HTML response body regardless of the `<details>` `open` state).

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add views/conversations/_api-calls-table.ejs
git commit -m "style: color-code API-call methods/statuses and split detail into request/error columns"
```

---

## Task 20: Conversation detail — timeline restyle

**Files:**
- Modify: `views/conversations/detail.ejs`

**Interfaces:**
- Consumes: `.chat-bubble-user`/`.chat-bubble-agent`/`.chat-avatar`/`.kicker` from Task 18. Same `messages`/`apiCalls`/`project`/`conv` locals — no controller change.

- [ ] **Step 1: Rewrite the header with a breadcrumb**

Replace `views/conversations/detail.ejs:3-16`:

```html
<div style="margin-bottom:1.5rem;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:1rem;border-bottom:1px solid var(--color-border);padding-bottom:1.125rem">
  <div>
    <p class="kicker"><a href="/admin/projects/<%= project.id %>/conversations">← <%= project.name %> / Audit</a></p>
    <div style="display:flex;align-items:baseline;gap:0.875rem;margin-top:0.375rem">
      <h1 class="page-title" style="font-size:2rem">Conversation <em style="font-style:italic;color:var(--color-brand)">no. <%= conv.id %></em></h1>
      <span class="status-badge <%= conv.status === 'active' ? 'status-active' : 'status-muted' %>"><%= conv.status %></span>
    </div>
  </div>
</div>
```

(Test note: this drops the "Back to conversations" `.btn-secondary` link
that no other test locks by href/text on *this specific page* — confirm via
`grep -n "Back to conversations" tests/*.test.js` before removing; if a test
depends on it, keep the link and place it inline next to the status badge
instead of removing it. Based on the audit in Task 7/13's research pass, no
test in `tests/adminUi.test.js` asserts on this specific link text, only on
`/admin/projects/:id/conversations` links elsewhere — but re-verify with the
grep before deleting, since this step is destructive if wrong.)

- [ ] **Step 2: Rewrite the message timeline to the quote/bubble pattern**

Replace `views/conversations/detail.ejs:18-51`:

```html
<section class="message-timeline" style="margin-bottom:1.5rem">
  <% if (!messages.length) { %>
    <div style="padding:2.5rem;text-align:center;color:var(--color-ink-500);font-size:0.875rem">No messages in this conversation.</div>
  <% } else { %>
  <div style="max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:1rem">
    <% for (const m of messages) { %>
      <% const isIn = m.direction === 'in'; %>
      <article class="chat-row <%= isIn ? 'chat-row-user' : 'chat-row-agent' %>">
        <% if (!isIn) { %>
          <div class="chat-avatar">OT</div>
        <% } %>
        <div>
          <div class="kicker" style="<%= isIn ? 'text-align:right' : '' %>;margin-bottom:0.3125rem">
            <%= isIn ? (m.user_name || 'user') : 'agent' %> · <%= m.created_at %>
          </div>
          <div class="chat-bubble <%= isIn ? 'chat-bubble-user' : 'chat-bubble-agent' %>">
            <% if (isIn) { %>
              <div style="white-space:pre-wrap"><%= m.content %></div>
            <% } else { %>
              <div class="msg-content" data-raw="<%= encodeURIComponent(m.content || '') %>"></div>
            <% } %>
          </div>
        </div>
      </article>
    <% } %>
  </div>
  <% } %>
</section>
```

- [ ] **Step 3: Rewrite the API-calls section**

Replace `views/conversations/detail.ejs:53-65`:

```html
<section>
  <div class="kicker" style="margin-bottom:0.625rem">§ API calls in this conversation</div>
  <% if (apiCalls && apiCalls.length) { %>
    <%- include('_api-calls-table', { apiCalls, showConversation: false }) %>
  <% } else { %>
    <div style="border-radius:var(--radius);border:1px dashed var(--color-border-strong);background:var(--color-panel-alt);padding:1.5rem;text-align:center;font-size:0.875rem;color:var(--color-ink-500)">
      No API calls were made during this conversation.
    </div>
  <% } %>
</section>
```

- [ ] **Step 4: Update the markdown-render `<script>`'s hardcoded `pre` colors**

Replace the inline style string in the trailing `<script>` block:

```js
    pre.style.cssText = 'background:#0d1424;color:#c8d3f5;border-radius:0.5rem;padding:0.75rem;overflow-x:auto;font-size:0.8125rem;margin:0.5rem 0;border:1px solid rgba(255,255,255,0.06)';
```

with:

```js
    pre.style.cssText = '';
    pre.style.background = 'var(--color-panel-alt)';
    pre.style.color = 'var(--color-ink-700)';
    pre.style.borderRadius = 'var(--radius)';
    pre.style.padding = '0.75rem';
    pre.style.overflowX = 'auto';
    pre.style.fontSize = '0.8125rem';
    pre.style.margin = '0.5rem 0';
    pre.style.border = '1px solid var(--color-border)';
```

- [ ] **Step 5: Run tests**

Run: `node --test tests/adminUi.test.js`
Expected: PASS —
`'conversation detail shows the API calls made by that conversation with
full detail'` (unaffected, same `_api-calls-table` partial), and
`'conversation detail renders message timeline'`: check its exact
assertions —

```js
  assert.strictEqual($('h1').text().trim(), `Conversation #${conversation.id}`);
```

This **breaks** with Step 1's new `<h1>` markup (`Conversation <em>no.
${id}</em>` — `.text()` concatenates the `<em>` text too, giving
`"Conversation no. 1"`, not `"Conversation #1"`). Update this assertion in
the same commit:

```js
  assert.strictEqual($('h1').text().trim(), `Conversation no. ${conversation.id}`);
```

Leave every other assertion in that test (`/Payment/`, `/ses_abc/`, `/Son/`,
`/investigate txn_123/`, the URL-encoded outbound-message regex,
`/message-timeline/`) unchanged — none of them depend on exact `<h1>`
wording.

- [ ] **Step 6: Re-run and run the full suite**

Run: `node --test tests/adminUi.test.js`
Expected: all PASS with the Step 5 fix applied.

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add views/conversations/detail.ejs tests/adminUi.test.js
git commit -m "style: restyle conversation detail timeline to match the chat bubble/quote pattern"
```

---

## Task 21: Remaining icon-removal sweep

**Files:**
- Modify: `views/projects/form.ejs` (header action buttons: Projects/Chat/OpenCode/Audit/Sync now/Save project)
- Modify: `views/projects/_repo-row.ejs` (Remove button)
- Modify: `views/conversations/list.ejs` (Back to project button — already partially handled by Task 17's header rewrite; verify)
- Modify: `views/projects/chat.ejs` (Back button already removed by Task 17; verify no leftover SVG)

**Interfaces:**
- No interface change — every touched button keeps its exact current text content (`New project`, `Save project`, `Chat`, `OpenCode`, `Audit`, `Sync now`, `Remove`, etc.) per the Global Constraints; only the `<svg>...</svg>` children are deleted.

- [ ] **Step 1: Strip icons from `form.ejs`'s header action buttons**

In `views/projects/form.ejs`, the header action row (`Projects`, `Chat`,
`OpenCode`, `Audit`, `Sync now`, `Save project` links/buttons) each currently
render `<svg width="14" ...>...</svg>` before their text. Remove every such
`<svg>...</svg>` block in this section, leaving e.g.:

```html
      <a href="/admin/projects" class="btn btn-secondary">Projects</a>
```

instead of the icon+text version. Do this for all six buttons in that
section (Projects, Chat, OpenCode, Audit, Sync now, Save project). Do not
change any `href`, `type`, `form`, or text content — only delete the `<svg>`
tags.

- [ ] **Step 2: Strip the icon from `_repo-row.ejs`'s Remove button**

Replace:

```html
    <button type="button" class="btn btn-danger" data-remove>
      <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="..."/></svg>
      Remove
    </button>
```

with:

```html
    <button type="button" class="btn btn-danger" data-remove>Remove</button>
```

- [ ] **Step 3: Strip the icon from `form.ejs`'s "Add repo"/"Add API" buttons**

Replace:

```html
        <button type="button" class="btn btn-secondary" data-add="repos" style="flex-shrink:0">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="..."/></svg>
          Add repo
        </button>
```

and the matching "Add API" button, with icon-less versions (keep
`+` as a literal leading character per the mock's dashed-button convention):

```html
        <button type="button" class="btn btn-secondary" data-add="repos" style="flex-shrink:0">+ Add repo</button>
```

```html
        <button type="button" class="btn btn-secondary" data-add="apis" style="flex-shrink:0">+ Add API</button>
```

Also restyle the two `data-rows` container's trailing "add" buttons to use
the dashed empty-state look from the mock (border style only, not text
case): add `style="border-style:dashed;text-transform:none;font-weight:400"`
to each (this keeps `.btn-secondary`'s color/radius but overrides the border
style and removes the uppercase transform, matching mock `3e`/`3f`'s
sentence-case dashed "add" buttons vs. the all-caps solid buttons
elsewhere).

- [ ] **Step 4: Verify no stray SVGs remain in touched files**

Run: `grep -rn "<svg" views/projects/form.ejs views/projects/_repo-row.ejs views/projects/chat.ejs views/projects/opencode.ejs views/conversations/list.ejs views/conversations/detail.ejs views/projects/list.ejs views/dashboard/index.ejs`
Expected: no matches (Tasks 11, 17, 18, 20 already removed icons from
`list.ejs`, the workspace headers, chat's avatar/empty-state, and
`detail.ejs`'s header; this task removes the rest). If the grep finds a
dashboard-chart-unrelated `<svg>`, leave dashboard's data-visualization
`<svg>` elements alone (Task 9 already handles those deliberately — they're
charts, not icons).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass — every button's text content is unchanged, only `<svg>`
children were deleted, and no test asserts on SVG presence.

- [ ] **Step 6: Commit**

```bash
git add views/projects/form.ejs views/projects/_repo-row.ejs
git commit -m "style: remove remaining decorative SVG icons from project-form buttons"
```

---

## Task 22: Full regression pass + manual QA in both themes

**Files:** none (verification-only task)

- [ ] **Step 1: Run the full automated suite one more time**

Run: `npm test`
Expected: all tests across all 19 test files pass.

- [ ] **Step 2: Rebuild CSS for production**

Run: `npm run build:css`
Expected: exits 0, `public/styles/admin.css` regenerated.

- [ ] **Step 3: Start the app and drive it in a real browser**

Use the `/run` skill (or `npm start` + open `http://localhost:<ADMIN_PORT>/admin/login`
manually if `/run` isn't set up for this repo) and walk the golden path in
**dark** (default) then **light** (via the sidebar theme toggle) for:

1. Login — configured state; then unset `ADMIN_USERNAME`/`ADMIN_PASSWORD` in
   a scratch `.env` to see the "not configured" warning; submit wrong
   credentials to see the error alert.
2. Dashboard — metrics ledger row, chart (no gradient/glow, single accent
   peak dot, hover tooltip), 7D/30D/90D links, project filter, by-project
   table.
3. Projects list — table, keyword bracket tag, sync status glyphs
   (● ◆ ✕ ○), row actions, empty state (temporarily delete all seeded
   projects to see it, or check via a fresh DB).
4. Project form — Core/Repositories/API tabs switch without reload; repo
   segmented auth-type control (None/Token/SSH) shows/hides the token/SSH
   fields; a repo row with `sync_status: 'error'` shows the oxide error box;
   API groups: saved ones collapsed by default with the parsed-info bar, a
   newly-added one starts expanded, Expand button works; validation errors
   (submit an invalid slug) show the oxide error box with bullet list.
5. Chat workspace — empty state with prompt chips, sending a message (needs
   a working OpenCode backend or can be smoke-tested against the SSE
   contract only), agent-busy banner, tab bar switches to OpenCode/Audit.
6. OpenCode workspace — iframe loads, tab bar present.
7. Audit (conversations list) — sessions table, API calls table with
   method/status colors, expand a row with `request_params`/`error` set to
   see the two-column Request/Error boxes.
8. Conversation detail — timeline quote/bubble pattern, API calls table.

- [ ] **Step 4: Record and fix any visual defects found**

If a defect is found that isn't a regression covered by an existing task
(e.g. a spacing issue, a missed `<svg>`, a token that resolves to `transparent`
unexpectedly), fix it directly in the relevant file from the task list above,
re-run `npm test`, and commit as a small fixup referencing the task it
belongs to — do not silently leave it.

- [ ] **Step 5: Final commit (if any fixups were made in Step 4)**

```bash
git add -A
git commit -m "fix: address visual QA findings from Bureau Ledger redesign pass"
```

If Step 4 found nothing to fix, this task ends at Step 3 with no commit.

---

## Self-review notes

- **Spec coverage:** every numbered section of
  `docs/superpowers/specs/2026-07-08-bureau-ledger-redesign-design.md` maps
  to a task: §1 tokens → Task 1–2, §2 layout shell → Task 7, §3 components →
  Tasks 3–6, §4.1–4.10 page changes → Tasks 8–12, 13, 17–20, §5 cross-cutting
  fixes → Tasks 6, 15, 19, 20 (pre code-block colors), §6 implementation
  order → the task ordering itself. Icon removal (spec §4, called out as a
  sweep) → Task 21.
- **Placeholder scan:** no `TBD`/`TODO`; every step has literal code or an
  exact command with expected output; Task 20 Step 1 and Task 12 Step 1 both
  include an explicit `grep` verification step rather than assuming safety,
  because they involve deleting existing markup a test *might* depend on.
- **Type/name consistency:** `layoutShell`/`sidebarProjects` locals (Task 7)
  are consumed identically in Tasks 8 and 11; `.tab-bar`/`.tab-item`/
  `.tab-item-active`/`.tab-count` (Task 5) are used with the same class names
  in Tasks 13 and 17; `data-auth-type-group` (Task 14) replaces
  `data-auth-type-select` consistently in both `_repo-row.ejs` and the
  `updateAuthFields()`/listener code in `form.ejs`; `data-collapsed`/
  `data-collapsed-summary`/`data-collapsed-body`/`data-expand` (Task 16) are
  used consistently between the partial and the new JS.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-08-bureau-ledger-redesign.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
