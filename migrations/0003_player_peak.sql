-- ═══════════════════════════════════════════════════════════════
--  0003_player_peak.sql – Spieler-Rekord (höchste je gemessene
--  Online-Spielerzahl + Zeitpunkt)
--
--  ✅ HIER ÄNDERN: bei Bedarf weitere Spalten ergänzen
--  ❌ NICHT ÄNDERN: id ist per CHECK-Constraint bewusst auf 1 fixiert
--                   – es gibt (und soll) immer nur GENAU eine Zeile
--                   geben, analog zu all_time_high, nur ohne
--                   item_key (hier gibt's ja nur "ein Item": die
--                   Server-Spielerzahl).
--
--  Wird von pollPlayerPeak() in worker.js im selben 1-Minuten-Cron-
--  Tick gepflegt wie der Health-Check (siehe scheduled() in
--  worker.js) – Schreibzugriff nur, wenn ein neuer Rekord erreicht
--  wurde (SELECT-then-compare-Pattern, kein WHERE-Conditional-
--  Upsert – siehe Kommentar in pollPlayerPeak()).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS player_count_peak (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  player_count INTEGER NOT NULL,
  achieved_at  INTEGER NOT NULL            -- Unix-Millisekunden
);
