-- Single-use claims for guest report challenge tokens (SUB-3).
-- Only a SHA-256 digest of the token is stored, never the token, the visitor's
-- address or any report content. The primary key makes the claim atomic across
-- concurrent Workers. Rows are transient and pruned after the token can no
-- longer be accepted.
CREATE TABLE report_challenge_claims (
  token_digest TEXT PRIMARY KEY CHECK (
    length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'
  ),
  claimed_at INTEGER NOT NULL CHECK (claimed_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > claimed_at)
) STRICT, WITHOUT ROWID;

CREATE INDEX report_challenge_claims_expiry
  ON report_challenge_claims (expires_at);
