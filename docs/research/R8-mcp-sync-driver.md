# R8 local Website MCP sync driver

This local driver sends a prepared R6 Profiles submission through the Website's
existing bounded MCP protocol. It does not read a changeset from chat text. The
R6 database row and a private disk export must contain byte-for-byte identical
request JSON. Store both outside the repository and restrict access to the
Profiles operator.

## Prepare and send

Run the normal R8 preview and `sync-prepare` first. Review the private prepared
request before sending. Export its exact bytes to a new file, then use the local
MCP sender with the exact endpoint ending in `/mcp`:

```powershell
$db = 'D:/ChatGPT/Watchdog/profiles/database/research.sqlite'
$submission = '<local-submission-id>'
$request = 'D:/ChatGPT/Watchdog/profiles/reports/prepared-request.json'
python -B -m research sync-export-prepared $db --submission-id $submission --output $request
python -B -m research sync-mcp-send $db --submission-id $submission `
  --request-file $request --endpoint 'https://<staging-host>/mcp'
```

The driver prompts for a bearer credential without echoing it. It checks the
endpoint protocol and all four tool names, performs a dry run for the first
attempt, and injects a transport callback into `submit_prepared`. The callback
checks that R6 supplied the stored site key, commit path, idempotency key and
exact prepared bytes. It embeds the same request JSON bytes in the MCP call.

After commit, the driver reads every `website_sync_lookup` page, verifies stable
batch metadata and contiguous ordered `itemIndex` values, and only then returns
the complete receipt to R6. Any timeout, invalid page or disagreement leaves
the R6 row pending. Re-run the same command with the same request file; it
reuses the stored request and idempotency key. Do not prepare a replacement
request while the prior one is pending.

Recover and reconcile the saved receipt with R8:

```powershell
python -B -m research sync-status $db --submission-id $submission
python -B -m research sync-reconcile $db --submission-id $submission
```

The status command omits the request body. Reconciliation uses only the
complete receipt stored by R6.

## Reverse a reconciled test batch

Only reverse a batch belonging to the reconciled local submission. Use a new
idempotency key for the reversal and verify the Website readback and local R8
reversal reconciliation:

```powershell
python -B -m research sync-mcp-reverse $db --submission-id $submission `
  --idempotency-key '<unique-reversal-key>' --endpoint 'https://<staging-host>/mcp'
```

The reverse command checks the batch is committed, calls `website_sync_reverse`,
confirms lookup reports `reverted`, and records the reversal through
`sync.reconcile_reversal`. Keep the credential, endpoint configuration where
private, exported request, and receipts out of command transcripts and GitHub.

For a one-command staging acceptance, `sync-mcp-roundtrip` is restricted to
the existing `colorado-watchdog-alpha1-staging` Worker and a request with one to
five `create_person` operations whose only field is a synthetic display name.
It sends through R6, runs R8 commit reconciliation, reverses with the supplied
reversal key, verifies the reverted lookup, and runs local reversal
reconciliation before returning a bounded summary:

```powershell
python -B -m research sync-mcp-roundtrip $db --submission-id $submission `
  --request-file $request --reversal-idempotency-key '<unique-reversal-key>' `
  --endpoint 'https://<staging-host>/mcp'
```

## Synthetic verification only

The focused tests use disposable, on-disk SQLite state and a synthetic Website
MCP server. They cover prepare/export, first-attempt dry run, exact-byte R6
delivery, complete paged receipt recovery, lost-response retry with one server
batch, R8 reconciliation, reversal and local reversal reconciliation. A hosted test
must use the existing staging Worker, synthetic records, its scoped sync
grants, and must confirm cleanup and revoke temporary access before reporting
completion. This tool does not grant access or deploy a Worker.
