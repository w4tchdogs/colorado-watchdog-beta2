# BANNERS-4A screen reader verification

Status: verified with NVDA on the county carousel, with the gaps listed below. No carousel defect was confirmed, so no source or test changed.

## Environment

- Windows 11 IoT Enterprise LTSC 2024 (10.0.26100), Google Chrome 157.0.8103.79, NVDA 2026.3.1 (installed from the NV Access download, signature valid).
- Source tested: `main` at `afd312a`, served with `SITE_PORT=8811 npm run site:dev:banners` (synthetic fixtures only).
- NVDA ran with input/output logging, and the quotes below are lines from its own speech log. Chrome ran with `--force-renderer-accessibility` and a separate profile.
- Windows animation effects were off on the test computer, so Chrome reported `prefers-reduced-motion: reduce`. That was used as the real reduced-motion test. For playback tests the media query was overridden to no-preference through the Chrome DevTools protocol, and the image block was applied the same way. Nothing in the Windows settings was changed.
- Keys were sent as synthetic keystrokes through the operating system. NVDA browse-mode quick keys (`b`, `Shift+b`, `g`) moved the reader, and Enter or Space activated buttons.

## Results (`/counties/08001`, two banners)

| Scenario | NVDA speech |
| --- | --- |
| Control names and order | "Banner carousel", "grouping", then "Previous banner button", "Next banner button", "Pause banner rotation button", "Play banner rotation button" |
| Next | "Banner 2 of 2", then "Banner 1 of 2" on wraparound, each spoken once |
| Previous | "Banner 1 of 2", then "Banner 2 of 2" on wraparound, each spoken once |
| Focus after Enter or Space on Next | Stays on Next (checked with `document.activeElement`), position spoken each time |
| Initial Pause and Play | Pause "unavailable", Play available |
| Explicit Play | Only "unavailable" is spoken on the pressed Play button (it becomes disabled) and Pause becomes available. No "playing" text. |
| Timed advance (about 8 seconds, 20 second window) | "Banner 2 of 2" then "Banner 1 of 2" through the live region |
| Explicit Pause | Only "unavailable" is spoken on Pause. No advance in the following 11 seconds. |
| Reduced motion (real Windows setting) | Play announced "unavailable", Enter on it did nothing, and Next and Previous still announced positions |
| Blocked image on banner 2 | "Banner 2 of 2 · Image unavailable". Play stays "unavailable" and does not start. |
| Recovery | Next to banner 1 then banner 2 with the block removed gave "Banner 1 of 2", "Banner 2 of 2" and Play became available |
| Selected image and caption | "Synthetic 21 by 9 test pattern." with "graphic", then the caption "Synthetic 21:9 pattern, cover" as the next line, then the carousel group and its status |

Duplicate or missing speech: none for position changes. The one duplicate seen ("Banner 2 of 2" followed by "Banner 2 of 2 · Image unavailable") is the intended status update when an image fails after the selection.

## Gaps and observations

- Play and Pause give no explicit "playing" or "paused" confirmation. The only speech is "unavailable" on the pressed button, because the code toggles `aria-disabled` without touching the live region. This is a possible improvement for 💠archon to decide, not changed here.
- The homepage has no carousel with the synthetic fixtures (they cover Adams, Boulder, Larimer and Weld counties only), so the homepage was not tested.
- NVDA did not reliably speak plain Tab focus changes in this harness (the focus events were not reported after page loads), so tab order is verified from DOM order (Previous, Next, Pause, Play, all `tabindex` 0) and focus retention from `document.activeElement`, not from hearing each Tab.
- One reader and one browser only (NVDA with Chrome). No JAWS, Narrator or Firefox.
- Timed advance was heard with focus on the button that started it. Focus entering the carousel afterwards stops playback by design and was not re-tested by ear.
