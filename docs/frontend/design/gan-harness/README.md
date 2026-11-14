# Design review loop (ecc:gan-design), 2026-11-14

**Spec:** the five demo-critical screens in [../mockups/](../mockups/index.html), built on [../tokens.css](../tokens.css)
following [../direction.md](../direction.md).

**Rubric (user-defined, replaces the default design rubric):**

| Criterion | Weight | What a 10 looks like |
|---|---|---|
| PPC familiarity | 0.25 | Reads as a Rețele Electrice back-office tool (white planes, dark-blue chrome, orange pill actions, line icons, 12–24 px radii) without copying logos or claiming officiality |
| Clarity for a non-technical manager | 0.30 | Each block leads with a plain Romanian sentence, then the number, then the proof |
| Demo legibility on a projector | 0.25 | Nothing important below 14 px, KPIs ≥ 24 px, no wrapping or clipping at 1440 px, strong contrast |
| Accessibility | 0.20 | AA contrast, never colour alone, real tables, labels, focus, reduced motion |

Pass threshold 7.5 (weighted), at most 3 iterations.

**How it ran:** the Playwright evaluator agent could not start (no Chrome on this machine), so the evaluation was
done in the main session on real renders from headless Microsoft Edge at 1440 px; the generator step edited the
mockups between rounds. Screenshots of the final round are in this folder.

| Screen | Round 1 | Round 2 | Round 3 | Main fixes |
|---|---|---|---|---|
| 01 Încărcare | 7.75 | 7.9 | 7.9 | input text no longer wraps; meta text 14 px, darker |
| 02 Fișiere | 7.4 | 8.1 | 8.1 | severity moved from status colours to neutral level bars ("calm by default"); filters on one row; "Nou · acum 4 s" chip readable |
| 03 Detaliu fișier | 7.75 | 7.9 | 7.9 | waterfall durations no longer wrap |
| 04 Garanții + Cameră de control | 6.6 | 7.5 | 7.6 | "În pericol" card rebuilt (tint + yellow edge instead of a solid yellow block); counters as label/number rows; chart labels 14–15 px, no clipping; card titles no longer wrap |
| 05 Statistici | 7.6 | 7.6 | 8.0 | anomalies table no longer overflows (stacked under the map); "hartă schematică" label; S2 axis noted |
| **Average** | **7.4** | **7.8** | **7.9 ✓** | |

**Known gaps (not fixed, for your call):**
- Dark "dispecerat" theme on screen 4 lowers PPC familiarity; open `04-garantii-demo.html?light` for the light version.
- Photography is a labelled placeholder (licensed photos still to choose).
- The S2 dumbbell has no drawn axis yet; the region map is schematic, not geographic.
- Not yet checked: keyboard path and NVDA on the mockups (static HTML), 390 px reflow beyond the CSS breakpoints.
