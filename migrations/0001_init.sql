-- ═══════════════════════════════════════════════════════════════
--  0001_init.sql – Grundschema für die OPAPP Shards-API
--
--  ✅ HIER ÄNDERN: bei Bedarf weitere Spalten ergänzen
--  ❌ NICHT ÄNDERN: item_key ist der stabile Schlüssel, der auch im
--                   Worker (extractItemKey) und später in der App
--                   verwendet wird – muss überall identisch sein.
-- ═══════════════════════════════════════════════════════════════

-- Bekannte Items – wird vom Cron-Worker automatisch befüllt/erweitert,
-- sobald ein neues Item in der OPSUCHT-API auftaucht. is_active=0
-- bedeutet "aktuell nicht mehr im Umlauf" (temporäres Item), NICHT
-- gelöscht – so bleiben Historie & Allzeithoch erhalten.
CREATE TABLE IF NOT EXISTS items (
  item_key      TEXT PRIMARY KEY,
  material      TEXT,                       -- rohe Material-ID, NULL bei Custom-Items
  is_active     INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,            -- Unix-Millisekunden
  last_seen_at  INTEGER NOT NULL
);

-- Ein Datenpunkt pro Item und Cron-Lauf – Basis für den künftigen
-- Kursverlauf-Graphen. Wird nach RETENTION_DAYS (siehe worker.js)
-- automatisch aufgeräumt.
CREATE TABLE IF NOT EXISTS rate_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key   TEXT NOT NULL,
  rate       REAL NOT NULL,
  base       REAL NOT NULL,
  fetched_at INTEGER NOT NULL,
  FOREIGN KEY (item_key) REFERENCES items(item_key)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item_time
  ON rate_snapshots (item_key, fetched_at);

-- Aktueller Rekord-Kurs je Item (wird NUR überschrieben, wenn ein
-- neuer Kurs höher ist als der bisherige – siehe worker.js).
CREATE TABLE IF NOT EXISTS all_time_high (
  item_key    TEXT PRIMARY KEY,
  rate        REAL NOT NULL,
  base        REAL NOT NULL,
  achieved_at INTEGER NOT NULL,
  FOREIGN KEY (item_key) REFERENCES items(item_key)
);
