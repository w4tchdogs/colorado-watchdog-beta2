import type { AsyncD1Database } from "../database/d1.js";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  TRANSACTION_MS,
} from "./http.js";

type Row = Record<string, unknown>;

/** Live (unconsumed, unexpired) sign-in transactions allowed at once. */
export const MAX_LIVE_TRANSACTIONS = 500;
/** Stale rows removed by one request, so cleanup cost stays bounded. */
export const PURGE_BATCH = 100;
/** Expired sessions are kept this long, then purged. */
export const EXPIRED_SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Idle expiry is extended only when at least this much has elapsed. */
const IDLE_REFRESH_AFTER_MS = 5 * 60_000;

const iso = (date: Date) => date.toISOString();

export interface NewTransaction {
  readonly stateHash: string;
  readonly browserHash: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnPath: string;
}

export interface ConsumedTransaction {
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnPath: string;
}

/**
 * Purges a bounded number of stale rows, then stores the transaction only
 * while fewer than MAX_LIVE_TRANSACTIONS are live. Returns false when the cap
 * is reached. The purge and guarded insert run in one atomic batch.
 */
export async function createLoginTransaction(
  database: AsyncD1Database,
  transaction: NewTransaction,
  now: Date,
): Promise<boolean> {
  const current = iso(now);
  await database.batch([
    database.prepare(
      `DELETE FROM auth_login_transactions WHERE rowid IN (
         SELECT rowid FROM auth_login_transactions
         WHERE expires_at <= ? OR consumed_at IS NOT NULL LIMIT ?)`,
      [current, PURGE_BATCH],
    ),
    database.prepare(
      `DELETE FROM auth_sessions WHERE rowid IN (
         SELECT rowid FROM auth_sessions WHERE absolute_expires_at <= ? LIMIT ?)`,
      [
        iso(new Date(now.getTime() - EXPIRED_SESSION_RETENTION_MS)),
        PURGE_BATCH,
      ],
    ),
    database.prepare(
      `INSERT INTO auth_login_transactions
         (state_hash, browser_hash, nonce, code_verifier, return_path, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM auth_login_transactions
              WHERE consumed_at IS NULL AND expires_at > ?) < ?`,
      [
        transaction.stateHash,
        transaction.browserHash,
        transaction.nonce,
        transaction.codeVerifier,
        transaction.returnPath,
        current,
        iso(new Date(now.getTime() + TRANSACTION_MS)),
        current,
        MAX_LIVE_TRANSACTIONS,
      ],
    ),
  ]);
  const stored = await database.first<Row>(
    "SELECT 1 AS stored FROM auth_login_transactions WHERE state_hash = ?",
    [transaction.stateHash],
  );
  return stored !== null;
}

/**
 * Atomically marks the transaction consumed and returns its secrets. Of any
 * number of concurrent callbacks for one state, at most one gets a row.
 */
export async function consumeLoginTransaction(
  database: AsyncD1Database,
  stateHash: string,
  browserHash: string,
  now: Date,
): Promise<ConsumedTransaction | null> {
  const row = await database.first<Row>(
    `UPDATE auth_login_transactions SET consumed_at = ?
     WHERE state_hash = ? AND browser_hash = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING nonce, code_verifier, return_path`,
    [iso(now), stateHash, browserHash, iso(now)],
  );
  if (
    !row ||
    typeof row.nonce !== "string" ||
    typeof row.code_verifier !== "string" ||
    typeof row.return_path !== "string"
  )
    return null;
  return {
    nonce: row.nonce,
    codeVerifier: row.code_verifier,
    returnPath: row.return_path,
  };
}

/**
 * Creates a session only when the exact provider and subject resolve to an
 * unrevoked, unexpired human identity of an active human account. The checks
 * live in the INSERT itself, so a concurrent revoke or disable cannot be
 * overtaken. Returns false when no eligible link exists, and then creates no
 * account, identity or session.
 */
export async function createSession(
  database: AsyncD1Database,
  session: {
    readonly id: string;
    readonly tokenHash: string;
    readonly provider: string;
    readonly subject: string;
  },
  now: Date,
): Promise<boolean> {
  const current = iso(now);
  await database.run(
    `INSERT INTO auth_sessions
       (id, token_hash, account_id, identity_id, provider, subject, created_at, idle_expires_at, absolute_expires_at)
     SELECT ?, ?, a.id, i.id, i.provider, i.subject, ?, ?, ?
     FROM identities i JOIN accounts a ON a.id = i.account_id
     WHERE i.provider = ? AND i.subject = ? AND i.credential_hash IS NULL
       AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > ?)
       AND a.status = 'active' AND a.kind = 'human'`,
    [
      session.id,
      session.tokenHash,
      current,
      iso(new Date(now.getTime() + SESSION_IDLE_MS)),
      iso(new Date(now.getTime() + SESSION_ABSOLUTE_MS)),
      session.provider,
      session.subject,
      current,
    ],
  );
  const stored = await database.first<Row>(
    "SELECT 1 AS stored FROM auth_sessions WHERE token_hash = ?",
    [session.tokenHash],
  );
  return stored !== null;
}

export interface LiveSession {
  readonly id: string;
  readonly provider: string;
  readonly subject: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

/**
 * The live session for a presented cookie hash, rechecked against the current
 * identity and account on every call. It requires that the session still
 * names its own identity and subject, so a re-pointed link or a changed
 * provider cannot substitute another principal.
 */
export async function findLiveSession(
  database: AsyncD1Database,
  tokenHash: string,
  provider: string,
  now: Date,
): Promise<LiveSession | null> {
  const current = iso(now);
  const row = await database.first<Row>(
    `SELECT s.id, s.provider, s.subject, s.idle_expires_at, s.absolute_expires_at
     FROM auth_sessions s
     JOIN identities i ON i.id = s.identity_id
     JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = ? AND s.provider = ? AND s.revoked_at IS NULL
       AND s.idle_expires_at > ? AND s.absolute_expires_at > ?
       AND i.account_id = s.account_id AND i.provider = s.provider
       AND i.subject = s.subject AND i.credential_hash IS NULL
       AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > ?)
       AND a.status = 'active' AND a.kind = 'human'`,
    [tokenHash, provider, current, current, current],
  );
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.provider !== "string" ||
    typeof row.subject !== "string" ||
    typeof row.idle_expires_at !== "string" ||
    typeof row.absolute_expires_at !== "string"
  )
    return null;
  return {
    id: row.id,
    provider: row.provider,
    subject: row.subject,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
  };
}

/**
 * Extends idle expiry, never beyond the absolute limit, and only when enough
 * time has passed to avoid a write on every request. Failure is ignored: the
 * session was just validated and an unextended session simply lapses sooner.
 */
export async function refreshIdleExpiry(
  database: AsyncD1Database,
  session: LiveSession,
  now: Date,
): Promise<void> {
  const target = Math.min(
    now.getTime() + SESSION_IDLE_MS,
    Date.parse(session.absoluteExpiresAt),
  );
  const current = Date.parse(session.idleExpiresAt);
  if (!(target - current >= IDLE_REFRESH_AFTER_MS)) return;
  try {
    await database.run(
      `UPDATE auth_sessions SET idle_expires_at = ?
       WHERE id = ? AND revoked_at IS NULL AND idle_expires_at < ?`,
      [iso(new Date(target)), session.id, iso(new Date(target))],
    );
  } catch {
    // Best effort only.
  }
}

/** Revokes the sessions behind the presented cookie hashes. Idempotent. */
export async function revokeSessions(
  database: AsyncD1Database,
  tokenHashes: readonly string[],
  now: Date,
): Promise<void> {
  if (tokenHashes.length === 0) return;
  await database.batch(
    tokenHashes.map((tokenHash) =>
      database.prepare(
        "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        [iso(now), tokenHash],
      ),
    ),
  );
}
