# Release Notes – OPAPP Shards-API (neues Projekt)

**Version:** Initial Release

## Zusammenfassung

Neues, eigenständiges Backend-Projekt: ein Cloudflare Worker mit Cron
Trigger + D1-Datenbank, der die OPShards-Wechselkurse selbstständig
alle 15 Minuten von `api.opsucht.net/merchant/rates` abruft und daraus
zwei Dinge dauerhaft speichert:

1. **Allzeithoch je Item** (Kurs, Basiswert, Datum) – wird nur
   überschrieben, wenn ein neuer Kurs höher ist als der bisherige
   Rekord.
2. **Kursverlauf-Snapshots** – ein Datenpunkt pro Item und Lauf, als
   Grundlage für einen späteren Graphen in der App (180 Tage
   Aufbewahrung, danach automatisch aufgeräumt).

Neue Items in der API werden automatisch erkannt und angelegt.
Verschwindet ein Item wieder (temporär), wird es nur als inaktiv
markiert statt gelöscht – Historie & Rekord bleiben erhalten, falls es
zurückkehrt.

Die App selbst schreibt nichts – nur der Worker schreibt (per Cron),
die App liest ausschließlich über zwei GET-Endpunkte. Kein Auth für
Schreibzugriffe nötig, da Clients grundsätzlich keinen Schreibzugriff
haben.

## Endpunkte

- `GET /shards/ath` → aktuelle Allzeithochs aller Items
- `GET /shards/history/{itemKey}?days=30` → Kursverlauf (für künftigen Graph)
- `GET /shards/items` → bekannte Items + Status (Debug)

## Dateien

| Datei | Zweck |
|---|---|
| `src/worker.js` | Cron-Polling, D1-Schreiblogik, Read-Only-HTTP-Endpunkte |
| `migrations/0001_init.sql` | Grundschema (`items`, `rate_snapshots`, `all_time_high`) |
| `migrations/0002_seed_all_time_high.sql` | Manuell gesammelte historische Allzeithochs als Startwerte |
| `wrangler.toml` | Worker-Konfiguration, D1-Binding, Cron Trigger (alle 15 Min.) |
| `package.json` | Wrangler-Dependency + Hilfs-Skripte (`db:init`, `db:seed`, `db:ath`) |
| `DEPLOY_STEPS.md` | Schritt-für-Schritt-Anleitung zum Deployen |

## Kosten

Läuft vollständig im Cloudflare Free-Plan (Workers: 100.000
Requests/Tag, D1: 5 Mio. Zeilen lesen/Tag, 100.000 Zeilen
schreiben/Tag, 5 GB Speicher, Cron Triggers kostenlos inklusive) –
für diesen Anwendungsfall bei Weitem ausreichend.

## Nächster Schritt (noch offen)

Sobald deployed: Flutter-Integration (`ApiConstants`-Eintrag, Model +
Repository fürs Allzeithoch, Detail-Sheet im OPShards-Screen mit Tap
auf ein Item).
