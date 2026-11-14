# Brand image derivatives

These PNG files are reduced web copies of the owner's Colorado Watchdog logo
and mascot masters. The masters are kept outside this repository (the owner's
`assets/image-masters/logo-mascot/` directory) and were not modified.

Each derivative was produced by trimming the fully transparent margin and
scaling the master down proportionally with alpha preserved. Nothing was
redrawn, recolored, stretched or cropped into the artwork.

| Derivative | Master file | Master SHA-256 (first 16) | Pixels | Bytes |
| --- | --- | --- | --- | --- |
| `brand-logo-white.png` | `watchdog-logo-wolf-mountain-arc-white.png` | `d53bcf88c5eafff2` | 192 x 184 | 15073 |
| `brand-logo-white-large.png` | `watchdog-logo-wolf-mountain-arc-white.png` | `d53bcf88c5eafff2` | 480 x 461 | 74454 |
| `favicon-light.png` | `watchdog-logo-wolf-mountain-arc-black.png` | `e976267a68bef1dc` | 64 x 61 | 2426 |
| `favicon-dark.png` | `watchdog-logo-wolf-mountain-arc-white.png` | `d53bcf88c5eafff2` | 64 x 61 | 2954 |
| `brand-mascot-standing.png` | `watchdog-mascot-standing-black.png` | `1da158c75b88c2fc` | 420 x 427 | 28041 |
| `brand-mascot-lying.png` | `watchdog-mascot-lying-black.png` | `6e61afbc10ae5f99` | 420 x 366 | 21016 |
| `brand-mascot-sit-alert.png` | `watchdog-mascot-sit-alert-black.png` | `3d478d6e7fb41ca8` | 420 x 424 | 28455 |

Use:

- `brand-logo-white.png`: header and footer logo.
- `brand-logo-white-large.png`: watermark in the banner placeholder.
- `favicon-light.png`, `favicon-dark.png`: browser tab icon for light and dark
  color schemes.
- `brand-mascot-standing.png`: homepage evidence section.
- `brand-mascot-sit-alert.png`: About page.
- `brand-mascot-lying.png`: error pages.

No county banner artwork is stored here. See
`docs/architecture/public-site.md` for the banner presentation contract.
