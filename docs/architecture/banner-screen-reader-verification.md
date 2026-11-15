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

## BANNERS-4B: full-width heroes and playback speech

Status: verified locally with NVDA 2026.3.1 and Chrome 157.0.8103.79 on Windows 11 (10.0.26100), synthetic fixtures only. Not deployed and not verified on the hosted Site. The homepage gap above is closed: the preview now shows two synthetic homepage banners.

### Change in speech

- Added a polite, visually hidden `data-banner-announce` region. It says "Banner rotation playing" after a successful Play and "Banner rotation paused" when the visitor's own action stops running rotation. Automatic stops stay silent, and an unavailable Play says nothing.
- The first NVDA run showed that "paused" was never spoken for an explicit Pause. Focus entering the carousel already stops rotation (existing rule), so the Pause button is disabled by the time it is pressed. Stopping from the visitor's own focus or pointer entry now says "paused" once.

### Spoken output and DOM state (NVDA speech log, then DOM read through Chrome DevTools)

| Scenario (homepage and `/counties/08001` gave the same results) | NVDA speech | DOM state afterwards |
| --- | --- | --- |
| Next, Next, Previous, Previous | "Banner 2 of 2", "Banner 1 of 2", "Banner 2 of 2", "Banner 1 of 2" once each | Focus on the pressed button |
| Play | "Banner rotation playing", then "unavailable" for the now disabled Play button | Play disabled, Pause enabled, announce text "Banner rotation playing" |
| Timed advance (about 8 seconds, 20 second window) | "Banner 2 of 2", then "Banner 1 of 2" | Position status updated, announce text unchanged |
| Pause (explicit, focus already in the carousel) | "Banner rotation paused", then "unavailable". No advance in the next 11 seconds. | Pause disabled, Play enabled, announce text "Banner rotation paused" |
| Pause pressed again | Silence | No change |
| Play again after Pause | "Banner rotation playing" again | Same as first Play |
| Focus entering a running carousel | "Banner rotation paused" before the position change | Rotation stopped |
| Image failure on banner 2 (synthetic image blocked) | "Banner 2 of 2", then "Banner 2 of 2 · Image unavailable". Play is "unavailable" and Enter on it is silent | `data-banner-state` unavailable, announce text empty |
| Recovery (block removed, Next to banner 1, Next to banner 2) | "Banner 1 of 2", "Banner 2 of 2", Play available again | `data-banner-state` ready |
| Reduced motion (media query override to reduce) | Play pressed: silence, no advance. Next and Previous still say "Banner N of 2" | Play disabled |
| Alt text and caption (Adams) | "Synthetic 13 by 5 test pattern." "graphic", then "Synthetic 13:5 pattern, cover, centered", then "Banner carousel" "grouping" "Banner 1 of 2" | Not applicable |

### Limits

- On this computer Windows animation effects are off, so Chrome reports reduced motion natively. Playback tests overrode the media query to no-preference through DevTools, and the reduced-motion rows overrode it to reduce. The Windows setting was not changed.
- The image failure on the homepage used a DevTools request block, and the Adams failure used the same block on a fresh Chrome profile, because Chrome's image cache ignored the block on repeat loads in one profile. The block was lifted by replacing it with a pattern that matches nothing.
- Real Tab-key speech was unreliable here (see the earlier gaps), so tab order and focus retention are from the DOM. Activation by NVDA left DOM focus on the pressed button in every logged read.
- One reader and browser only. Hosted behavior and real artwork are untested.

### Hero width (Chrome, scrollbar-aware, `clientWidth` as the available width)

| Path | Width | Before: frame and control bar | After: frame and control bar |
| --- | --- | --- | --- |
| `/`, `/counties/08069`, `/counties/08001`, `/counties/08005` | 390 | 375 | 375 |
| same | 768 | 753 | 753 |
| same | 1440 | 1425 | 1425 |
| same | 1920 | 1600, offset 153 | 1905, offset 0 |
| same | 2560 | 1600, offset 473 | 2545, offset 0 |

Before values come from `main` at `919492a`, after values from this branch. At every size and path the frame was exactly 3:1 (for example 2545 by 848.3 at 2560), had no horizontal overflow, and the text column stayed at 1152 pixels wide above 1440 (335 at 390 and 713 at 768, where the layout stacks). The branded fallback (`/counties/08005` and the homepage with `--no-home-banners`), a single image (`/counties/08069`) and multiple images (`/`, `/counties/08001`) were all measured. With scripts disabled, every path with images still showed its server-rendered first image loaded, with the carousel controls hidden.
