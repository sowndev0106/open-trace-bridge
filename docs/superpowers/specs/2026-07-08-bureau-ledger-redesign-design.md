# Design: Admin Console Redesign — "Bureau Ledger" theme

Date: 2026-07-08
Status: approved by user (brainstorming session)
Source: `Admin Console Redesign.dc.html` (Claude Design project "Admin console
architecture", turns `t4` foundation + `3a`–`3k` page groups)

## Goal

Re-theme the entire admin console (all pages behind `/admin`, private port)
from the current "gradient SaaS" look (Outfit/JetBrains Mono, blue/purple
gradients, glow shadows, rounded-xl pill badges) to the "Bureau Ledger" design
system: a dark-ink-default / paper-light editorial theme built on Newsreader
(serif), Archivo (sans), and Spline Sans Mono, with a single "oxide" accent
color, near-square corners, hairline rules, and status glyphs (`●` `◆` `✕`
`○`) instead of pill badges.

Scope: foundation (tokens, layout shell, component library) **and** all 8 page
groups from the mock, in one implementation project, broken into ordered
phases so each phase is independently reviewable.

The public event-ingestion app is untouched — this only affects `views/**` and
`assets/styles/admin.css` behind the admin/private boundary.

## Decisions made during brainstorming

- Full scope now: foundation + all 8 page groups, not an incremental
  per-page rollout.
- Layout shell has **two modes**, not one sidebar-everywhere shell:
  - `index` shell (sidebar) — Dashboard, Projects list.
  - `detail` shell (no sidebar, breadcrumb kicker instead) — project form,
    Chat/OpenCode/Audit workspace, conversation detail, new-project form.
- Dark ("Ink") is the **default** theme; light ("Paper") is the alternative,
  reachable via `prefers-color-scheme` or the existing toggle. This flips the
  current default (light) but reuses the existing `.dark` class + localStorage
  + `matchMedia` toggle mechanism unchanged — only the fallback-when-no-stored-
  preference logic changes to default dark instead of following system
  preference.
- Core/Repositories/API endpoints on the project form become **client-side
  tabs** (JS show/hide, single form, single route) instead of one long
  scrolling page — matches the mock's "ONE SAVE WRITES ALL TABS" note without
  splitting the route.
- Chat/OpenCode/Audit stay **separate routes** as today; they get a shared
  tab-bar component so the three pages *read* as tabs of one workspace even
  though navigating between them is a real page load.
- API endpoint groups on the form get **collapse/expand** (client-side state
  only, no backend change) — matches the mock instead of always-expanded.
- TOAST UI Editor (system prompt, API description) is **kept**, not replaced.
  Its own toolbar chrome is reskinned via CSS overrides, accepting it won't be
  pixel-identical to the mock's simplified toolbar sketch.
- Repo row "Auth type" becomes a 3-way **segmented control** (radio-based,
  CSS-only), replacing the native `<select>`.
- Dashboard's `7D/30D/90D` range picker becomes 3 query-string links instead
  of an auto-submitting `<select>`.
- All decorative SVG icons on buttons are removed, replaced by plain text or
  the specific Unicode glyphs the mock uses (`⟳` `✕` `←` `→` `▸` `▾` `↗` `◐`
  `◑` `+`).

## 1. Design tokens & typography

`assets/styles/admin.css` keeps its existing CSS variable **names**
(`--color-canvas`, `--color-panel`, `--color-panel-alt`, `--color-border`,
`--color-border-strong`, `--color-ink-950/700/500/300`, `--color-brand`,
`--color-success`, `--color-warning`, `--color-danger`) so every EJS file that
already reads `var(--color-*)` repaints automatically. Only values change,
plus a few new tokens:

- `:root` (no `.dark` class) = **Paper light**: canvas `#F2EEE3`, panel
  `#FBF8F0`, border `#D8D2C2`/`#C8C2B2`, ink `#201C15`/`#5F594A`/`#98917E`,
  brand/accent (oxide) `#BC4A2E`, success `#5B8452`, warning (amber)
  `#A87A24`, danger = oxide.
- `.dark` = **Ink dark**: canvas `#141210`, panel `#1B1815`, border
  `#2E2921`/`#3A342B`, ink `#EAE3D4`/`#A79E8B`/`#6E6657`, brand/accent (oxide)
  `#D65A3C`, success `#8CB878`, warning (amber) `#D9A644`, danger = oxide.
- New tokens: `--color-ok` (alias of success), `--color-amber` (alias of
  warning, used for pending/syncing glyph + amber kickers), `--color-muted`
  (maps to `--color-ink-300` — used for closed/muted glyph).
- `--font-serif: 'Newsreader', serif` — page titles, big stat numerals,
  italic-accented words.
- `--font-sans: 'Archivo', sans-serif` — replaces Outfit. Section heads,
  button labels, body copy.
- `--font-mono: 'Spline Sans Mono', monospace` — replaces JetBrains Mono.
  Data values, slugs, URLs, timestamps, code, kickers.
- `--radius: 2px` — replaces the current 0.5rem–1rem scale everywhere
  (buttons, inputs, cards, tables).
- Removed: `--grad-brand`, `--grad-canvas`, `--color-brand-glow`, and every
  `box-shadow` glow. No gradients anywhere, including the dashboard SVG chart
  (`linearGradient`, `feGaussianBlur` glow filter are deleted).

Font loading: `layout-head.ejs` and `login.ejs` swap their Google Fonts
`<link>` to Newsreader (400/500/600, italic 400/500) + Archivo
(400/500/600/700/800) + Spline Sans Mono (400/500/600), matching the mock's
`css2?family=...` URL.

Theme default: the inline anti-flicker script in `layout-head.ejs` currently
does `stored === 'dark' || (!stored && matchMedia(dark))`. It changes to
`stored ? stored === 'dark' : true` — i.e. dark is the default whenever there
is no explicit stored preference, regardless of system preference. The toggle
button and localStorage persistence logic are otherwise unchanged.

## 2. Layout shell — two modes

`layout-head.ejs`/`layout-foot.ejs` render one of two shells, selected by a
local var each view sets before including the head partial (e.g.
`<% const layoutShell = 'index' %>`, default `'detail'` if unset):

**`index` shell** (Dashboard, Projects list):
- Fixed left sidebar, 216px, hairline right border.
- Top block: wordmark "OpenTraceBridge." (period in accent color) + kicker
  "ADMIN CONSOLE — PRIVATE".
- Nav: two numbered items (`01 Dashboard`, `02 Projects`), active item gets a
  2px accent left border + faint accent-tinted background.
- "REGISTER — N" kicker + live list of projects (slug + status glyph),
  reusing the same project list data already loaded for the projects page;
  on Dashboard this becomes a small supplementary query (project id + slug +
  sync status only).
- Bottom, pinned via `margin-top:auto`: theme toggle line (`◐ Dark — switch to
  light` / `◑ Light — switch to dark`, replacing the current icon-button
  toggle) and `← Log out` (replacing the current form-styled-as-button
  logout).
- Main content area to the right, full remaining width.

**`detail` shell** (project form, Chat/OpenCode/Audit workspace, conversation
detail, new-project form):
- No sidebar. Full-width content.
- A `.kicker` breadcrumb line above the page title, e.g. `← Projects / Edit
  entry no. 01` or `← Payments API / Audit`, replacing the current
  "Back"-button pattern. The leading `←` is a real link back to the parent
  page.

Both shells share the same `<main>` content styling (page kicker, page title,
page subtitle) already defined as `.page-kicker`/`.page-title`/
`.page-subtitle` in `admin.css` — only their type tokens change (title moves
to `--font-serif`, kicker to `--font-mono`).

## 3. Component library

Reused class names, restyled internals (no EJS call-site changes needed
beyond removing stray icons):

| Class | New behavior |
|---|---|
| `.btn-primary` | Invert-fill: `background: var(--color-ink-950); color: var(--color-canvas)` in light, and the mirror in dark (paper-on-ink). **Not** accent-colored — oxide is reserved for links/underlines/error states, not primary CTAs. `--radius`, bold Archivo label, uppercase where the mock shows it, no shadow. |
| `.btn-secondary` | Hairline border, muted ink text, no fill. |
| `.btn-danger` | Hairline border tinted oxide (`rgba(oxide,.4)`), oxide text, no fill — an outline-only "destructive" style, not a solid red button. |
| `.status-badge` + `.status-active/muted/error/syncing` | Drop the pill shape, border, and background entirely. Render as inline mono text with a literal glyph prefix via `::before`: `●` (active/ok, success color), `◆` (syncing/pending, amber, keeps the existing `pulse-dot` animation applied to the glyph), `✕` (error, oxide), `○` (muted/closed, muted color). Class names and template call sites are unchanged. |
| `.panel`/`.panel-body` | Hairline border, `--radius`, no shadow, no hover-lift transform. |
| `.data-table` | Hairline row dividers (no zebra/hover-bg beyond a very subtle tint), mono uppercase tracked headers, numeric columns right-aligned, primary/name column can opt into `--font-serif` at a larger size for emphasis rows (dashboard "by project" table). |
| `.tab-bar` / `.tab-item` / `.tab-item-active` *(new)* | Flex row, hairline bottom border on the bar; active item gets a 2px accent underline + bold; item can carry a small mono count suffix (`/2`, `/3`). Used by: project-form Core/Repos/API tabs (client-side) and the Chat/OpenCode/Audit workspace tab bar (real links). |
| `.kicker` *(new)* | `--font-mono`, 10px, `letter-spacing:.18em`, uppercase, muted or amber depending on context. Used for section labels (`§ 01 — COLOR`), breadcrumbs, and inline meta notes (`ONE SAVE WRITES ALL TABS`, `POLLING SYNC STATUS EVERY 3S`). |
| `.segmented` *(new)* | 3-way (or N-way) toggle: radio inputs + labels in a bordered row, active label gets filled background. Used only for repo "Auth type". |
| Form inputs/textarea/select | Field background = `--color-panel-alt`, hairline border, `--radius`, focus state swaps border color to accent (no glow ring). Labels: mono-ish uppercase 11px, required fields get an oxide `*`. |
| `.error`/`.error-list` | Hairline oxide-tinted border box, no red-tinted background fill — matches the mock's validation box style (`✕ N ERRORS — NOTHING WAS SAVED` kicker + bullet list). |
| `.empty-state` / chat empty state | Bordered square mark with serif "OT" initials (replacing the gradient icon box), serif heading with one accent-italic word, mono/sans subtitle, bordered (not pill) suggestion chips. |

Method/status color mapping (new logic, not just CSS): GET → success color,
POST → amber, DELETE → oxide; HTTP status 2xx → success, 4xx/5xx → oxide.
Applied in `_api-calls-table.ejs` and anywhere else methods/statuses render.

## 4. Page-by-page structural changes

1. **Login** (`login.ejs`) — currently a standalone HTML file with its own
   animated-gradient/floating-orb background. Rewritten as a split screen:
   left panel = brand statement (kicker "Est. 2026 · Internal instrument",
   serif wordmark with accent period, italic tagline, mono stat row) on a
   subtle repeating-hairline background (56px ruled-paper texture, very low
   opacity); right panel = "Private access" form (kicker "FORM NO. 001",
   labeled fields, `SIGN IN →` primary button). All existing functional
   pieces are preserved: `next` hidden field, "not configured" warning (amber
   bordered box), invalid-credentials error (oxide bordered box), rate-limit
   copy, disabled-button-when-not-configured state.

2. **Dashboard** (`dashboard/index.ejs`) — `index` shell. Metric cards go from
   6 separate bordered/icon cards to **one row divided by hairline vertical
   rules**, serif numerals, small mono trend line below each (color-coded:
   green good / oxide bad / muted neutral, matching each metric's existing
   trend-direction logic). SVG chart: drop `linearGradient`/glow `filter`,
   render a single-color polyline with small dots at each point and one
   larger accent dot + value label at the peak (existing peak-detection logic
   in the EJS stays, only the render style changes). Range picker (`7D 30D
   90D`) becomes 3 links carrying `?days=N&project=...`, replacing the
   `<select name="days">` auto-submit. Project filter stays a native
   `<select>`, restyled (mono font, hairline border, custom arrow glyph).

3. **Projects list** (`projects/list.ejs`) — `index` shell. Table restyled
   per the component table above; keyword shown as a bracketed mono tag
   (`[pay]`); actions column keeps the same five actions (Chat/OpenCode/
   Logs/Edit/Delete) but as icon-less text buttons (`CHAT` primary,
   `CODE`/`LOGS`/`EDIT` secondary, `✕` danger icon-only).

4. **Project form** (`projects/form.ejs`) — `detail` shell. Core settings /
   Repositories / API endpoints become client-side tabs: wrap each existing
   `<section class="panel">` in a `[data-tab-panel="core|repos|apis"]`
   container, add a `.tab-bar` above the form driven by ~20 lines of JS
   (show one panel, hide the others, no page reload, "Save" still submits the
   whole form regardless of active tab — preserving "one Save writes all
   tabs"). Integration webhook box restyled with the `COPY` button pattern
   and quick links to `#chat-history`/`#api-calls` on the Audit page.

5. **`_repo-row.ejs`** — Auth type native `<select>` replaced by the new
   `.segmented` control (3 radio inputs `none|https-token|ssh`); the existing
   `updateAuthFields()` JS in `form.ejs` is retargeted from
   `[data-auth-type-select]` (a `<select>`) to the radio group (still a
   `change` listener, same show/hide logic for token/SSH sub-fields). Status
   line restyled with the new glyph-based `.status-badge`. Error message box
   (sync error) restyled as a bordered oxide box instead of a truncated
   single line.

6. **`_api-row.ejs`** — **Cleanup pass first**: remove all hardcoded Tailwind
   utility classes (`rounded-lg`, `border-line`, `bg-white`, `text-ink-950`,
   `focus:border-brand`, etc.) so inputs inherit the base-layer styling like
   `_repo-row.ejs` does (this also fixes an existing dark-mode bug where these
   inputs stay white). Then: add collapse/expand — each row gets a
   `data-collapsed` state; collapsed view shows name + parsed host + methods
   inline with `EXPAND`/`REMOVE`; expanded view is today's full field set
   plus the new "parsed info bar" (`✓ PARSED` / `BASE` / `METHODS` / `AUTH` /
   `KEY` items, sourced from the existing `a.base_url`/`a.allowed_methods`/
   `a.auth_header` fields, no new data needed). Newly-added rows start
   expanded; existing saved rows start collapsed except the first.

7. **Chat / OpenCode / Audit workspace** (`projects/chat.ejs`,
   `projects/opencode.ejs`, `conversations/list.ejs`) — `detail` shell, share
   a `.tab-bar` partial (Chat/OpenCode/Audit as real links to the three
   routes). Chat bubbles: user message stays a solid-fill bubble
   (`.chat-bubble-user`, right-aligned); agent message drops the bubble box
   entirely in favor of a left-border quote style (`border-left:2px solid`,
   no background), matching the mock's "unified chat" look; avatar changes
   from a gradient rounded square to a hairline-bordered square with serif
   "OT". Tool-call status rows (`call_api — GET ... running…`) keep their
   pulsing-dot treatment, recolored to amber. Empty state and busy banner
   restyled per component section above; the composer hint text
   (`ENTER ↵ SEND · SHIFT+ENTER NEWLINE`, `ONE RUN PER PROJECT AT A TIME —
   CONCURRENT SENDS RETURN 409`) is added as static mono copy under the
   composer, matching the mock.

8. **`_api-calls-table.ejs`** — Method/Status get the new color mapping.
   Detail expansion is restructured from a native `<details>`/single `<pre>`
   into the mock's two-column `REQUEST` / `ERROR` (or `REQUEST` / `RESPONSE`)
   bordered boxes; existing `bg-slate-50`/`bg-red-50`/`text-red-700` hardcoded
   Tailwind color classes are removed in favor of theme tokens so it works in
   both themes. The expand affordance becomes a `▸`/`▾` text glyph (toggled
   via a small amount of JS or a styled `<details>` with `::marker` content
   swapped to the glyphs — implementer's choice at build time, functionally
   equivalent).

9. **Conversation detail** (`conversations/detail.ejs`) — `detail` shell.
   Message timeline restyled to match the chat page's bubble/quote pattern,
   with sender/channel/time meta line above each message (mono, right-aligned
   for user messages, left-aligned for agent messages) as in mock `3j`.

10. **New project + validation** (`projects/form.ejs`, create mode) — same
    tabs as edit mode but Repositories/API endpoints tabs show `/0` counts
    and an empty-state row instead of the integration box (which only
    appears after first save, per the existing `isEditing` check already in
    the template). Validation error box restyled per the `.error` component
    change; the existing `errorList` rendering logic is untouched.

## 5. Cross-cutting fixes bundled into this project

These aren't new features, but the redesign is blocked without them:

- `_api-row.ejs`: strip hardcoded Tailwind utility classes (see §4.6) —
  fixes a live dark-mode bug (white input backgrounds) as a side effect.
- `_api-calls-table.ejs`: replace hardcoded `slate`/`red` Tailwind classes
  with theme tokens (see §4.8).
- `.chat-bubble-agent pre` (in `admin.css`) and the two inline `<script>`
  blocks that style rendered-markdown `<pre>` in `chat.ejs` and
  `conversations/detail.ejs` (currently hardcoded `#0d1424`/`#c8d3f5`) all
  move to theme tokens so code blocks match the ledger palette in both
  themes.
- `.toastui-editor-*` overrides in `admin.css`: currently only defined under
  `.dark`. Add an equivalent `:root`-scoped (light/paper) block, and update
  the existing dark block's colors to the new ink palette.

## 6. Implementation order (phases)

1. Tokens + fonts in `admin.css`/`layout-head.ejs`/`login.ejs` only — no
   markup changes yet. Verify nothing currently visible breaks (existing
   pages just repaint with new colors/fonts through the shared variables).
2. Component layer in `admin.css`: buttons, status glyphs, panels, tables,
   `.tab-bar`, `.kicker`, `.segmented`, form fields, error box, TOAST UI /
   markdown `pre` overrides for both themes.
3. Layout shell: `index` vs `detail` modes in `layout-head.ejs`/
   `layout-foot.ejs`.
4. Login rewrite.
5. Dashboard (metrics ledger row + chart rewrite + range-picker links).
6. Projects list.
7. Project form: tabs (Core/Repos/API), `_repo-row.ejs` segmented control,
   `_api-row.ejs` cleanup + collapse/expand.
8. Chat + OpenCode + Audit: shared tab bar, chat bubble restructure,
   `_api-calls-table.ejs` restructure.
9. Conversation detail.
10. Icon-removal sweep across all touched files (can run alongside each
    phase above rather than as a separate pass, but called out so it isn't
    missed on any one file).
11. Manual QA in both themes (dark default + light via toggle) using the
    `/run` skill against a real browser session — golden path per page plus
    empty/error/loading states already present in the mock (auth failed repo,
    sync error, validation errors, agent-busy banner, empty chat, timeout API
    call).

## Out of scope

- Any backend/route/data-model change. This is a view-layer (`views/**`,
  `assets/styles/admin.css`) redesign only.
- The public event-ingestion app (separate port) — untouched.
- Pixel-perfect replication of the TOAST UI Editor toolbar to the mock's
  simplified B/I/H2 sketch — CSS reskin of the real toolbar only.
