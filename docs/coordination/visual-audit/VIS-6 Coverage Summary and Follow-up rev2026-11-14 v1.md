# VIS-6 Coverage Summary and Follow-up

**Audit:** VIS-6 — Colorado Watchdog Beta-2
**Revision:** 2026-11-14 v1
**Canonical ledger:** [coverage-ledger.csv](coverage-ledger.csv)

## Coverage summary

The ledger has **38 unique stable records** with 19 columns and an explicit primary owner for every row. It records **16 page/supporting-page families**, **8 shared visual or responsive components/design entries**, **8 interaction groups**, **3 visitor workflows**, **1 error-state family**, and **2 authentication boundaries**. These are coverage records, not a claim that every state or route was exhaustively inspected.

Beta-1's observed and discoverable public coverage includes:

- Homepage sections: scenic banner and controls, statewide counts, county/officials/report/Community Voices pathways, source-record principles.
- County directory with a 64-county interactive map and searchable county list; one Adams County detail template with county switching, counts, official/structure navigation, and local Community Voices panel.
- Officials directory with named-profile/structure modes, county and office filters, a search field, and a missing-directory-entry request pathway.
- Community Voices landing with The Idlewild Story, Guest Voices and Statewide County Issues pathways, filters, story submission, and one linked story card.
- About, Help, Legal & Policy, standalone How Reporting Works and CORA guides, report entry, private guest tracking, guest story submission, directory correction requests, and private takedown requests.
- Shared header, trust strip, footer, county contextual navigation, scenic/banner imagery, cards, typography/color patterns, skip link, named map links and animation controls.

Current Beta-2 source adds or structures county organization records, standalone organizations and people routes, Stories and Posts as separate collections, citation guidance, and guarded report/tracking routes. It also keeps the staff report queue behind an access check and gates real report submission. These are not to be flattened into Beta-1 visual parity.

## Coverage gaps and unresolved items

1. **No standard viewport pass.** Exact 1440 × 900, 768 × 1024, and 390 × 844 renders could not be set in the available browser. VIS-18 should capture the desktop/tablet/mobile shared components.
2. **Screenshots are not exported.** Browser screenshots were captured and inspected inline, but the available capture surface provided no local file export. Evidence is indexed by target/route aliases in the Evidence Index.
3. **Deployment lag.** Alpha-1 v3 was published from commit `055dd503`, earlier than current `main` `f991810`. PR #84 header/headline fixes and PR #85 homepage integration require a future hosted check; no new defect is filed for merged corrections.
4. **Beta-1 session context.** Beta-1 rendered an account menu and workspace control in the browser session. Only public pages were read; the private workspace and private records were not opened. Re-capture with a signed-out or clean public session if a strictly anonymous public baseline is required.
5. **A representative county detail exists, but only Adams was sampled.** Do not infer every county has equal content or banners from that one page.
6. **Organizations route uncertainty.** Beta-1's primary nav and observed internal links did not surface a separate Organizations destination. The route was not independently investigated, so its existence remains unresolved.
7. **Posts route uncertainty.** Beta-1's Community Voices page exposes story pathways and filters but no separate Posts link in the captured state. Do not record absence until internal links or route listings are checked.
8. **Individual profile, story detail and takedown destinations were not opened.** Their links/routes are inventoried for their dedicated audits. The public CORA and reporting explainer pages were opened; their copy/reset or in-page navigation controls were not activated.
9. **The private My Contributions route was not opened.** Its link was observed on public help and reporting pages; no private account page or data was accessed.
10. **Interactions were inspected for presence only.** Search result states, filters, sorting, pagination, report/story validation, confirmation, loading and error states were not triggered. The directory request displayed a loading-choice status and was not submitted.
11. **Beta-2 hosted routes beyond the Alpha homepage were not browser-sampled.** Current source routes are explicitly identified as source observations and must not be presented as deployed behavior.

The owner field assigns all unresolved work to VIS-7 through VIS-19 according to the stated ownership map. There is no new implementation task for this audit. The ledger marks uncertain Beta-1 routes as unverified rather than absent.

## Follow-up assignments

| Audit | Practical next scope from this inventory |
|---|---|
| VIS-7 | Compare homepage content hierarchy and banner treatment; recheck headline only after Alpha-1 picks up PR #84/#85. |
| VIS-8 | Inspect map keyboard use, map-to-directory parity, county search results and the 64-county route mapping. |
| VIS-9 | Compare county detail templates, contextual navigation, county-specific content and empty/data states. |
| VIS-10 | Exercise officials search, county/office filters, structure switch, sort/pagination, no-results states and missing-entry request link. |
| VIS-11 | Inspect one public individual profile, role/source/history presentation and return navigation; avoid private research data. |
| VIS-12 | Determine whether Beta-1 organization routes exist; assess Beta-2 organization hierarchy, affiliations and detail pages. |
| VIS-13 | Map Beta-1 Community Voices pathways and filters to the separate Stories/Posts model; verify Beta-1 Posts route status. |
| VIS-14 | Inspect one real public article detail and related county/person/organization/source links. |
| VIS-15 | Map Help, Legal & Policy, About, How Reporting Works, CORA and reading-record guidance destinations and identify actual Beta-2 equivalents. |
| VIS-16 | Review report and Guest Voices forms, directory correction requests, recovery/tracking, takedown pathways and all guardrails without submitting. |
| VIS-17 | Verify the My Contributions/private workspace boundary and authenticated navigation without opening restricted private data. |
| VIS-18 | Re-run shared header, footer, focus, motion and control checks at desktop/tablet/mobile; export screenshots. |
| VIS-19 | Trace county-to-person, story-to-detail, and report-to-tracking/correction links end to end without creating submissions. |

VIS-5 remains the ongoing broad baseline assignment. VIS-6 did not repeat its page-by-page audit or run VIS-8 as a subtask.

## Closeout

The canonical ledger and related audit notes are prepared on an isolated branch. A four-path allowlist update in the repository's starter check is included because that required check otherwise rejects all new files in this audit directory; the audit check passed after the update. The change does not alter application behavior or hosting configuration. No application data, private workspace, or submission flow was changed. Remaining evidence limits are listed above. This closeout is for VIS-6 only.
