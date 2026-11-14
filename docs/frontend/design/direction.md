# FileGrid PPC: design direction

*DRAFT for review (Prompt 3, 2026-11-14). Inputs: [context.md](../context.md) §5, [prd.md](../prd.md),
[accessibility.md](../architecture/accessibility.md), Appendix A of [PROMPTS.md](../PROMPTS.md). Tokens:
[tokens.css](tokens.css). Components: [components.md](components.md). Mockups: [mockups/](mockups/index.html).
Nothing here is coded yet; pick and adjust first.*

## 1. Contract

| Item | Decision |
|---|---|
| Surface | Internal web tool of Rețele Electrice România (PPC group), staff-only, Romanian UI |
| Jobs | Upload field files that survive bad networks; find and prove files; watch four business guarantees; prove them live to the PPC jury |
| Primary actions | "Încarcă", "Descarcă și verifică", "Salvează politica", "Pornește furtuna" (demo) |
| First thing scanned | Are the 4 guarantees OK? Then: is my upload moving? |
| Target viewports | 1440×900 laptop (demo), 1920×1080 projector (same layout, larger type tokens unnecessary), 390×844 reflow only (A11Y-23) |
| Reference observations | reteleelectrice.ro: white/off-white planes, dark-blue `#232936` header/footer, orange pills for the main CTA, cyan for data, 24/20/12 px card radii, line icons, documentary photos of technicians and substations, institutional reassuring tone ("Suntem aproape de consumatori") |
| Not | Not a PPC product: no PPC or Rețele Electrice logo, no claim of officiality; footer always "Prototip FileGrid · Hackathon PPC" |

## 2. Mood

**Calm utility, institutional, reassuring.** It should feel like the back office of the reteleelectrice.ro site:
same light planes, same dark-blue chrome, same orange pill for "do this", same line icons, but denser and more
precise, because operators use it all shift. Three words: *liniștit, precis, de încredere*.

The memorable detail is the **chunk grid**: FileGrid's wordmark is a 3×3 grid of chunks that fills, and the same
grid becomes the upload progress (every chunk of the file is a cell that turns cyan when confirmed). The brand idea
and the core proof of the product (resumable, verified transfer) are the same picture.

## 3. Principles

1. **Calm by default, loud only when a guarantee is at risk.** At rest the screen is white, grey and dark blue; the
   only saturated colour is the orange action button and small cyan data marks. Yellow, crimson and motion appear
   only when a business guarantee is "În pericol" or "Încălcat", a storage is down, or a file is corrupt. If
   everything is loud, nothing is.
2. **Orange means "act", never "alarm".** The brand orange is reserved for primary actions (pill buttons) and
   brand marks. Status never uses orange: OK = green, În pericol = yellow with a dark border, Încălcat / corupt =
   crimson (hue ≈ 345°, visibly pink-red next to the 18° orange). Status is a **6 px-radius chip with an icon and a
   word**; actions are **pills**. Shape separates them before colour does.
3. **Proof over decoration.** Every number has its unit, its threshold and where it came from (hash, trace ID,
   storage label, policy version). A beat that cannot be proved on screen is not designed as a screen.
4. **Explain for a manager, detail for an engineer.** Each card leads with a Romanian sentence a non-technical
   manager understands ("Avariile ajung la dispecerat în 1,2 s"), then the numbers, then a link to the trace.
5. **Projector-first legibility.** Body never below 14 px, meta never below 13 px, KPI numbers 36–48 px with
   tabular figures, lines ≥ 2 px, nothing communicated by colour alone, contrast ≥ 4.5:1 for all text.
6. **No layout jumps.** Live data updates in place (fixed-width tabular numbers, reserved space for banners and
   counters, new rows inserted without shifting focus).

## 4. Colour

All values and measured ratios are in [tokens.css](tokens.css). Highlights:

| Role | Light | Dark (dispecerat) | Note |
|---|---|---|---|
| Page / card | `#F5F5F5` / `#FFFFFF` | `#0F131A` / `#171C26` | reteleelectrice dirty-white and white |
| Chrome (sidebar) | `#232936` | `#0B0E14` | their dark blue |
| Ink / secondary / muted | `#232936` 14.56 · `#555C5F` 6.81 · `#6B7280` 4.83 | `#EEF1F5` 15.06 · `#AEB6C4` 8.36 · `#8A93A3` 5.51 | |
| **Primary action** | `#D04000` + white **4.76** | `#FF5A1F` + dark ink **6.15** | brand `#FF4B00` fails with white (3.36), so the pill is one step deeper; in dark mode the true bright orange returns with dark text |
| Brand orange `#FF4B00` | wordmark chunks, active-nav bar, large display | same | decorative / ≥ 3:1 marks only |
| Brand cyan `#00A0DC` | in-flight chunks, illustration, data highlight | same | never text on white (2.97) |
| PPC blue `#163FE8` | links, selection, group accent | `#6E8BFF` | 7.22 |
| OK | `#0B7A3E` | `#3DD68C` | chip + check icon |
| În pericol | `#FFDA00` fill + `#7A5C00` border + dark text 10.60 | `#F2C200` | chip + triangle icon |
| Încălcat / corupt | `#B3123F` + white 6.83 | `#FF6B8B` + dark 7.05 | chip + octagon/x icon; crimson, not orange |
| Info | `#00729E` 5.38 | `#4FC3F7` | chip + "i" icon |

**Decided 2026-11-14:** the action is `#D04000` (4.76:1, AA, closest passing step to the brand); ADR-0018 accepted.

## 5. Typography

**Figtree** (Google Fonts, OFL), self-hosted via `next/font` (CSP `font-src 'self'`), weights 400/600/700.

Tested in [font-test.html](font-test.html) (headless Edge, 2026-11-14) against Manrope, Onest, Albert Sans and Plus
Jakarta Sans:

| Candidate | ș ț Ș Ț comma-below | Tabular figures (`tnum`) | Width (6 digits @40px) | Feel vs PingLCG |
|---|---|---|---|---|
| **Figtree** | ✓ real glyphs; cedilla ş ţ drawn differently (bad copy is visible) | ✓ | 151 px (narrowest with tnum) | geometric with humanist warmth, open apertures: closest |
| Manrope | ✓ (cedilla drawn as comma) | ✓ | 149 px | more technical, squarer, wider letterforms |
| Onest | ✓ | ✓ | 162 px | wide, rounder, less dense |
| Albert Sans | ✓ | ✗ no `tnum` → ticking counters jitter | — | rejected |
| Plus Jakarta Sans | ✓ (cedilla as comma) | ✓ | 144 px | high-contrast, more promotional (ppcenergy-like) |

Why Figtree: PingLCG is a geometric sans with humanist details; Figtree is the closest free match, keeps tables
compact (control-room density), has true tabular figures for live counters, and renders Romanian correctly. Fallback
stack `ui-sans-serif, system-ui, "Segoe UI"`. Hashes and trace IDs use the system monospace.

Scale (rem at 16 px): 13 meta · 14 dense table · **16 body** · 18 card title · 22 section · 28 page title · 36 KPI ·
48 hero KPI. Weights: 400 body, 600 labels/titles, 700 KPIs and page titles. Numbers always
`font-variant-numeric: tabular-nums`. Romanian number format: `1 024,5 MB`, `98,7 %`, `1,2 s`.

## 6. Data visualization

Procedure from the dataviz skill; validator `scripts/validate_palette.js` run 2026-11-14.

- **Category palette (identity, fixed order):** meter `#0072A3` cyan · fault `#C0307E` magenta · connection
  `#5B3FD0` violet · drone `#8A6A00` ochre. Light vs `#FFFFFF`, `--pairs all`: **ALL CHECKS PASS** (worst CVD ΔE
  8.5, worst normal-vision ΔE 16.0, all ≥ 3:1). Dark steps `#1A93C0, #DB4C8C, #9A5DE0, #AE8A12` vs `#1B2130`,
  `--pairs all`: **PASS with CVD WARN 6.9** (6–8 band) → secondary encoding is mandatory: every line has a dash
  pattern and a direct end label, every chart a table view.
- These hues avoid all reserved colours: no orange (action), green/yellow/crimson (status).
- **Storages are never colour-encoded.** S3 / FTP / DB appear as axis labels, row headers and text chips. (A
  three-hue storage set with a neutral failed the chroma and normal-vision floors; a fourth hue family would collide
  with status.) Charts comparing storages use small multiples with one colour.
- **Sequential** (fault density map): one cyan ramp `--fg-seq-1..5`, light → deep (dark theme reversed).
- **Status** colours appear in charts only as threshold lines/bands with a text label ("țintă 2 s").
- Marks: 2 px lines, ≥ 8 px markers, 4 px rounded bar ends, 2 px surface gaps, recessive grid (`--fg-grid`), one
  y-axis only, legend + direct labels for ≤ 4 series, text in ink tokens (never series colour).

## 7. Layout grid and density

- **Shell:** fixed dark-blue sidebar 248 px (collapsible to 72 px icons) + white top bar 64 px + content.
- **Content:** 12-column fluid grid, 24 px gutters, 24–32 px page padding, max 1440 px. Cards span 3/4/6/12 columns.
- **Rhythm:** 4 px base; sections 32 px apart; cards 24 px padding (20 px dense).
- **Two densities:**
  - *Comfortable* (default, office roles): 16 px body, 48 px table rows, 24 px card padding.
  - *Dispecerat* (control-room screens: Garanții, Contoare live, Observabilitate, Cameră de control; and the dark
    theme): 14 px table text, 40 px rows, 20 px padding, KPI numbers stay 36–48 px. Density never shrinks targets
    below 32 px.
- **Reserved zones** (no layout shift): alert banner slot under the top bar (collapses to 0 when calm, animates
  height only via `grid-template-rows` 0fr→1fr), upload tray bottom-right 380 px, storage health strip in the top bar.
- **Reflow:** below 1024 px the sidebar collapses to icons; below 640 px it becomes a top drawer and grids go one
  column (A11Y-23). Tables scroll inside a focusable region.

## 8. Imagery and iconography

- **Line icons** 1.75 px stroke, 20/24 px (Lucide, matches reteleelectrice line style); never filled except status
  glyphs.
- **Documentary photography** only where it helps the story and never behind data: login screen (wide 920×400-style
  photo card of a technician in PPE at a substation), empty states (lineworkers, drone over a line), and the
  Statistici header strip. Licensed stock (Unsplash/Pexels licence) or the team's own photos; never PPC imagery.
  Duotone treatment toward `#232936` keeps them calm. Mockups show labelled placeholders.
- **Wordmark:** "FileGrid" in Figtree 700 next to a 3×3 chunk grid; 7 cells cyan/white, 2 cells orange (the last
  chunks landing). Monochrome white on chrome. No PPC/Rețele Electrice marks anywhere.

## 9. Motion

Tokens in [tokens.css](tokens.css) (from ecc:motion-foundations): `instant 80ms`, `fast 180ms`, `normal 350ms`,
`slow 600ms`; easings `smooth (0.22,1,0.36,1)`, `sharp (0.4,0,0.2,1)`. CSS transitions only; we do **not** add
`motion/react` (dependency budget, ADR-0009/0020).

Motion must guide attention, communicate state or preserve continuity, otherwise it is removed:

| Where | Motion | Why |
|---|---|---|
| Chunk grid | cell fills with a 180 ms opacity step; no per-cell bounce | state: confirmed bytes |
| In-flight chunk | slow 1.6 s opacity breathe on cyan cells | state: work in progress |
| New fault row | 180 ms background wash from `--fg-info-tint` to surface | attention without shifting focus |
| Guarantee card → În pericol | one 600 ms ring pulse, then static | attention, once |
| Alert banner | 350 ms height reveal (`grid-template-rows`) + fade | continuity |
| Dialogs, popovers | 180 ms fade + 8 px rise | continuity |
| Live counters | numbers change in place, no rolling digits | legibility on a projector |

Never animate width/height/top/left (only opacity, transform, or `grid-template-rows` for the banner). **Reduced
motion:** transforms off, fades ≤ 120 ms, the breathe and pulse disabled (state still shown by colour + text).
Respect "Actualizări live" pause (A11Y-14): paused means no motion and no updates.

## 10. Content states (per screen pattern)

| State | Trigger | Feedback | Next action |
|---|---|---|---|
| Loading | first fetch | skeleton rows/cards in `--fg-surface-sunken`, stable sizes | none |
| Empty | no files for filters | line illustration + "Niciun fișier pentru aceste filtre" | "Resetează filtrele" / "Încarcă un fișier" |
| Error | API error | crimson-tint panel, Romanian message, code, "ID urmărire" + copy | "Reîncearcă" |
| Partial | one storage down / stream reconnecting | data shown, affected rows marked "S3 indisponibil", live pill "Reconectare în 4 s" | none (auto) |
| Success | upload verified | green chip "Verificat", both hashes, "Disponibil pentru dispecerat în 1,2 s" | "Deschide fișierul" |
| Permission | role lacks capability | neutral panel "Nu aveți acces la această pagină" + active role | "Înapoi la Garanții" |

## 11. Open choices for you

1. ~~Action orange~~ decided: `#D04000`.
2. Dark "dispecerat" theme: on by default for the control-room screens during the demo, or a toggle?
3. Photography: use licensed stock now, or plain illustrations until the team has its own photos?
4. Sidebar: dark-blue (as proposed, matches their header) or white with a dark-blue top bar?
