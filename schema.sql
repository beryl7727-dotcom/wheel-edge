-- ============================================================
-- Wheel Edge Dashboard — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Enable UUID extension (optional, we use integer IDs)
-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Positions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
  id                  INTEGER      PRIMARY KEY,
  symbol              TEXT         NOT NULL,
  category            TEXT,                        -- Cash | Short Put | Long Shares | Covered Call
  status              TEXT         DEFAULT 'OPEN', -- OPEN | CLOSED
  campaign_id         TEXT,
  entry_date          TEXT,
  contracts           INTEGER      DEFAULT 1,
  strike              NUMERIC,
  expiry              TEXT,
  dte                 INTEGER,
  premium             NUMERIC,
  current_value       NUMERIC,
  share_count         INTEGER,
  purchase_price      NUMERIC,
  current_share_price NUMERIC,
  capital_amount      NUMERIC,
  target_price        NUMERIC,
  intent              TEXT,
  thesis              TEXT,
  notes               TEXT,
  imported_from       TEXT,
  import_date         TEXT,
  closed_data         JSONB,
  journal_entry_ids   JSONB        DEFAULT '[]',
  status_history      JSONB        DEFAULT '[]',
  scenario_applied    JSONB,
  extra               JSONB,
  created_at          TIMESTAMPTZ  DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_positions_symbol   ON positions(symbol);
CREATE INDEX IF NOT EXISTS idx_positions_status   ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_campaign ON positions(campaign_id);

-- ── Campaigns ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT         PRIMARY KEY,
  symbol       TEXT         NOT NULL,
  name         TEXT         NOT NULL,
  created_date TEXT,
  status       TEXT         DEFAULT 'ACTIVE',
  notes        TEXT,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_symbol ON campaigns(symbol);

-- ── Journal Entries ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_entries (
  id             BIGINT       PRIMARY KEY,
  date           TEXT,
  symbol         TEXT,
  position_id    INTEGER      REFERENCES positions(id) ON DELETE SET NULL,
  trade          TEXT,
  result         TEXT,
  tags           JSONB        DEFAULT '[]',
  edited         BOOLEAN      DEFAULT FALSE,
  trade_thesis   JSONB,
  simulator_rec  JSONB,
  my_decision    JSONB,
  outcome        JSONB,
  edit_history   JSONB        DEFAULT '[]',
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journal_symbol   ON journal_entries(symbol);
CREATE INDEX IF NOT EXISTS idx_journal_position ON journal_entries(position_id);

-- ── Calendar Events ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_events (
  id          INTEGER      PRIMARY KEY,
  title       TEXT         NOT NULL,
  date        TEXT         NOT NULL,
  time        TEXT,
  category    TEXT,
  symbol      TEXT,
  icon_emoji  TEXT,
  notes       TEXT,
  description TEXT,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_date     ON calendar_events(date);
CREATE INDEX IF NOT EXISTS idx_calendar_category ON calendar_events(category);

-- ── Watchlist ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlist (
  id           INTEGER      PRIMARY KEY,
  symbol       TEXT         NOT NULL,
  price        NUMERIC,
  trend        TEXT,
  support      NUMERIC,
  resistance   NUMERIC,
  bias         TEXT,
  notes        TEXT,
  last_updated TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watchlist_symbol ON watchlist(symbol);

-- ── Recommendations / Snapshots ──────────────────────────────
CREATE TABLE IF NOT EXISTS recommendations (
  id             BIGINT       PRIMARY KEY,
  position_id    INTEGER      REFERENCES positions(id) ON DELETE SET NULL,
  symbol         TEXT,
  snapshot_date  TIMESTAMPTZ,
  price          NUMERIC,
  option_value   NUMERIC,
  iv             NUMERIC,
  days_to_expiry INTEGER,
  recommendation TEXT,
  notes          TEXT,
  bid_ask        JSONB,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rec_position ON recommendations(position_id);
CREATE INDEX IF NOT EXISTS idx_rec_symbol   ON recommendations(symbol);

-- ── Executions (immutable trade ledger) ─────────────────────
-- Every Sell to Open/Buy to Close/Assignment/Roll/etc. action becomes one
-- permanent row here. No updated_at, no trigger — rows are only ever
-- inserted, never updated, mirroring src/services/executions.js which
-- exposes no update/delete functions for this table.
CREATE TABLE IF NOT EXISTS executions (
  id                  INTEGER      PRIMARY KEY,
  position_id         INTEGER      REFERENCES positions(id) ON DELETE CASCADE,
  campaign_id         TEXT,
  symbol              TEXT         NOT NULL,
  action              TEXT         NOT NULL,
  date                TEXT,
  quantity            NUMERIC,
  execution_price     NUMERIC,
  net_credit_debit    NUMERIC,
  commission          NUMERIC      DEFAULT 0,
  exchange_fees       NUMERIC      DEFAULT 0,
  gst                 NUMERIC      DEFAULT 0,
  notes               TEXT,
  linked_position_id  INTEGER      REFERENCES positions(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_executions_position ON executions(position_id);
CREATE INDEX IF NOT EXISTS idx_executions_campaign ON executions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_executions_action   ON executions(action);
CREATE INDEX IF NOT EXISTS idx_executions_date     ON executions(date);

-- ── Migration: add updated_at to tables that predate this column ─────────
-- CREATE TABLE IF NOT EXISTS above won't retroactively add a column to an
-- already-existing table in a live Supabase project, so these ALTER lines
-- are required even though the CREATE TABLE blocks now include the column
-- for fresh installs.
ALTER TABLE calendar_events  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE recommendations  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ── Auto-update updated_at trigger ──────────────────────────
-- Applied to all 6 tables so cloud-vs-local conflict detection (offline-first
-- refactor) has a reliable updated_at to compare on every table, not just 4.
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['positions','campaigns','journal_entries','watchlist','calendar_events','recommendations']
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I;
       CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION update_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;

-- ── Row Level Security (enable after testing) ────────────────
-- ALTER TABLE positions       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE campaigns       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE watchlist       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
