// قاعدة بيانات SQLite (مدمجة في Node 22+) — نفس مخطط Mandoob+ الأصلي:
// users / companies / agents / tasks / payments / agentLocations (+ سجل مسار للتتبع).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      passwordHash  TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('company','agent')),
      createdAt     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      lastSignedIn  TEXT
    );

    CREATE TABLE IF NOT EXISTS companies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      userId      INTEGER NOT NULL UNIQUE REFERENCES users(id),
      name        TEXT NOT NULL,
      contactName TEXT NOT NULL,
      phone       TEXT NOT NULL,
      city        TEXT NOT NULL DEFAULT 'الرياض',
      createdAt   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      userId      INTEGER NOT NULL UNIQUE REFERENCES users(id),
      name        TEXT NOT NULL,
      phone       TEXT NOT NULL,
      city        TEXT NOT NULL DEFAULT 'الرياض',
      rating      INTEGER NOT NULL DEFAULT 50,   -- 50 = 5.0
      isAvailable INTEGER NOT NULL DEFAULT 1,
      createdAt   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      companyId    INTEGER NOT NULL REFERENCES companies(id),
      agentId      INTEGER REFERENCES agents(id),
      title        TEXT NOT NULL,
      type         TEXT NOT NULL,
      location     TEXT NOT NULL,
      notes        TEXT,
      priceHalalas INTEGER NOT NULL,
      scheduledAt  TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','in_progress','completed')),
      createdAt    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updatedAt    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      acceptedAt   TEXT,
      startedAt    TEXT,
      completedAt  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(companyId);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent   ON tasks(agentId);
    CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);

    -- payment_method: cash_on_delivery فعّال حاليًا، و moyasar محجوز للمستقبل (غير مفعّل).
    CREATE TABLE IF NOT EXISTS payments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId              INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
      grossHalalas        INTEGER NOT NULL,
      platformFeeHalalas  INTEGER NOT NULL,
      agentPayoutHalalas  INTEGER NOT NULL,
      currency            TEXT NOT NULL DEFAULT 'sar',
      paymentMethod       TEXT NOT NULL DEFAULT 'cash_on_delivery' CHECK (paymentMethod IN ('cash_on_delivery','moyasar')),
      status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','paid','failed')),
      cashCollectedAt     TEXT,
      paidAt              TEXT,
      createdAt           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updatedAt           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- آخر موقع للمندوب لكل مهمة
    CREATE TABLE IF NOT EXISTS agentLocations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId         INTEGER NOT NULL UNIQUE REFERENCES tasks(id),
      agentId        INTEGER NOT NULL REFERENCES agents(id),
      latitudeE6     INTEGER NOT NULL,
      longitudeE6    INTEGER NOT NULL,
      accuracyMeters INTEGER NOT NULL DEFAULT 0,
      updatedAt      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- مسار المندوب (لرسم الطريق على الخريطة)
    CREATE TABLE IF NOT EXISTS agentLocationTrail (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId      INTEGER NOT NULL REFERENCES tasks(id),
      latitudeE6  INTEGER NOT NULL,
      longitudeE6 INTEGER NOT NULL,
      createdAt   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trail_task ON agentLocationTrail(taskId, id);
  `);
  return db;
}

/** تنفيذ دالة داخل معاملة ذرّية. */
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
}
