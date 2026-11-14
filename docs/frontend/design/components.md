# FileGrid PPC: component inventory

*DRAFT (Prompt 3). Base: shadcn/ui (Radix primitives, Tailwind v4) themed with [tokens.css](tokens.css).
"Base" names the shadcn component(s) or Radix primitive; "FG" marks components we build on top. All text Romanian,
all colours via tokens, all interactive targets ≥ 32 px, focus = two-tone ring.*

| Component | Base | PPC theme | States / variants | A11y notes |
|---|---|---|---|---|
| **App shell** | `SidebarProvider` (shadcn Sidebar) + CSS grid | dark-blue sidebar, white top bar, `--fg-page` canvas, footer "Prototip FileGrid · Hackathon PPC" | comfortable / dispecerat density; light / dark | skip link, `<nav>`, `<main>`, `<footer>` landmarks; focus to h1 on route change |
| **Sidebar** | shadcn `Sidebar`, `Collapsible`, `Tooltip` | white text on `#232936`; active item: 4 px brand-orange bar + `--fg-chrome-2`; line icons | expanded 248 / icons 72 / drawer < 640 px; demo group only in demo mode | `aria-current="page"`; collapsed items keep tooltips + `aria-label` |
| **Top bar** | flex + shadcn `Badge`, `DropdownMenu` | page title, storage health strip, environment badge, role pill, user menu | — | title is the page `<h1>` |
| **Environment badge** | `Badge` (FG variant) | "DEMO · VPS" (cyan outline), "Date simulate" (yellow chip + icon when mocks on), "Producție" (neutral) | 3 | text, not colour, carries meaning |
| **Role picker (login)** | `Select` (Radix) with 5 options + description line | full-width 44 px field, selected option on light-orange tint | — | labelled "Rol"; password stays a separate field (ADR-0022) |
| **Role switcher** | `DropdownMenu` + `DropdownMenuRadioGroup` (A11Y-22) | pill trigger "Rol activ: Auditor ▾", "Rol demo" tag; same 5 roles as the login | real role / acting role (demo mode only) | radio group semantics; switch announced politely |
| **Storage health strip** | FG, `Tooltip` | three chips: Postgres · S3 · FTP with dot + word + latency | ok / degradat / căzut | word + icon, not dot alone; links to Observabilitate |
| **Alert banner** | shadcn `Alert` (FG variant) | full-width under top bar; yellow (În pericol) or crimson (Încălcat) tint + icon + cause + "Vezi detalii" | warn / crit; dismiss = acknowledge | no live role itself (A11Y-16); announcer speaks it |
| **Data table** | shadcn `Table` + TanStack Table | `--fg-surface`, `--fg-surface-2` header, hairline rows, sticky header, tabular numbers | comfortable 48 px / dense 40 px rows; new-row wash | real `<table>`, sortable headers are buttons with `aria-sort` |
| **Filters bar** | `ToggleGroup` (category pills), `Select`, `Popover` + `Calendar` (interval), `Input` (search), `Switch` ("Ascunde datele generate") | one row above content, pill chips, "Resetează" text button | applied count | labels visible; state in URL |
| **Upload dropzone** | FG on native `<input type=file>` + `Button` | `--fg-surface-sunken`, dashed `--fg-line-input` 2 px, radius 12, line cloud-up icon, real "Alege fișiere" button | idle / drag-over (cyan outline) / rejected (crimson message) | button alternative to drag (A11Y-13); accepted types from policy in text |
| **Category picker** | `RadioGroup` styled as 3 tiles | line icon, title, size hint, policy summary ("S3 · 8 MiB · criptat: nu") | selected = orange 2 px ring + tint | radio semantics |
| **Chunk-grid progress** | FG (SVG/CSS grid) + `Progress` (Radix) for semantics | cells: done cyan-deep, in flight brand cyan (breathe), pending grey, failed crimson outline; ≤ 256 cells, each cell = n chunks for big files | hashing / uploading / paused / connection lost / verifying / verified / failed | `role=progressbar` with Romanian `aria-valuetext`; grid itself `aria-hidden` |
| **Upload tray** | shadcn `Card` + `Collapsible` | bottom-right 380 px, collapsible, per-file row with mini chunk bar, state chip, pause/resume/cancel icon buttons | collapsed shows "2 în curs · 1 verificat" | non-modal region, Esc collapses, no focus trap |
| **Integrity badge** | `Badge` (FG variants) | Verificat (green, shield-check) · Verificat de server (green outline) · Neverificat (neutral) · Fișier corupt detectat (crimson, octagon-x) | 4 | icon + word |
| **Hash pair** | FG | two mono lines "Client" / "Server" with the first and last 8 chars emphasised, equality icon between | match / mismatch | full hash in `title` and copy buttons |
| **Status card (guarantee)** | shadcn `Card` (FG) | radius 24, title + Romanian sentence + metric + threshold + status chip; at-risk: 4 px left rule in status colour + tint background | OK / În pericol / Încălcat | heading per card; chip text is the status |
| **KPI tile** | `Card` (FG) | label 13 px caps, number 36–48 px tabular, unit, delta vs threshold | normal / dimmed (stale) | number + unit in one accessible name |
| **Trace waterfall** | FG (CSS grid table) | span rows: name, storage chip, bar on a ms axis (cyan, error crimson), duration; trace ID mono + copy; "Deschide în Grafana" | ok / error / partial | it is a `<table>` (A11Y-20) |
| **Timeline (chain of custody)** | FG list + `Badge` | vertical line, dot per event, time, actor, "Rol demo" tag, reason for reveal | — | ordered list `<ol>` |
| **Policy form** | `Form` (react-hook-form) + `Select`, `Switch`, `Input`, `Slider`? (no: number input) | two columns: storage (primary/fallback), encryption switch (locked for racordări), chunk size, parallelism, max size, types | view / edit / diff (old → new table) / conflict (409) | errors linked via `aria-describedby`, error summary |
| **Dialog / confirm** | `Dialog`, `AlertDialog` | radius 20, e3 shadow, focus on cancel for demo actions | — | Radix focus management |
| **PII field** | FG | masked value + "mascat" sr-only; "Arată datele" opens reason `Dialog`; countdown chip "se ascunde în 45 s" + "Prelungește" | masked / revealed / expiring | never puts clear value in attributes (A11Y-21) |
| **Live status pill** | `Badge` | "Live" green dot / "Reconectare în 4 s" yellow / "Pauză" neutral | 3 | toggles "Actualizări live" |
| **Empty / error / loading** | FG + `Skeleton` | see direction.md §10 | — | error shows "ID urmărire" with copy |
| **Toast / announcer** | own `Announcer` (no toast lib, A11Y-1) | — | polite / assertive | rate-limited |
| **Buttons** | `Button` | primary = orange pill; secondary = dark-blue outline pill; quiet = text; danger (demo only) = crimson outline pill | sm 32 / md 40 / lg 48 px | never orange for anything but "act" |
