# AUTH-5 design: inviting editors and administrators

Status: design only. Nothing here is implemented, merged as code, deployed or hosted-verified. Every choice marked **Proposed** is a recommendation for the owner and not accepted policy. Source baseline: GitHub `main` at `5028b2d693accbabb3e7ef9e17ed2be5e1661ffe`.

## Goal and scope

Roadmap goal 3 needs owners, administrators and editors to be invited, sign in on the hosted Site and reach what their role allows. AUTH-5 is the invitation step. It covers the editor and administrator roles for human accounts. It does not cover contributors (stage B), guests, agents, a second owner, or email delivery. Public registration stays closed.

## Accepted policy and existing guarantees

These are accepted or already implemented, with their source. AUTH-5 relies on them and changes none of them.

| Rule | Source |
| --- | --- |
| Sign-in never creates an account, a link or a role. A verified subject that is not linked to an active human account gets `403` | [human-sign-in.md](human-sign-in.md) |
| The sign-in transaction is consumed once with a conditional `UPDATE ... RETURNING`, and the session is created by one guarded `INSERT ... SELECT` that re-tests the link and account status | [human-sign-in.md](human-sign-in.md) |
| Role, disable and revoke changes apply on the next request, because every request re-reads the account and identity | [human-sign-in.md](human-sign-in.md) |
| `identities` has `UNIQUE (provider, subject)`. An existing provider subject cannot be relinked. Email and display name are never identity keys | `website/migrations/0002_foundation.sql`, [account-management.md](account-management.md) |
| Only an owner can link a human provider subject. Only an owner can create a human account with a role other than a bare contributor, because creation needs `account.change_role` | `createHumanIdentity` and `createAccount` in `src/services/accounts.ts` |
| At least one active human owner with a live human identity must remain. Agents cannot be owners | `ensureAnotherActiveOwner` in `src/services/accounts.ts` |
| Disabling an account stops all its identities. Revoking an identity ends that link. Revocation is final because no service clears `revoked_at` | `src/services/accounts.ts` |
| Account mutations are version-checked and write an append-only `audit_events` row in the same transaction. Audit rows cannot hold credentials | `runAuditedMutation` in `src/services/audit.ts`, 0002 triggers |
| The first owner is linked only by the private bootstrap, with its own append-only audit table | [account-management.md](account-management.md#first-owner-bootstrap), migration 0014 |
| Auth0 with the GitHub connection is the human provider. The provider key is `auth0:` plus the exact issuer. The database connection stays off | [human-sign-in.md](human-sign-in.md), [decisions.md](../decisions.md) |
| Default-deny, capability-limited administration. No unauthenticated administrative endpoint | [AGENTS.md](../../AGENTS.md) |
| Hosted evidence so far covers the owner only. A separate unlinked-account hosted test is unreported | [hosted staging sign-in evidence](https://github.com/w4tchdogs/colorado-watchdog-beta2/pull/174#issuecomment-6932672296) |

Two things the current code does that the design must account for. The ID token check yields only the issuer and subject, so there is no verified email to match against. And the current role matrix lets an administrator disable any account other than the last owner and revoke any identity, because `updateAccount` and `revokeIdentity` check only the capability and not the target's role.

## What AUTH-5 must add

The existing services already guarantee the single-use sign-in transaction, the unique subject, the owner floor, the audit trail and immediate effect of removal. They do not provide any of the following.

1. A way for someone other than the owner to bring an editor or administrator in. Today only the owner can both create the account and link the subject, and must already know the person's exact Auth0 subject.
2. A pre-link sign-in path. The callback refuses every unlinked subject, so acceptance needs its own branch that links under the same guards.
3. Expiry, cancellation and single-use state for a pending grant of access.
4. A record of refused acceptance attempts, which have no signed-in actor and so do not fit `audit_events.actor_account_id`.
5. A rule for who may invite which role.

## Proposed design

### Model: an inert account plus an invitation

The smallest fit is to reuse `accounts` and `identities` unchanged and add one table. Issuing an invitation creates the human account with the intended role and no identity. Such an account is inert already, because no principal resolves without a linked identity. Acceptance only links the verified subject and consumes the invitation. Role and capabilities keep coming from the existing matrix, so no second role store appears.

### Role authority (Proposed)

| Action | Owner | Administrator | Editor |
| --- | --- | --- | --- |
| Invite an editor | Yes | Yes | No |
| Invite an administrator | Yes | No | No |
| Invite an owner | No. Use the existing role change after an owner-invited administrator is linked | No | No |
| Cancel a pending invitation | Any | Editor invitations only | No |
| Remove access (revoke identity or disable account) | Existing behavior | Existing behavior | No |

Implementation would add capabilities `invitation.create_editor` (administrator, owner), `invitation.create_administrator` (owner) and `invitation.cancel` (administrator, owner, with the editor-only limit enforced in the service), rather than granting administrators `account.change_role`. That keeps the current rule that only an owner can promote or link.

### Schema (Proposed, next free migration number after 0025)

New table `account_invitations`, STRICT, with these columns.

- `id`, and `account_id` referencing the pre-created inert account.
- `role` (`editor` or `administrator`), copied from the account at issue time.
- `invited_by_account_id`.
- `token_hash`, a unique SHA-256 of a 32-byte random token. The token is never stored.
- `provider` (`auth0:` plus the issuer at issue time) and `expected_subject`.
- `status` (`pending`, `accepted`, `cancelled`), `created_at`, `expires_at`, `accepted_at`, `cancelled_at`, `cancelled_by_account_id`.
- `identity_id`, unique, set on acceptance.
- `refusal_count` and `last_refusal`, a fixed code.
- `version`, with the usual increment trigger.

Constraints and indexes: one pending invitation per account, enforced by a partial unique index on `account_id` where status is `pending`. Check constraints tie `accepted` to a non-null `identity_id` and `accepted_at`, and `cancelled` to a non-null `cancelled_at`. Expired is not stored. It is derived as pending with `expires_at` in the past, and every guard compares against the clock, so no sweeper is needed.

One additive change to `auth_login_transactions`: a nullable `invitation_id` column so an acceptance flow is bound to its transaction. No change to `accounts`, `identities`, `audit_events` or `auth_sessions`.

A small append-only table `invitation_events` records refused attempts, which have no actor. It holds the invitation ID, a fixed refusal code, and the time, and has update and delete triggers like `audit_events`. Alternative that avoids a table: keep only `refusal_count` and `last_refusal` on the invitation and the existing fixed-label log line. See choice 8.

### Routes (Proposed)

| Route | Behavior |
| --- | --- |
| `POST /api/admin/invitations` | Needs the invitation capability for the role. Same-origin, unknown JSON fields rejected. Takes display name, role, expected subject and an expiry within bounds. Creates the inert account, the invitation and the audit row in one atomic batch. Returns the acceptance link once and never again |
| `GET /api/admin/invitations` | Needs `account.read`. Cursor-paged, at most 100 rows. Returns status, role, inviter, times and the derived expired state. Never returns the token or its hash |
| `POST /api/admin/invitations/:id/cancel` | Needs `invitation.cancel` and the expected version. Marks the invitation cancelled and disables the inert account in one batch, with an audit row |
| `GET /auth/invite/:token` | Read-only confirmation page. Changes nothing, so link previews and prefetch are harmless. `no-store` and `no-referrer`. The response is identical for an unknown, expired, cancelled or accepted token |
| `POST /auth/invite/accept` | Same-origin form post with the token in the body. Re-checks the invitation, creates a login transaction carrying `invitation_id`, and redirects to Auth0 with `prompt=login`. Shares the existing 500-live-transaction cap |
| `GET /auth/callback` | Existing validation, then a branch when the transaction carries an invitation. See the next section |

Dashboard work (an Invitations view under the account module) is separate UI work on the same service.

### Acceptance and linking

The callback verifies the ID token exactly as today and obtains the issuer and subject. For an invitation transaction it then runs one D1 batch of guarded statements, in this order.

1. Insert the identity for the invitation's account only when the invitation is pending and unexpired, the account is active, human, has no identity and still holds the invitation's role, the inviter is still active and still holds authority for that role, the provider matches, the subject equals `expected_subject`, and no identity with that provider and subject exists.
2. Mark the invitation accepted only when the identity from step 1 now exists for it.
3. Insert the `audit_events` row `invitation.accept` only when step 2 took effect. The actor is the newly linked account, and the details hold the invitation and identity IDs and the provider, never the subject.
4. Create the session with the existing guarded insert.

If step 1 inserts nothing, nothing else is written except the refusal record, and the caller gets `403` with a single generic page. Every guard sits inside the statements, as in the sign-in and bootstrap code, so a concurrent cancel, disable or revoke cannot be overtaken.

### Failure cases

| Case | Result |
| --- | --- |
| Verified subject differs from `expected_subject` | Refused. The invitation stays pending and unconsumed so the real invitee can still accept. `last_refusal` is `subject_mismatch` and the count rises |
| Subject already linked to any account | Refused by the existence guard and by `UNIQUE (provider, subject)`. Invitation stays pending. If the subject is the invitee's own existing account, the page says to sign in normally |
| Repeated acceptance with the same token | The first success sets `accepted`. Later attempts find no pending row and are refused. The person signs in through `/auth/login` as usual |
| Concurrent acceptance by two browsers | D1 runs each batch as one transaction. The loser sees the invitation accepted or the subject linked and inserts nothing. The unique index on `identity_id` and the one-pending-per-account index back this up. A replay of one callback is already stopped by the single-use login transaction |
| Target account disabled before acceptance | Refused by the active-account guard |
| Invitation cancelled | Status is no longer pending, and the account is disabled. Refused |
| Invitation expired | Refused by the clock comparison. An owner or administrator issues a new one |
| Inviter disabled or demoted after issuing | Refused by the inviter-authority guard (Proposed, choice 5) |
| Role changed on the account after issue | Refused by the role-match guard, so a role cannot be swapped under an outstanding link |
| Token leaked | Useless without the matching GitHub identity when `expected_subject` is required. Short expiry and one use bound the rest |
| Sign-in disabled or issuer changed | Invitations cannot be accepted because the flow needs the Auth0 settings. Pending invitations are not touched. An issuer change makes the provider guard fail, so they must be reissued |

### Expiry, cancellation and access removal

Default expiry is 72 hours and the maximum is 14 days (Proposed, choice 3). Cancellation is immediate and final. Removing access after acceptance uses the existing controls unchanged: revoke the identity or disable the account, and the next request fails. The owner floor still applies. Because revocation is final, a removed person's subject cannot be linked again, including through a new invitation, until a later owner-approved reinstatement exists (choice 7).

### Audit record

All inviter-side events use `audit_events` through `runAuditedMutation` with a real actor: `invitation.create` (role, expected provider, expiry, never the token or subject), `invitation.cancel`, and the existing `account.create`-style details for the inert account. Acceptance is `invitation.accept` with the new account as actor. Refusals go to `invitation_events` or the counters. Nothing logs a token, subject, URL, cookie or secret, matching the existing logging rule.

### Public registration stays closed

No new unauthenticated route creates an account or a link. `/auth/invite/*` can only link to an account that an authorized principal already created, only for a holder of an unexpired token, and only for the expected subject. An unlinked sign-in still gets `403`. The header still says sign-in works only for an existing account.

### Effects to note

Writes to `accounts` and `identities` fire the M2 dependency-generation triggers, so an invitation or acceptance during a sync run invalidates guarded administrative writes, as any account change does today. `invitation_events` and the invitations table should stay outside those triggers like sessions.

## Implementation test plan

Local tests with synthetic identities and a disposable D1, in the style of `tests/auth-signin.test.mjs` and the Sites D1 check.

1. Authority matrix: owner invites editor and administrator, administrator invites editor only, administrator refused for administrator, editor and agent refused for both, nobody can issue an owner invitation, unknown JSON fields and bad origin refused.
2. Issue: account, invitation and audit row appear atomically, the token is returned once, only its hash is stored, and the list never exposes either.
3. Acceptance happy path: identity linked to the invited account, invitation accepted, audit row with the new account as actor, session created, dashboard modules match the role.
4. Mismatch: wrong subject refused, invitation still pending, the right subject can then accept, refusal recorded.
5. Already-linked subject, same account and different account: refused, nothing written.
6. Concurrency: two simultaneous acceptances with one token and two subjects produce exactly one link. Two callbacks of one transaction produce one session.
7. Replay after success, after cancel, after expiry (fake clock), and with an unknown token: identical generic response.
8. Disabled target account, disabled or demoted inviter, role changed after issue, issuer changed: all refused.
9. Cancel: account disabled, later acceptance refused, administrator cannot cancel an administrator invitation.
10. Removal: revoke the invitee's identity and disable the account, each denying the next request. Last-owner floor still holds. A new invitation for the revoked subject is refused.
11. Closed registration: an unlinked sign-in still returns `403` with no rows written, and no anonymous route creates an account.
12. Hygiene: token, subject and cookie values absent from audit rows, logs and responses other than the one issue response. Existing capability, bootstrap and sign-in suites unchanged and passing.
13. Hosted (separate, later): on Cloudflare staging, one real invitation accepted by a second GitHub identity, one mismatch refusal and one expiry, with the temporary invitee removed afterward. This also supplies the unlinked-account hosted evidence still owed.

## Owner decisions needed

Each default below is the recommendation, and none is accepted until the owner says so.

1. **Bind to a named identity.** Require the inviter to supply the invitee's exact Auth0 subject (recommended), make it optional (token alone then grants the link), or use another binding. A GitHub numeric ID mapped to `github|<id>` is plausible but unverified on this tenant, so the first hosted test must confirm the subject format.
2. **Who invites whom.** The authority table above, or owner-only invitations for both roles.
3. **Expiry.** 72 hours default and 14 days maximum, or other bounds.
4. **Delivery.** The inviter copies the link and sends it privately (recommended, no email service and $0 cost), or add an email provider later.
5. **Inviter authority at acceptance.** Void outstanding invitations if the inviter is disabled or demoted (recommended), or let them stand.
6. **Administrator powers over other administrators.** The current matrix lets an administrator disable another administrator or the owner's account (but not the last owner) and revoke any identity. Keep that, or restrict those actions to the owner. This is existing behavior and is outside AUTH-5, but invitations make administrators more numerous.
7. **Returning people.** Revocation is final and blocks relinking the same subject. Accept that for now (recommended), or schedule an owner-only reinstatement.
8. **Refusal records.** A small `invitation_events` table (recommended for attributable refusals) or counters on the invitation plus the existing log line.
9. **Second owner.** Confirm owners are never invited and a second owner comes only from an owner changing an administrator's role.
10. **Where it ships.** Cloudflare staging first, with the Sites deployment staying disabled, as the current hosting decision states.
