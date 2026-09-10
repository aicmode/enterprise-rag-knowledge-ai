-- =============================================================================
-- Enterprise RAG Knowledge AI - 0003: public-demo abuse protection
-- =============================================================================
-- Why this exists
-- ---------------
-- Until now every demo quota was counted from rows that the visitor's own
-- session owns (`documents.session_id`, `questions.session_id`). That is fine
-- as data isolation, but it is worthless as a cost control on a public URL:
-- deleting the `rag_demo_session` cookie -- or pressing "reset" -- mints a new
-- UUID, and with it a brand-new, empty quota. Every OpenAI call the demo makes
-- is paid for by the owner, so a limit that resets on demand is not a limit.
--
-- This table adds a second, *session-independent* dimension: a per-client
-- counter that a new cookie does not touch.
--
-- Privacy
-- -------
-- `client_key` is NOT an IP address and no column here holds one. It is
-- HMAC-SHA256(server secret, normalised client IP), truncated -- see
-- `src/lib/security/client-key.ts`. Without `DEMO_RATE_LIMIT_SECRET` the value
-- cannot be reversed or brute-forced back to an address (a plain SHA-256 of an
-- IP would be enumerable: the whole IPv4 space is only 2^32 hashes).
--
-- Growth
-- ------
-- Rows are fixed-window counters, so one client produces at most one row per
-- bucket per window rather than one row per request. `expires_at` gives every
-- row a TTL; `pruneExpiredRateLimits()` and `npm run db:cleanup` delete them.
-- =============================================================================

create table if not exists demo_rate_limits (
  -- Irreversible per-client fingerprint. Never a raw or truncated IP.
  client_key     text        not null check (char_length(client_key) between 8 and 128),
  -- Which quota this row counts ('ask', 'ocr_page', ...). See DEMO_LIMITS.
  bucket         text        not null check (char_length(bucket) between 1 and 64),
  -- Start of the fixed window, floored to the window length by the caller.
  window_start   timestamptz not null,
  -- Units consumed in this window. "Units" are bucket-specific: requests for
  -- `ask`, pages for `ocr_page`, bytes for `upload_bytes`.
  used           bigint      not null check (used >= 0),
  -- TTL. A row past this point is dead weight and safe to delete.
  expires_at     timestamptz not null,
  primary key (client_key, bucket, window_start)
);

-- Retention sweep: `delete from demo_rate_limits where expires_at < now()`.
create index if not exists demo_rate_limits_expires_at_idx
  on demo_rate_limits (expires_at);

comment on table demo_rate_limits is
  'Fixed-window abuse counters for the public demo, keyed by an HMAC fingerprint of the client IP. Survives demo-session reset by design. Contains no IP addresses.';
