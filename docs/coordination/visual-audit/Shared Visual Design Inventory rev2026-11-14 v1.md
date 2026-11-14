# Shared Visual Design Inventory

**Audit:** VIS-6 — Colorado Watchdog Beta-2
**Revision:** 2026-11-14 v1
**Scope:** Shared design and inventory routing. Individual page-family audits remain with VIS-7 through VIS-19.

## Targets and versions

- **Beta-1 live site:** [colorado-watchdog.futureguild2.chatgpt.site](https://colorado-watchdog.futureguild2.chatgpt.site/), Sites version 35, deployment `appgdep_6af5ba3326408191a30253e7df4aa513`, published 2026-11-12. The Sites record identifies the app as `colorado_watchdog_beta1`; saved source commit `c85f64e9fc420d8b309a844ac5596e4aadb9db13` is the deployment provenance, not the Beta-2 GitHub revision.
- **Hosted Alpha-1:** [colorado-watchdog-alpha1.futureguild2.chatgpt.site](https://colorado-watchdog-alpha1.futureguild2.chatgpt.site/), Sites version 3, deployment `appgdep_6af8255c92948191afa497cb78444cfb`, published 2026-11-14. The saved source commit is `055dd50361f816164cce9f49c353d209d11af734`.
- **Current Beta-2 source:** GitHub `main` at `f99181045f939414f88ce93a811e67a66c85c624` (2026-11-14), following PR #85.

The deployed Alpha-1 source is behind current `main`. In particular, PR #84 changed the masthead wordmark width and homepage headline measure; PR #85 merged homepage Community Voices pathways. The Alpha-1 browser capture still shows the wordmark breaking vertically and the homepage title spanning three lines. These are **deployment lag** observations, not new source defects. Keep the merged source corrections and verify again after a deployment.

## Shared design patterns

| Area | Beta-1 browser observation | Beta-2 current source and Alpha-1 | VIS-6 assessment |
|---|---|---|---|
| Brand and header | Red masthead, white dog-and-mountains wordmark, small tagline, uppercase primary links. The captured Beta-1 session also showed account and workspace controls. | Red masthead, white logo and tagline, six primary links. Alpha-1 v3 screenshot shows the wordmark wrapping into narrow letter groups. Current source removed the restrictive 9-character wordmark width in PR #84. | Brand family is shared. Beta-1 has different routes and session controls. Alpha wrapping is deployment lag (`VIS6-HEADER-001`). |
| Trust strip | Dark strip communicates allegations are not findings, independence, community operation, and public-preview context. | Dark strip says records cite public sources and are not findings, plus independence/community status. | Appropriate shared convention with target-specific wording; no defect established. |
| Color and surfaces | Red masthead and action controls, dark trust bar, pale page background, strong white text over a scenic hero, simple light cards below. | Source CSS uses red/black/off-white with white bordered cards, compact square corners, red uppercase eyebrow labels, and dark display headings. | Coherent identity across targets. Token values in source support design context; browser captures support rendered claims. |
| Type hierarchy | Large heavy white home headline over photography; compact uppercase navigation and section labels; readable body text. | Heavy sans headings, body sans, red eyebrow labels. Alpha-1 v3 has a three-line home title; PR #84 widens the current source headline measure. | Preserve clear hierarchy. Current Alpha title wrap is deployment lag (`VIS6-HERO-001`). |
| Homepage art | Wide scenic image slideshow with location caption and visible pause, reduce-animation, and next controls. | Alpha-1 v3 presents a static mascot illustration. Current source supports one data-driven static banner frame and a branded fallback. | This is a meaningful content and behavior difference, not a confirmed visual defect. Homepage assessment belongs to VIS-7; motion/accessibility detail belongs to VIS-18. |
| Cards and content panels | Homepage and county landing use large scenic headers, statistic bands, pathway cards and local directory sections. | Current source uses bordered white cards, section headings and compact directory rows. Alpha-1 has a county index on its homepage and content sections after the hero. | Page composition belongs to the page-family auditors; keep this as the shared pattern reference. |
| Navigation and footer | Primary links expose Counties, Officials, Community Voices, Help, Legal & Policy, About, and report submission. Footer repeats About, Help and Legal & Policy. | Source header exposes Counties, Officials, Organizations, Stories, Posts and About. Footer groups Directories, Community Voices and About, including Reading Records. | Both surfaces give repeated route access. The Beta-1 help/legal/report paths require dedicated mapping; do not call them defects solely because they differ. |
| Accessibility affordances | Skip link; county map links have county names; controls are named in the accessibility tree. Slideshow exposes pause, reduce animation, and next controls. | Source has skip link, semantic navigation/breadcrumb markup, visible-focus rules and a mobile menu with Escape handling. | Presence was inventoried, keyboard/focus states were not exercised. VIS-18 owns verification. |

## Confirmed findings

### VIS6-HEADER-001 — Alpha-1 wordmark wraps (deployment lag, P2)

The Alpha-1 v3 desktop screenshot shows “Colorado Watchdog” broken across multiple narrow lines in the masthead. The current GitHub source removes `.brand-name`'s restrictive `max-width: 9ch`; PR #84 is already merged. Disposition: **Preserve Beta-2**. No new implementation work is assigned. Hosted verification remains pending redeployment.

### VIS6-HERO-001 — Alpha-1 homepage headline breaks across three lines (deployment lag, P2)

The Alpha-1 v3 screenshot breaks the homepage headline into “Community Voices.” / “Government” / “Accountability.” Current source sets a wider homepage headline measure in PR #84. Disposition: **Preserve Beta-2**. VIS-7 owns page-specific review; hosted verification remains pending redeployment.

No other shared-component issue met the evidence threshold for a defect. Differences in content, data, route inventory and architecture remain separately classified in the ledger.

## Responsive and evidence limits

The available browser surface produced desktop screenshots displayed at approximately 1265 × 720 pixels. It did not expose an exact viewport override for the requested 1440 × 900, 768 × 1024 and 390 × 844 sizes. Beta-1 mobile menu behavior, Alpha-1 responsive rendering, keyboard focus rings and the slideshow controls' actual state changes therefore remain unverified. Source breakpoints are documented only as implementation evidence, not as proof of rendered behavior.

The browser capture tool displayed screenshots inline but did not provide a local export path. This report records stable evidence aliases and the observed targets; the screenshot images are not included as repository files. The evidence index marks that limitation rather than inventing filenames.
