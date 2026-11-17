# Administrative MCP foundation

This change adds two read-only MCP surfaces for local development and later
operator evaluation. It does not publish the Site, apply a migration, connect
to a hosted database, or import profile data.

## Website inspection

The Sites Worker exposes `POST /mcp` using the Sites protocol version
`2026-07-28`: `server/discover`, `tools/list`, and `tools/call`. Discovery is
public. Calls require an existing Website-agent bearer credential resolved by
the established account service and the `d1.inspect` capability. The handler
does not accept an actor identity from request parameters or trust injected
identity headers. Website Owner and Administrator roles receive the capability;
Agent Owner credentials are explicitly refused.

**Inspection-only grant (MCP-2).** Migration `0025_agent_inspect_grant.sql` lets the existing owner-only, audited agent capability grant carry `d1.inspect`. A contributor agent holds no role capability, so with only that grant its credential passes the MCP inspection gate and nothing else: it holds no account, identity, audit, checkpoint, banner, content, report or sync capability, and the grant is checked in the same account service the dashboard and Website API use. Grants are retained after revocation. Revoking the grant, the credential or the account removes access. Issue the credential from the account dashboard or `PUT /api/admin/accounts/{id}/capabilities` and `POST .../credentials` as the Website Owner.

The fixed tools report inspection status, county reference counts, migration
history, and county provenance summaries for Lake (`08065`) or La Plata
(`08067`). They expose aggregate counts only. They do not accept SQL, table
names, arbitrary counties, record identifiers, or write operations. Sensitive
report counts below five are suppressed. Query failures produce unavailable
status rather than partial raw data.

Migration comparison uses a build-time catalog of migration names and hashes.
The catalog is computed from the checked-in files during the Sites Worker
build. The service only reads `schema_migrations`; it never repairs or writes
the ledger. The physical database identity is reported as unavailable because
the binding does not provide a trustworthy physical identity. County FIPS
values alone are not treated as proof of how a record was assigned, so
provenance remains unresolved unless the schema supplies explicit evidence.

The repository's `.openai/hosting.json` declares the MCP capability for a
future authorized Sites publication. A source declaration does not enable a
hosted MCP endpoint until the Site is configured and published. The current
Sites connection lookup did not establish the target project's identity, so no
hosted database was inspected and no publication was attempted.

## Profiles readiness

`npm run profiles:mcp` starts an MCP stdio server using the official TypeScript
SDK. `profiles_readiness_summary` launches only the fixed Python
`mcp-readiness-summary` command. The database path must be supplied through
`WATCHDOG_PROFILES_DATABASE` and point outside the repository. The subprocess
uses a bounded execution time and output size, with a restricted environment;
the MCP caller cannot pass a path, SQL, or command arguments.

The Python command opens the database read-only and previews the existing
Colorado County sync mapping without emitting names, record IDs, notes,
evidence URLs, filesystem paths, or generated requests. It returns aggregate
eligibility and exclusion counts and whether a read-only preview is possible.
This is a readiness report, not an import or synchronization action.

## Verification and operational boundary

The MCP tests use synthetic local databases. They verify Sites discovery and
authorization, static bounded tool arguments, migration drift detection,
sensitive-count suppression, aggregate profile output, and unchanged database
fingerprints. Neither interface authorizes an import, publication, migration,
or other write operation.

Native Sites MCP is the intended route for a published Site where the Sites
platform is configured for MCP. ChatGPT custom remote MCP connections are
available only in supported plans and workspaces and require the relevant
administrator configuration. Codex can run the Profiles server locally over
stdio; an API-hosted agent that needs a private local MCP server would require
the separately configured Secure MCP Tunnel. These are platform connection
options, not deployment authorization.

No R2 inspection tools, profile write/sync tools, migrations, owner creation,
or public-profile actions are included. Their interfaces and authorization
remain separate future work.
