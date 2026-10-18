import { Pool } from "pg";
import { config } from "./config";
import { ensureDevicesTable } from "./services/deviceRegistry";
import { ensureVerifiedEmailsTable } from "./services/emailVerification";

export const pool = new Pool({ connectionString: config.DATABASE_URL });

export async function ensureAuditTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS keypair_audit_log (
      id BIGSERIAL PRIMARY KEY,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      api_key_hash VARCHAR(64) NOT NULL,
      public_key VARCHAR(56) NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source_public_key VARCHAR(56) NOT NULL,
      idempotency_key VARCHAR(255) NOT NULL,
      result_hash VARCHAR(64) NOT NULL,
      result_successful BOOLEAN NOT NULL,
      UNIQUE (source_public_key, idempotency_key)
    )
  `);

  // #87 — device token table for push notifications.
  await ensureDevicesTable(pool);

  // #90 — verified email table for email notification fallback.
  await ensureVerifiedEmailsTable(pool);

  // #77 — durable contract event index for wallet history.
  await ensureContractEventsTables();
}

/**
 * #77 — contract event indexer storage.
 *
 * `contract_events` holds normalised Soroban contract events keyed by the
 * RPC event id (unique, so re-ingesting the same event is a no-op).
 * `indexer_state` stores the polling cursor (last processed ledger) so the
 * worker resumes after a restart.
 */
export async function ensureContractEventsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contract_events (
      id TEXT PRIMARY KEY,
      ledger BIGINT NOT NULL,
      tx_hash VARCHAR(64) NOT NULL,
      type VARCHAR(32) NOT NULL,
      topics JSONB NOT NULL DEFAULT '[]'::jsonb,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contract_events_ledger_idx
      ON contract_events (ledger)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      name TEXT PRIMARY KEY,
      cursor_ledger BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
