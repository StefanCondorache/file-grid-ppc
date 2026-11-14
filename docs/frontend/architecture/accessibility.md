# FileGrid PPC frontend: WCAG 2.2 AA plan

Scope: Next.js App Router, React, TypeScript. Target: WCAG 2.2 Level AA on all demo screens (SC-01..SC-11),
Lighthouse accessibility >= 95 and zero axe violations (PRD §5, FE-16). Laptop >= 1440 px is the demo target.
Romanian UI copy appears only in examples. Requirement IDs refer to `docs/frontend/prd.md`.

Contrast ratios below were computed by hand with the WCAG formula (relative luminance, `(L1+0.05)/(L2+0.05)`),
rounded to 2 decimals. Treat the last digit as +/-0.02. Decision A11Y-7 makes CI recompute every pair, so the
table is verified by code before it is trusted.

## 1. Colour and contrast

### 1.1 What the PPC palette gives us

Ratio of each colour against the neutrals. For "colour as text on X" and "white text on colour" the number is
the same when X is white. "Dark" = `#232936`.

| Colour | on #FFF | on #FAFAFA | on #F5F5F5 | Dark text on colour | Verdict |
|---|---|---|---|---|---|
| orange `#FF4B00` | 3.36 | 3.23 | 3.08 | 4.34 | Not text (needs 4.5). UI boundary/graphic OK (3:1). White text only at large size. |
| cyan `#00A0DC` | 2.97 | 2.85 | 2.73 | 4.90 | Fails even 3:1. Decoration, or a fill carrying dark text. |
| coral `#FF6447` | 2.93 | 2.81 | 2.69 | 4.97 | Fails 3:1. Fill with dark text only. |
| green `#00DC55` | 1.85 | 1.77 | 1.69 | 7.88 | Fill with dark text only. |
| yellow `#FFDA00` | 1.37 | 1.32 | 1.26 | 10.60 | Fill with dark text only. Never a line or icon on white. |
| light blue `#53A7FF` | 2.52 | 2.41 | 2.31 | 5.78 | Fill with dark text only. |
| teal `#0091BD` | 3.63 | 3.48 | 3.33 | 4.01 | Graphics/UI boundary OK. Not normal text either way. |
| PPC blue `#163FE8` | 7.21 | 6.91 | 6.62 | 2.02 | Passes everywhere: links, text, white-on-blue buttons. |
| dark `#232936` | 14.57 | 13.95 | 13.36 | n/a | Body text. |
| dark 75 % (blends to `#5A5F68` on white) | 6.42 | about 6.2 | about 6.1 | n/a | Passes. Use as solid token for input borders. |
| dark 50 % (blends to `#91949B` on white) | 3.04 | about 3.0 | about 3.0 | n/a | Fails text. Disabled/decorative only. |
| grey `#555C5F` | 6.82 | 6.53 | 6.25 | n/a | Muted text OK (also on `#FAEBE6`: 5.87). |
| `#313131` / `#0D0D0D` | 13.01 / 19.44 | 12.47 / 18.6 | 11.93 / 17.8 | n/a | OK. |
| border grey `#D3D5D6` | 1.47 | n/a | n/a | n/a | Fails 1.4.11 as an input border. Decorative dividers only. |

Key findings:

- **Orange `#FF4B00` with white text is 3.36:1.** Fails 4.5 for normal text. Dark text on it is 4.34, also
  failing. Passes 3:1, so it is acceptable for large text (>= 24 px, or >= 18.66 px bold), icons and borders.
- **Cyan with white text is 2.97**: fails even the 3:1 large-text bar. Cyan as a focus ring on white also fails.
- Light-orange `#FAEBE6` as a background: orange boundary on it is 2.89 (fails 3:1); dark text on it is 12.55.

### 1.2 Accessible tokens (proposed)

Brand tokens stay for decoration (illustration, large fills, hero accents, chart gridlines). Everything that
carries text, a control boundary or state uses a functional token.

| Token | Value | Role | Ratio |
|---|---|---|---|
| `--brand-orange` | `#FF4B00` | decoration, large fills, >= 24 px headings on white | 3.36 on white |
| `--brand-cyan`, `--brand-coral`, `--brand-green`, `--brand-yellow`, `--brand-lightblue`, `--brand-teal` | as PPC | decoration only | see 1.1 |
| `--action` | `#C13700` | primary button fill, orange text/icons | white on it 5.50; on `#FAFAFA` 5.27; on `#F5F5F5` 5.05; on `#FAEBE6` 4.74 |
| `--on-action` | `#FFFFFF` | text on `--action` | 5.50 |
| `--text` | `#232936` | body text | 14.57 / 13.36 on F5 |
| `--text-muted` | `#555C5F` | secondary text, placeholders, captions | 6.82 / 6.25 on F5 |
| `--link` | `#163FE8` | links (always underlined), secondary actions | 7.21 / 6.62 on F5 |
| `--info-text` | `#00729E` | cyan-family text and icons | 5.38 white; 4.94 on F5 |
| `--on-cyan` | `#232936` | text on a cyan fill (chips, highlights) | 4.90 |
| `--border-input` | `#5A5F68` | input, select, checkbox boundaries | 6.42 white; about 6.1 on F5 |
| `--border-decor` | `#D3D5D6` | dividers, card edges (never the only boundary of a control) | 1.47, decorative |
| `--focus` | `#232936` + white halo | focus ring | 14.57 white; 4.34 against orange fills |
| `--on-dark` | `#FFFFFF` on `#232936` | tray / dark surfaces, ring flips to white | 14.57 |

The primary button is `--action` `#C13700`, a deeper rust of the brand orange (same hue about 17 degrees), with white text,
pill radius 40 px. Hover/pressed go darker, never lighter. Dark mode is out of scope (not trivial: every
token pair and chart would need a second audit); set `color-scheme: light` only.

### 1.3 Status colours

Rule: a status is always a filled chip with **icon + text**. Colour is the third cue. Icon shapes differ per state
(circle-check, triangle-alert, octagon-x, minus-circle), so deuteranopia/protanopia/tritanopia users still tell
them apart. Teal-green vs crimson are close in lightness, which is why shape and text are mandatory.

| Meaning | Guarantee / storage / integrity text | Chip fill | Chip content | Ratio | Icon |
|---|---|---|---|---|---|
| ok | OK / OK / Verificat | `--status-ok` `#00776A` | white | 5.46 (3:1 vs white page: 5.46) | circle-check |
| warn | În pericol / degradat / (Neverificat is NOT warn, see neutral) | `--status-warn` `#FFDA00` | `#232936` | 10.60 (fill vs white page 1.37, so the chip carries a 1 px `#232936` border, 14.57) | triangle-alert |
| bad | Încălcat / căzut / Fișier corupt detectat | `--status-bad` `#B3123F` | white | 6.83 | octagon-x |
| neutral | Neverificat / necunoscut / în așteptare | `--status-neutral` `#555C5F` | white | 6.82 | minus-circle or clock |

Card accent stripe (4 px left border, supplementary): ok `#00776A` 5.46, warn `#8A5A00` 5.93 (not yellow: 1.37),
bad `#B3123F` 6.83. "Green cards" in PRD beat 1 means `--status-ok`, not brand green `#00DC55`. Error text under
fields uses `#B3123F` (6.83 on white, 6.26 on F5). Danger crimson is deliberately not orange, so it is not
confused with the primary action.

## 2. Design-system rules

**Library.** Radix UI primitives (Dialog, AlertDialog, DropdownMenu, Tabs, Tooltip, Progress, Switch,
Collapsible) plus native HTML for everything else (`<select>`, `<details>`, `<table>`, `<input type=file>`).
Not Radix Select/Toast (screen reader quirks, limited live-region control): native select, own announcer.

**Focus (2.4.7, 2.4.11).** Global `:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px;
box-shadow: 0 0 0 2px #fff }` (via token). Two-tone, so it works on white, orange and dark surfaces. Use
`outline`, not only `box-shadow`, so Windows forced-colors mode keeps it. Never `outline: none` without
replacement. Focus not obscured: sticky header, alert banner and upload tray must never cover the focused
element, so set `scroll-padding-top/bottom` to their heights, and the tray collapses (Esc inside the tray
collapses it, focus returns to its toggle). Pill buttons (radius 40 px) get the same ring with
`border-radius: inherit`. Appearance 2.4.13 is AAA and not required; the ring above meets it anyway.

**Target size (2.5.8).** Minimum 32x32 CSS px on laptop (AA needs 24x24), 44x44 for P2 phone. Icon-only buttons
get a 32 px hit area with `aria-label` in Romanian. Table row actions keep >= 8 px spacing.

**Structure.** `<html lang="ro">`. Landmarks: `<header>` (banner), `<nav aria-label="Principal">`, one `<main id="main">`,
`<footer>`, upload tray `<section aria-label="Încărcări în curs">`, alert banner `<section aria-label="Alerte active">`.
One `<h1>` per page, no skipped levels. Skip links (first focusable, visible on focus): "Sari la conținut" and,
when the tray has items, "Sari la încărcări". `<main tabindex="-1">` is the target.

**Page titles (2.4.2).** Next `metadata.title` template `%s · FileGrid`, per route in Romanian: "Garanții de
business", "Încărcare", "Fișiere", "Detaliu fișier", "Politici", "Observabilitate", "Statistici", "Contoare
live", "Cameră de control demo", "Jurnal de audit", "Autentificare". Titles never include a file name, applicant
name, CNP or any value that could be personal data. On client navigation, move focus to the page `<h1>`
(`tabindex="-1"`), except when only filters or query params change.

**Language, numbers.** `ro-RO` `Intl` formatting, `<time datetime>`. Hashes in `<code translate="no">` with
`overflow-wrap: anywhere` and a "Copiază" button. Body >= 16 px, line-height 1.5. The chosen font must contain
the comma-below glyphs ș ț (U+0218..021B) so that text never falls back. Text must survive WCAG 1.4.12 spacing
overrides: no fixed heights on text containers.

**Reflow (1.4.10).** AA requires no 2-D scrolling at 320 CSS px (400 % zoom on a 1280 laptop). Phone is P2, but the shell must still
collapse: nav becomes a disclosure button below 768 px, single-column grids, forms stacked. Data tables and
charts are exempt but live in a scroll container with `tabindex="0" role="region" aria-label="..."`. Never set
`user-scalable=no` or `maximum-scale`.

**Forms (3.3.1, 3.3.2, 3.3.3, 1.3.5).** Every control has a visible `<label>`; required = "(obligatoriu)" text, not
only an asterisk. Hint and error are linked with `aria-describedby`; invalid fields get `aria-invalid="true"`. Validate on submit
(not per keystroke). On failed submit: error summary at the top of the form
(`<div tabindex="-1">` with `<h2>Există 2 erori</h2>` and links to each field), focus moved to it. Inline errors
have icon + text ("Introduceți un CNP din 13 cifre."), colour `#B3123F`. CNP field: `type="text"`
`inputmode="numeric"` `maxlength="13"` `autocomplete="off"`, hint "13 cifre, fără spații sau liniuțe" in
`aria-describedby`; checksum errors say what to fix. Never `type="number"` and never `type="password"` for it.

**Dragging (2.5.7).** The drop zone is progressive enhancement: the zone contains a real, visible button
"Alege fișiere" (opens `<input type=file multiple>`) and the text "sau trageți fișierele aici". Nothing is
drag-only. The queue has no drag reorder (use "Prioritate" buttons if ever needed).

**Consistent help (3.2.6).** An "Ajutor" link in the same header position on every page, leading to a static
page with contacts and the keyboard shortcut list.

**Redundant entry (3.3.7).** Upload metadata (linie, zonă, categorie) is prefilled from the previous file in the
same batch with an "Aplică la toate fișierele" option. Filters live in the URL and survive navigation and
login return. The re-login after session expiry returns to the same page.

**Accessible authentication (3.3.8).** Login = username + password only, `autocomplete="username"` /
`"current-password"`, paste allowed, no CAPTCHA, no puzzle, no "retype characters". Generic error: "Utilizator
sau parolă incorecte" in the error summary (per FE-01).

**Motion.** `@media (prefers-reduced-motion: reduce)`: no transitions or animations, chart animation off,
counters never animate digit rolls. No auto-playing media.

## 3. Upload progress and live regions

**One announcer.** A single component mounted in the root layout, before any content, renders two always-present
visually-hidden regions: `role="status"` (polite, `aria-atomic`) and `role="alert"` (assertive). All code calls
`announce(message, { priority, key })`. It dedupes by `key`, clears then sets text (so repeats are spoken), and
rate-limits: at most one polite message per 2 s, queued messages collapse into a summary. Components never put
`aria-live` on rapidly changing elements themselves.

**Per-file row** (`<li>` inside `<ul>` in the tray):

```html
<li>
  <span id="f1-name">drona_0412.mp4</span>            <!-- display-safe name -->
  <span>Se încarcă</span> <!-- state text, not colour only -->
  <div role="progressbar" aria-labelledby="f1-name" aria-valuemin="0" aria-valuemax="100"
       aria-valuenow="42" aria-valuetext="42 %, 420 MB din 1 GB, 3 minute rămase"></div>
  <button id="f1-pause" aria-labelledby="f1-pause f1-name">Pauză</button>   <!-- "Pauză drona_0412.mp4" -->
  <button id="f1-cancel" aria-labelledby="f1-cancel f1-name">Anulează</button>
</li>
```

`aria-labelledby` (button text first, then the name) keeps the visible label inside the accessible name
(2.5.3). Hashing phase = indeterminate (omit `aria-valuenow`, `aria-valuetext="Se calculează amprenta"`). Cancel
opens an AlertDialog ("Anulezi încărcarea drona_0412.mp4?").

**Announcement policy** (the tray itself is not `aria-live`; everything goes through the announcer):

| Event | Priority | Example |
|---|---|---|
| State change (hash started, upload started, paused, resumed, verifying, done) | polite | "drona_0412.mp4: încărcare pornită" |
| Progress milestones | polite, only at 25/50/75 % | "drona_0412.mp4: 50 %" |
| Progress on request | polite | button "Rezumat încărcări": "2 active, 1 în pauză. drona_0412.mp4 la 42 %, 3 minute rămase." |
| Connection lost (once) | polite | "Conexiune pierdută. Reîncercăm automat." |
| Retry attempt (per attempt, not per second) | polite | "Reîncercare 3 din 8" |
| Connection restored | polite | "Conexiune restabilită. Încărcarea continuă." |
| Failed, "Fișier corupt detectat", "Amprenta nu coincide" | assertive | "Încărcare eșuată: drona_0412.mp4. Amprenta nu coincide." |

The visual countdown "reîncercare în 12 s" is `aria-hidden="true"`; a static sr-only line says "Reîncercare automată în curs". Per-second ticks
are never announced. Progress `aria-valuenow` updates at most 1x/s (screen readers poll it; users can query).

**Tray behaviour.** Not modal, never traps focus. It is a collapsible region after `<main>` in DOM order,
reachable by Tab, by the "Sari la încărcări" link and by a header button "Încărcări (2 active)" which expands the tray
and focuses its heading. Persists across routes (it lives in the root layout). Esc collapses it.
Focus is never moved into it automatically.

## 4. Live data

- **Pause (2.2.2, Level A).** Auto-updating content that starts automatically and lasts > 5 s needs a pause/stop/hide
  control. Counters, fault list and health strip share one header-level switch "Actualizări live: pornite /
  în pauză" (Radix Switch, persists in session). When paused, the data is frozen and a "Reia" hint shows. This is
  not in the PRD (see conflicts).
- **Fault list (SC-04).** A real `<table>` with `<caption class="sr-only">Avarii, cele mai recente primele</caption>`. New rows are inserted at
  the top only if scrollTop is 0 and focus is not inside the table body; otherwise a button "Afișează 2 avarii
  noi" appears above the table. Focus never moves. Each new row is announced politely: "Avarie nouă: Linie 110 kV,
  zona Constanța, severitate ridicată". During a storm, coalesce within 5 s windows: "14 avarii noi în ultimele 5
  secunde". The "Nou" marker is a text badge plus a tint that fades out (no motion under reduced-motion).
- **Guarantee status.** `<article>` per guarantee with an `<h2>`. Changes go through the announcer: "Garanția
  Avarii: În pericol" polite; "Încălcat" assertive. Debounce flapping by 3 s.
- **Alert banner: decision.** The visible banner is a plain `<section aria-label="Alerte active">` with a list and
  a "Vezi garanția" link. It has no live role of its own (a banner that renders `role="alert"` on load or
  re-renders would double-announce). The announcer speaks it once: "În pericol" polite, "Încălcat" assertive.
- **Counters.** Primite / unice / duplicate respinse / pierdute update visually at most 1x/s, `font-variant-numeric:
  tabular-nums`, **not** in a live region. Button "Citește rezumatul": "Primite 1.204.332, unice 1.200.212,
  duplicate respinse 4.120, pierdute 0." Exception: "pierdute" going above 0 is announced assertively once.
- **Storage health strip.** `<ul>` of 3 items (icon + name + state text). Degraded: polite; down ("căzut"):
  assertive; recovery: polite. Message: "S3: căzut. Avarii folosesc rezerva FTP."
- **Session expiry (2.2.1).** At T-2 min (FE-01) show a Radix AlertDialog (role `alertdialog`): "Sesiunea expiră în 2
  minute. Încărcările în curs continuă după reautentificare." Buttons: "Rămân conectat" (initial focus; one action
  extends the session, far above the 20 s minimum) and "Deconectează-mă". Visual countdown is `aria-hidden`; announce at 2 min, 1 min, 30 s,
  10 s only. Do not use dialog for sessions without warning; expiry redirects to login with a "Sesiunea a expirat"
  summary and returns to the same page.

## 5. Charts

Applies to FE-09/FE-10: bulkhead latency lines, S1/S2 comparisons, S3 map, meter patterns.

- **Wrapper.** `<figure>` with `<figcaption>` title; inner SVG `role="img"`, `aria-labelledby` (title id) and
  `aria-describedby` (the Romanian interpretation paragraph from FE-10, which doubles as the text summary,
  visible, not sr-only). SVG contains `<title>` and `<desc>` as a fallback.
- **Data table alternative.** Directly after each chart, `<details><summary>Date în tabel</summary><table>...` with
  `<caption>`, `<th scope="col|row">` and units in headers. Open by default for S1/S2 so the jury sees it;
  closed for dense time series. The table is generated from the same data array as the chart (no divergence).
- **No colour-only encoding.** Every series has a distinct marker (circle, square, diamond, triangle), a dash pattern
  and a **direct end-of-line label**; the legend is secondary. Bars use SVG `<pattern>` hatching for the second
  and third series plus a 1 px white separator. Series colours come from tokens with >= 3:1 on white: `--text`
  14.57, `--link` 7.21, `--action` 5.50, `--status-ok` 5.46, `--text-muted` 6.82, teal `#0091BD` 3.63. Not
  cyan/yellow/coral/green brand fills for lines. Gridlines use `--border-decor` (decorative). Anomalies in meter
  patterns: triangle marker + text label ("Anomalie 03:10"), not only red.
- **Tooltips.** Supplementary only; everything in them is also in the table. If the library offers keyboard
  tooltips and it works, fine; do not depend on it. Tooltip content hoverable and dismissible (1.4.13).
- **Category × storage matrix (FE-09).** A real `<table>`: `<caption>`, column headers = storages, row headers =
  categories (`<th scope="row">`), each cell contains text "p50 12 ms · p95 40 ms · p99 90 ms · 0,2 % erori".
  Heat tint (light neutral tints with dark text, 12+ : 1) plus an explicit text/icon "Peste prag" when a cell is
  bad. Empty combination: "—" with sr-only "Nu se aplică". Wrapped in a focusable scroll region.
- **Trace waterfall (FE-05).** A `<table>` (step, start offset, duration, storage) is the primary content; the bar
  cell is `aria-hidden` decoration. Order = execution order. Trace ID in a `<code>` with a copy button.
- **S3 map (Muntenia / Banat / Dobrogea).** Hand-made SVG with three `<path>` regions, not a geo library. Each region
  has a visible text label with its value, a single-hue sequential fill (lightness steps, labelled legend with numbers),
  a 2 px `--text` outline, and the three regions are repeated in the data table. Keyboard focus is not needed
  on the map; the table is the keyboard path.
- **Chart library requirements:** SVG output (not canvas); animation can be disabled; custom markers, dash
  arrays and `<defs>` patterns; ability to set `role`, `aria-*`, `<title>`; colours passed as `var(--token)`.
  Recharts or visx both meet these.

## 6. PII reveal (FE-13)

- **Masked value.** Render `<span aria-hidden="true">I*** P***</span><span class="sr-only">Nume mascat</span>`
  (CNP: "CNP mascat, ultimele trei cifre 123"). The accessible name, `title`, `data-*`, `alt` and hidden DOM
  never contain the clear value; the client only holds it after a successful reveal call. Search results, page
  titles, toasts, tab titles and announcer messages use masked or display-safe values only.
- **Dialog.** "Arată datele" (`aria-haspopup="dialog"`) opens a Radix Dialog: title "Arată datele personale",
  description "Acțiunea este înregistrată în jurnalul de audit". A `<textarea>` "Motiv (minimum 15 caractere)",
  initial focus on it, Esc cancels, focus returns to the trigger. The submit button stays enabled; too-short
  reason gives an inline error linked by `aria-describedby`, not a disabled button. Character count is a static hint, not live.
- **Timeout (2.2.1).** Revealed values show a visible "Se ascund în 60 s" line. At 15 s remaining: polite
  announce "Datele vor fi ascunse în 15 secunde" and a button "Prelungește 60 s" (each extension is audited).
  On hide: polite "Datele personale au fost ascunse"; if focus was inside the revealed field, move it to
  "Arată datele". Navigation hides immediately.

## 7. Role switcher and control room

- **Role switcher** (demo mode, admin): Radix DropdownMenu with `RadioGroup`; trigger text "Rol activ: Auditor" (visible text is part of
  the name). Selecting announces "Rol activ: Auditor. Navigarea a fost actualizată." Focus stays on the trigger.
  If the current page is not allowed for the new role, navigate to the home page and focus its `<h1>`.
  PRD says "one click"; a menu is two. Acceptable trade-off, see conflicts.
- **Control room (SC-10).** Destructive/demo actions ("Furtună 10× · avarii", "Corupe fișier", stop/restore) use
  AlertDialog with focus on "Anulează" and a specific action label ("Pornește furtuna"). The effect panel uses the same
  announcer rules as section 4 (bulkhead card statuses polite; failures assertive). A running storm timer is
  `<time>` with `aria-hidden` digits; announce start, 10 s left, and end. The "Anunță timpul rămas" button speaks it on demand.
- **Policy confirm (FE-06).** Diff is a table: field, before, after, with "−/+" text markers and `<del>/<ins>`,
  not colour only.

## 8. Testing

1. **Lint:** `eslint-plugin-jsx-a11y` with `strict` config in flat config, errors in CI. Extra grep rules: no
   cedilla `ş ţ`; no hex/rgb colours outside the token file (matches `frontend/CLAUDE.md`).
2. **Token test (Vitest):** compute contrast for every declared pair (text/bg, on-*/fill, border/bg, status
   chips, chart series) and fail below 4.5 / 3. This replaces trusting section 1.
3. **axe in Playwright** (`@axe-core/playwright`, tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa`, includes the
   `target-size` rule) on every SC-01..SC-11 for each role against the mock API, **and** in states: tray expanded,
   reveal dialog open, session-expiry dialog, alert banner with "În pericol" and "Încălcat", corrupt-file state,
   matrix with a bad cell. Zero violations.
4. **Lighthouse CI** on the same routes, accessibility >= 95 (it runs only a subset of axe, so not a substitute).
5. **Playwright keyboard script:** Tab through each screen, assert visible focus, no trap, Esc closes dialogs and
   returns focus, skip link works.
6. **Manual, keyboard-only + NVDA (Windows, Chrome/Firefox)** over the 8 demo beats:

| Beat | Check |
|---|---|
| 1 Opening | login by keyboard, error summary, title announced, cards read as "Avarii, În pericol" style |
| 2 Drone upload | file picker by keyboard, progress valuetext, offline/online messages not spammed, pause/cancel names, reload restores the tray |
| 3 Fault | "Avarie nouă" announced, focus unchanged |
| 4 Racordări | masked values read as "mascat", reveal dialog, timeout warning, audit row |
| 5 Storm | banner announced once, health strip change announced, no flood of announcements |
| 6 Integrity | hashes readable, "Fișier corupt detectat" assertive, waterfall as table |
| 7 Policy | diff readable without colour, confirmation dialog |
| 8 Statistici | each chart: summary then table, map regions in table |

7. **Short release checklist:** 200 % and 400 % zoom, Windows high contrast (forced colors), reduced-motion on,
   colour-vision simulator (Chrome DevTools) on the status chips, page without mouse for the full script, all
   copy `lang="ro"` and comma-below diacritics.

## Contrast failures

*Decision 2026-11-14: the primary action uses `#D04000` (white text 4.76:1) instead of `#C13700`; see ADR-0018 and
[tokens.css](../design/tokens.css).*

| Token / pair | Ratio | Required | Verdict | Fix |
|---|---|---|---|---|
| white text on orange `#FF4B00` (buttons) | 3.36 | 4.5 | FAIL (large text only) | `--action` `#C13700`, 5.50 |
| dark `#232936` text on orange | 4.34 | 4.5 | FAIL | `--action` with white text |
| orange text on white / FA / F5 | 3.36 / 3.23 / 3.08 | 4.5 | FAIL as text, pass 3:1 as UI/graphic | `--action` for text |
| orange boundary on `#FAEBE6` | 2.89 | 3 | FAIL | `--action` (4.74) |
| white on cyan `#00A0DC` | 2.97 | 4.5 (3 large) | FAIL | dark text on cyan 4.90, or `--info-text` `#00729E` 5.38 |
| cyan as focus ring / boundary on white | 2.97 | 3 | FAIL | `--focus` two-tone ring |
| white or text on coral `#FF6447` | 2.93 | 4.5 / 3 | FAIL | fill with dark text only (4.97) |
| green `#00DC55` on white | 1.85 | 3 | FAIL | `--status-ok` `#00776A` 5.46 |
| yellow `#FFDA00` on white | 1.37 | 3 | FAIL as text/icon | filled chip with dark text 10.60 + dark border |
| light blue `#53A7FF` on white | 2.52 | 3 | FAIL | decoration; dark text on it 5.78 |
| teal `#0091BD` as text, or dark text on teal | 3.63 / 4.01 | 4.5 | FAIL as text, pass 3:1 graphic | `--info-text` for text, teal for chart marks |
| dark 50 % on white / F5 | 3.04 / about 3.0 | 4.5 | FAIL text | disabled/decorative only |
| border `#D3D5D6` on white (inputs) | 1.47 | 3 (1.4.11) | FAIL | `--border-input` `#5A5F68` 6.42 |
| PPC blue, dark, dark 75 %, grey `#555C5F`, `#313131`, `#0D0D0D` | >= 6.1 | 4.5 | pass | keep |

## Decisions

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| A11Y-1 | Radix UI primitives plus native HTML elements; own announcer instead of a toast library | React Aria (stronger but larger API, slower in 22 h); hand-rolled widgets | Fast, headless, correct focus/ARIA for Dialog/AlertDialog/Menu/Tabs; native `<select>`/`<table>`/`<details>` avoid risk |
| A11Y-2 | Split tokens: brand colours decorative; functional tokens `--action #C13700`, `--text`, `--text-muted`, `--link`, `--info-text`, `--border-input` | Use brand colours as-is with large text | Orange/white is 3.36, cyan 2.97; need AA for normal-size button text |
| A11Y-3 | Primary button = `#C13700` fill, white text, 40 px pill, never lighter on hover | Orange `#FF4B00` with 18.66 px bold text; dark text on orange (4.34) | Passes 5.50 while keeping the orange feel |
| A11Y-4 | Control boundaries use `--border-input #5A5F68`; `#D3D5D6` decorative only | `#D3D5D6` borders | 1.47 fails 1.4.11 |
| A11Y-5 | Two-tone focus ring (3 px `--focus` outline + 2 px white halo), `outline`-based; scroll-padding for sticky chrome; tray collapses with Esc | Brand cyan/orange ring | Works on any surface; cyan fails 3:1; satisfies 2.4.11 |
| A11Y-6 | Status = filled chip with icon + text, colours ok `#00776A`, warn `#FFDA00`+dark border, bad `#B3123F`, neutral `#555C5F`; distinct icon shapes | Colour-only cards; brand green/red | CVD-safe, all >= 3:1 (1.4.1, 1.4.11) |
| A11Y-7 | Vitest contrast test of every token pair in CI; no raw colours outside the token file | Manual audit | Section 1 was hand-computed; code makes it durable |
| A11Y-8 | Min target 32 px on laptop (44 px phone); icon buttons have Romanian `aria-label` | 24 px minimum | Margin above 2.5.8; easier for the presenter too |
| A11Y-9 | Landmarks, skip links, one h1, Romanian per-route titles without PII, focus to h1 on navigation | Next default route announcer only | 2.4.1, 2.4.2, 2.4.6; keyboard users restart from the top |
| A11Y-10 | Forms: visible labels, `aria-describedby` errors, error summary with focus, validate on submit, CNP as numeric text field | Per-keystroke validation; `type=number` | 3.3.1/3.3.3; CNP has leading zeros and checksum |
| A11Y-11 | One announcer component (polite + assertive regions in the root layout), dedupe, 2 s rate limit | `aria-live` on each widget | Controlled, testable noise level |
| A11Y-12 | Upload tray: non-modal collapsible region, per-file `role=progressbar` with Romanian `aria-valuetext`, button names via `aria-labelledby`, milestones every 25 %, countdown `aria-hidden` | Native `<progress>`; announce every %/second | 4.1.2, 4.1.3, 2.5.3; no spam on retry |
| A11Y-13 | Drop zone always contains a real "Alege fișiere" button; no drag-only action | Drop zone as `role=button` | 2.5.7 |
| A11Y-14 | Global "Actualizări live" pause switch for counters, fault list, health strip | None | 2.2.2 (Level A) |
| A11Y-15 | Fault list: table, insert at top unless focus/scroll inside, coalesce announcements per 5 s, no focus steal | Always prepend | Stable reading position; storm-safe |
| A11Y-16 | Alert banner has no live role; the announcer speaks it (polite for "În pericol", assertive for "Încălcat"/corupt/eșuat) | `role=alert` on the banner | Avoids double announcement and load-time alerts |
| A11Y-17 | Counters never live; "Citește rezumatul" on demand; "pierdute > 0" assertive once | `aria-live` on counters | Ticking values would flood the screen reader |
| A11Y-18 | Session-expiry AlertDialog at T-2 min with one-action extend; announcements at 2 min/1 min/30 s/10 s | Toast; silent redirect | 2.2.1 |
| A11Y-19 | Chart = `<figure>` + SVG `role=img` + visible Romanian summary + `<details>` data table; markers/dashes/patterns/direct labels; tooltips supplementary | Keyboard-navigable SVG chart | Table is the robust keyboard/SR path; 1.1.1, 1.4.1 |
| A11Y-20 | Matrix and trace waterfall as real tables; S3 map as hand-made SVG with labels and table | Geo/map library | Semantics and speed |
| A11Y-21 | PII masked via `aria-hidden` mask + sr-only "mascat"; no clear value in DOM/attributes pre-reveal; reveal Dialog with reason; 60 s timeout with 15 s warning and audited "Prelungește" | Timeout without warning; disabled submit | 2.2.1, 3.3.1, security |
| A11Y-22 | Role switcher = Radix DropdownMenu radio group; control-room actions in AlertDialog with focus on cancel; timers `aria-hidden` plus on-demand announce | Segmented radio group (one click) | Robust, scales; flagged trade-off |
| A11Y-23 | Minimal responsive shell for 320 px reflow even though phone is P2; tables/charts in focusable scroll regions | Desktop-only | 1.4.10 is AA |
| A11Y-24 | "Ajutor" link in fixed header position; metadata prefilled per batch; filters in URL; login only username/password with paste and managers allowed | CAPTCHA; per-file re-entry | 3.2.6, 3.3.7, 3.3.8 |
| A11Y-25 | Reduced motion respected everywhere; light theme only (`color-scheme: light`); forced-colors safe outlines | Dark mode | Dark mode needs a second full contrast audit |
| A11Y-26 | Test stack: jsx-a11y strict, axe-Playwright per screen/role/state, Lighthouse CI >= 95, keyboard script, manual NVDA over 8 beats | Lighthouse alone | Lighthouse covers a subset of axe |

## Asks to other parts of the system

**Backend (NestJS):**
- Return a display-safe name for every file (`displayName`, no PII) and masked strings already formatted
  ("I*** P***", "1********123"); never send clear PII before a reveal call.
- Reveal endpoint returns `expiresAt`; an "extend" call is a new audited event (A11Y-21).
- Session: expose `expiresAt` (warning at T-2 min), refresh endpoint for "Rămân conectat".
- Event feed sends machine-readable event types and fields (zone, severity, substation), not pre-written
  sentences; the frontend builds the Romanian announcement. Batching or a rate cap during a 10x storm is welcome,
  but the frontend coalesces anyway.
- Server timestamps and monotonic counters so "pierdute" and "duplicate" are stable.

**Chart-library agent:** SVG only, animation switchable, custom markers/dash/`<defs>` patterns, ability to set
`role`/`aria-*`/`<title>`, colours via `var(--token)`, data array reusable for the table. Needs a hand-made SVG
for the S3 map.

**Design:** accept `#C13700` as the primary action orange; choose a free font with correct ș ț glyphs and
Romanian metrics; icon set with distinct shapes for the four statuses.

**Mock API (FE-18):** deterministic seed states for each status (În pericol, Încălcat, corupt, storage down,
session near expiry) so axe and NVDA runs are reproducible.

## Conflicts with the PRD

- Beat 1 "meter counter ticking" and the live fault list need the pause control (2.2.2): small addition not in
  the PRD.
- Beat 2 "drags a video": works, but the button alternative is mandatory (2.5.7).
- FE-13 "short timeout": needs a visible warning and an extension action (2.2.1).
- FE-01 "one click" role switch becomes two with a menu (A11Y-22).
- "Phone is P2" vs AA 320 px reflow: a minimal responsive shell is required now (A11Y-23).
- Brand orange `#FF4B00` cannot carry white normal-size text; the primary action orange is darker (design change).
- "4 green cards" / "tile turns red": must use status tokens with icon and text, not brand green/red.
