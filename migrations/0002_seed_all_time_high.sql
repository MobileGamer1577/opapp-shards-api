-- ═══════════════════════════════════════════════════════════════
--  0002_seed_all_time_high.sql – Historische Allzeithochs (Startwerte)
--
--  ✅ HIER ÄNDERN: Werte/Daten korrigieren, falls nötig (siehe Hinweis
--                  unten zu den zwei unsicheren Daten)
--  ❌ NICHT ÄNDERN: item_key-Schreibweise – muss exakt mit dem
--                   extrahierten Text aus der API übereinstimmen
--                   (Groß-/Kleinschreibung zählt!)
--
--  Die OPSUCHT-API liefert selbst keine Historie – diese Werte wurden
--  manuell vor Einführung dieses Trackings gesammelt. Ab jetzt pflegt
--  der Cron-Worker die Tabelle automatisch weiter (überschreibt einen
--  Wert nur, wenn ein neuer Kurs höher ist).
--
--  ⚠️ Bei "Diamant Block" und "Holzbündel" war das genaue Datum nicht
--  eindeutig (10.07.2026 ODER 11.07.2026 angegeben) – hier wurde das
--  spätere Datum (11.07.2026) verwendet. Falls falsch, einfach per
--  UPDATE auf all_time_high korrigieren.
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO items (item_key, material, is_active, first_seen_at, last_seen_at)
VALUES
  ('diamond_block',   'diamond_block',   1, CAST(strftime('%s', '2026-07-11') AS INTEGER) * 1000, CAST(strftime('%s', '2026-07-11') AS INTEGER) * 1000),
  ('netherite_ingot', 'netherite_ingot', 1, CAST(strftime('%s', '2026-06-15') AS INTEGER) * 1000, CAST(strftime('%s', '2026-06-15') AS INTEGER) * 1000),
  ('Gräbergemisch',   NULL,              1, CAST(strftime('%s', '2026-07-01') AS INTEGER) * 1000, CAST(strftime('%s', '2026-07-01') AS INTEGER) * 1000),
  ('Holzbündel',      NULL,              1, CAST(strftime('%s', '2026-07-11') AS INTEGER) * 1000, CAST(strftime('%s', '2026-07-11') AS INTEGER) * 1000),
  ('Steinplatten',    NULL,              1, CAST(strftime('%s', '2026-06-30') AS INTEGER) * 1000, CAST(strftime('%s', '2026-06-30') AS INTEGER) * 1000);

INSERT OR IGNORE INTO all_time_high (item_key, rate, base, achieved_at)
VALUES
  ('diamond_block',   13.6,  12, CAST(strftime('%s', '2026-07-11') AS INTEGER) * 1000),
  ('netherite_ingot', 67.7,  60, CAST(strftime('%s', '2026-06-15') AS INTEGER) * 1000),
  ('Gräbergemisch',   22.18, 16, CAST(strftime('%s', '2026-07-01') AS INTEGER) * 1000),
  ('Holzbündel',      22.77, 21, CAST(strftime('%s', '2026-07-11') AS INTEGER) * 1000),
  ('Steinplatten',    17.07, 15, CAST(strftime('%s', '2026-06-30') AS INTEGER) * 1000);
