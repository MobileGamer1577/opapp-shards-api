-- ═══════════════════════════════════════════════════════════════
--  0004_daily_peak.sql – Tages-Peak (höchste Online-Spielerzahl
--  pro Kalendertag, Europe/Berlin)
--
--  ✅ HIER ÄNDERN: bei Bedarf weitere Spalten ergänzen
--  ❌ NICHT ÄNDERN: date ist Primary Key im Format "YYYY-MM-DD"
--                   (Europe/Berlin-Kalendertag, siehe berlinDateString()
--                   in worker.js) – bewusst NICHT UTC.
--
--  Analog zu player_count_peak (0003), nur mit einer Zeile PRO TAG
--  statt einer einzigen globalen Zeile. Wird von updateDailyPeak()
--  in worker.js im selben 1-Minuten-Cron-Tick gepflegt wie der
--  All-Time-Rekord und der Health-Check (siehe scheduled() in
--  worker.js) – Schreibzugriff nur, wenn der heutige Wert neu
--  überboten wird (SELECT-then-compare-Pattern, kein WHERE-
--  Conditional-Upsert – siehe Kommentar in updateDailyPeak()).
--
--  ⚠️ DEPLOY-REIHENFOLGE: Diese Migration MUSS vor dem nächsten
--  "npx wrangler deploy" remote ausgeführt werden (z.B. per
--  "npm run db:migrate-daily-peak") – sonst schlägt updateDailyPeak()
--  im Cron mit einem SQL-Fehler fehl (wird nur geloggt, kein harter
--  Crash, aber der Tages-Peak bliebe bis zur Migration leer).
--
--  Kein Retention-Cleanup nötig: Es entsteht max. 1 Zeile pro Tag
--  (~365/Jahr), das ist über Jahre hinweg vernachlässigbar klein.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS daily_peak (
  date         TEXT PRIMARY KEY,   -- Kalendertag, Europe/Berlin, "YYYY-MM-DD"
  player_count INTEGER NOT NULL,
  achieved_at  INTEGER NOT NULL    -- Unix-Millisekunden (UTC, wie überall sonst)
);
