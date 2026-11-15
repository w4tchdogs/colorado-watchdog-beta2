# BANNERS-4A screen reader verification

Status: speech verification **open**. No Windows screen reader was available to the executing session, so nothing below was heard or captured from speech output. This note records what the code is designed to announce and the manual procedure for 💠archon or the owner.

## Environment of the attempt

- Windows 11 IoT Enterprise LTSC 2024 (10.0.26100), Google Chrome 157.0.8103.79.
- NVDA and JAWS: not installed (no `nvda.exe` under Program Files, no uninstall entry). Windows Narrator ships with Windows but its speech log cannot be captured by the session, and installing NVDA would be a download that was not authorized.
- Source tested: `main` at `ba565a6` (includes PR #109). No source change was made.

## Announcements the code is designed to produce

From `src/site/banner.ts` and `website/site/site.js`:

| Element | Accessible name or text |
| --- | --- |
| Controls group | role group, "Banner carousel" |
| Status (polite, atomic live region) | "Banner N of M", with " · Image unavailable" appended when the current image failed |
| Buttons | "Previous banner", "Next banner", "Pause banner rotation", "Play banner rotation" |
| Image | the selected slide's alt text, on a freshly created `img` each selection |
| Caption | plain text in the frame, not in the live region |

Points the speech test must confirm, because the code alone cannot:

1. Previous and Next announce "Banner N of M" once, including wraparound (1 to M and M to 1), and focus stays on the pressed button.
2. Play and Pause change only `aria-disabled` on the buttons and do not update the live region, so no status text is expected on either. Confirm whether that silence is acceptable or a gap.
3. A timed advance (default 8 seconds, after explicit Play) announces "Banner N of M" through the live region. Focus entering the carousel stops playback, so a timed advance can only be heard while focus is elsewhere.
4. With `prefers-reduced-motion: reduce`, Play does nothing and Previous and Next still work.
5. With one synthetic image blocked, the status reads "Banner N of M · Image unavailable", Play is disabled, and selecting a working banner returns the status to "Banner N of M".
6. Alt text is read when browsing to the image, and the caption is read as separate text. Record any duplicate or missing speech.

## Manual steps

1. In the worktree or `main`, run `npm run site:dev:banners` and note the local URL it prints.
2. Start NVDA (or the reader in use) with its speech viewer open (NVDA menu, Tools, Speech viewer). Record the NVDA and Chrome versions.
3. Open the homepage, then `/counties/08001`. Press Tab from the page start to the carousel group. Record the order and the name spoken for each control.
4. Press Enter or Space on Next until it wraps, then on Previous until it wraps back. Copy the speech viewer lines.
5. Press Play, then move the reader's virtual cursor off the carousel (focus inside it stops playback, so a timed advance is only testable with focus elsewhere). Record what is spoken on Play, on each timed advance and on Pause.
6. Turn on Windows Settings, Accessibility, Visual effects, Animation effects off (reduced motion), reload, press Play and confirm nothing advances while Next still works.
7. In Chrome DevTools, Network, block the request URL of one fixture image, reload, select that banner and record the status. Unblock it, select the next banner and record the recovery.
8. Browse to the selected image with the arrow keys and record how the alt text and caption are spoken.
9. Paste the speech viewer text and any defects into the PR or an Issue.

## Result

Speech behavior: **not verified**. Prior evidence remains PR #109's Chrome accessibility-tree check. No carousel defect was confirmed or fixed here, and `tests/site-banner.test.mjs` was not changed.
