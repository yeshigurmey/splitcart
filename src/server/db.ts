/**
 * The database: one SQLite file, opened with better-sqlite3.
 *
 * SQLite keeps the whole database in a single file and needs no separate
 * server, which suits an app this size. Every amount is stored as an INTEGER
 * number of cents, and CHECK constraints stop bad values at the last line of
 * defence even if a bug upstream lets one through.
 */

import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buildings (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- Short code neighbours type in to join the building.
  code        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  building_id    TEXT NOT NULL REFERENCES buildings(id),
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

-- A login. Only a hash of the token is stored, so a leaked database
-- cannot be used to impersonate anyone.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT PRIMARY KEY,
  building_id         TEXT NOT NULL REFERENCES buildings(id),
  host_id             TEXT NOT NULL REFERENCES users(id),
  store               TEXT NOT NULL,
  delivery_slot       TEXT NOT NULL,
  cutoff_at           INTEGER NOT NULL,
  delivery_fee_cents  INTEGER NOT NULL CHECK (delivery_fee_cents >= 0),
  split_mode          TEXT NOT NULL CHECK (split_mode IN ('even', 'by_size')),
  status              TEXT NOT NULL
                      CHECK (status IN ('open', 'locked', 'placed', 'delivered', 'cancelled')),
  -- Goes up by one each time the order is locked. Holds belong to one lock,
  -- so unlocking and locking again starts a fresh round of holds.
  lock_version        INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_by_building ON orders (building_id, created_at);

CREATE TABLE IF NOT EXISTS members (
  order_id   TEXT NOT NULL REFERENCES orders(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (order_id, user_id)
);

CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  price_cents  INTEGER NOT NULL CHECK (price_cents > 0),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_by_order ON items (order_id);

-- One member's money for one lock of one order.
CREATE TABLE IF NOT EXISTS payments (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id),
  user_id          TEXT NOT NULL REFERENCES users(id),
  lock_version     INTEGER NOT NULL,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  status           TEXT NOT NULL
                   CHECK (status IN ('pending', 'authorized', 'captured',
                                     'released', 'refunded', 'failed')),
  payment_method   TEXT NOT NULL,
  -- How many times this member has tried to pay in this lock. A retry after
  -- a decline needs a new idempotency key, and the attempt number provides it.
  attempt          INTEGER NOT NULL DEFAULT 1,
  -- The payment provider's id for the hold, once we have one.
  gateway_ref      TEXT,
  failure          TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  -- The database itself guarantees one payment per member per lock, so a
  -- double click or a retried request can never create a second hold.
  UNIQUE (order_id, user_id, lock_version)
);
`;

/** Open (and if needed create) the database. Pass ":memory:" for a throwaway one in tests. */
export function openDb(path: string): Db {
  const db = new Database(path);
  // Write-ahead logging lets readers keep reading while a write is in progress.
  db.pragma("journal_mode = WAL");
  // SQLite does not enforce REFERENCES unless asked to.
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
