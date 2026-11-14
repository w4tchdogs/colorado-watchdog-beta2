# Local county banner inventory (BANNERS-1)

This tool inventories the owner's approved source images without changing them. It does not upload, publish, transform, rename, or remove artwork. Beta-1 artwork is never read by this workflow. It is independent of the Website and Profiles databases.

## Run on Windows

From the Beta-2 repository root, use Node.js 22 or newer. Set the three local variables to the approved source and its two output folders:

```powershell
npm install
$sourceDir = Read-Host 'Approved banner source directory'
$manifestDir = Read-Host 'Banner manifest output directory'
$reportDir = Read-Host 'Banner report output directory'
npm run banners -- --source $sourceDir --manifest-dir $manifestDir --report-dir $reportDir
```

The source path is read-only. The tool walks files under that directory, skips symbolic links, and refuses a symbolic-link source root. It limits image decoding to 25 MiB per file and 24 million pixels by default. Set `--max-bytes`, `--max-pixels`, `--min-width`, or `--min-height` to change those scan limits. Oversize files are hashed as a stream but are not decoded.

Each run creates collision-safe revisioned outputs, never overwriting an earlier output:

- `Banner inventory revYYYY-MM-DD vN.json`: observed file facts (bytes, digest, dimensions, format, orientation, decoder result, and issues).
- `Banner manifest revYYYY-MM-DD vN.json`: editable metadata, stable banner IDs, current source versions, and retained history.
- `Banner change report revYYYY-MM-DD vN.json`: dry-run reconciliation classifications.
- `Banner validation report revYYYY-MM-DD vN.md`: readable summary, format and dimension/aspect-ratio distribution, and per-file warnings/errors.

Run the next scan against a prior manifest to compare content and missing files:

```powershell
npm run banners -- --source $sourceDir --previous (Join-Path $manifestDir 'Banner manifest revYYYY-MM-DD vN.json') `
  --manifest-dir $manifestDir --report-dir $reportDir
```

For owner metadata edits, copy the manifest to a separate working file, edit `countyFips`, caption, alt text, `displayMode` (`cover` or `contain`), focal coordinates (`focalX`/`focalY`, each 0 through 1), order, primary flag, or lifecycle state, then pass both `--previous` (the last generated baseline) and `--metadata` (the edited copy). County edits must use one of the canonical county FIPS values included in the manifest. This reports metadata-only changes separately and carries the values into the new proposal. Keep prior files so identity and history remain reviewable.

Stable IDs are initialized once from the relative source filename and then carried forward in the manifest. They do not use the content digest, display order, or a future storage key. A renamed file is not silently associated by filename; matching prior content under a new filename is flagged as an ambiguous possible rename/duplicate. A changed digest at the same filename creates a proposed next version while retaining all prior version entries. Missing files remain in the manifest with `sourceMissing: true`; this is a review candidate only and does not unpublish or delete anything.

Suggested filename captions are marked `metadataSource: "filename_suggestion"`; unclear filenames have empty captions and `metadataNeedsReview: true`. These are not owner-approved descriptions. The source geometry is retained as metadata. Ratios around 21:9 through 3:1 are accepted; image decode checks do not require a 3:1 source. The warning band is 2.25–3.20, which accommodates small dimension rounding around the intended panoramic formats and surfaces wider departures for review. The future 3:1 hero may use nondestructive cover or contain with configurable focal positioning.

## Verification

The automated tests create synthetic JPEG and PNG fixtures, including variable panorama ratios, malformed data, duplicate bytes, replacement, disappearance, metadata-only edits, limits, and symlink safety. They do not use private artwork. A `full_decode_passed` result means the selected JPEG or PNG decoder consumed the image successfully. Header fields alone are never described as full integrity validation.

## Scope boundary

BANNERS-1 produces local proposals only. No Website schema, D1/R2 integration, upload, activation, unpublication, cache operation, Site deployment, or admin interface is implemented. These require later scoped work. The M4 public hero and visual changes in PR #57 remain outside this asset-tool branch.
