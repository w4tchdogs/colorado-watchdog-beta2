# Source page types

`sources.publisher_classification` records whether the publisher is `official`, `unofficial` or unresolved. This does not replace the separate `sources.page_type` field. R7 sends a source to the Website only when the publisher classification is `official` and `page_type` is exactly `official_page`, `public_document` or `other_public`.

The rule `url-extension/v1` plans a value for each source with publisher classification `official` whose `page_type` is empty. A URL path ending in .pdf, .doc, .docx, .xls, .xlsx, .ppt, .pptx, .csv, .txt or .rtf gets `public_document`. Every other official source gets `official_page`. This rule classifies only page/document type: the suffix does not prove who published it. Sources not classified official and sources that already have a value are never touched. `other_public` is never assigned automatically.

Use the evidence-led publisher workflow in [publisher classification and private export](publisher-classification-and-private-export.md) to establish source authority. It preserves legacy `official_status` values and classifies linked unresolved publishers only when evidence supports a decision. A profile with no linked source exports a null classification; an unresolved linked publisher remains explicitly unresolved.

```powershell
$db = "D:/ChatGPT/Watchdog/profiles/database/research.sqlite"
python -B -m research preview-source-types $db --output "D:/ChatGPT/Watchdog/profiles/reports/source-page-type-plan-YYYY-MM-DD-v1.json"
python -B -m research backup $db "D:/ChatGPT/Watchdog/profiles/backups/research-pre-page-type-YYYY-MM-DD.cwbackup"
python -B -m research apply-source-types $db --plan <plan> --expect-plan-sha256 <plan_sha256>
python -B -m research verify-source-types $db --plan <plan> --expect-plan-sha256 <plan_sha256>
```

The preview opens the database read-only and writes a private plan outside the checkout. Apply checks the plan hash, refuses if any source changed since the preview, updates every planned source in one transaction and records one `source_page_type_set` event each. Corrections to individual sources are separate later changes.
