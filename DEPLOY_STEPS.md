# Deployment – OPAPP Shards-API (Cloudflare Worker + D1)

Diese Mini-API läuft komplett unabhängig von der Flutter-App, im
gleichen (kostenlosen) Cloudflare-Account wie `opapp.pages.dev`. Sie
ist die EINZIGE Instanz, die in die Datenbank schreibt – die App
liest später nur lesend über zwei GET-Endpunkte.

## Voraussetzungen
- Node.js (habt ihr bereits, da Wrangler schon für Pages genutzt wird)
- Euer bestehender Cloudflare-Account

## 1. Projektordner anlegen

```powershell
mkdir opapp-shards-api
cd opapp-shards-api
```

Die Dateien aus diesem Update hier reinlegen (Struktur beibehalten):

```
opapp-shards-api/
├── src/
│   └── worker.js
├── migrations/
│   ├── 0001_init.sql
│   └── 0002_seed_all_time_high.sql
├── wrangler.toml
├── package.json
└── .gitignore
```

Dann:

```powershell
npm install
```

## 2. Bei Cloudflare einloggen (falls in diesem Ordner noch nicht geschehen)

```powershell
npx wrangler login
```

## 3. D1-Datenbank erstellen

```powershell
npx wrangler d1 create opapp-shards
```

Die Ausgabe enthält einen Block mit `database_id = "..."`. Diesen Wert
in `wrangler.toml` bei `database_id` eintragen (dort steht aktuell ein
Platzhalter).

## 4. Schema + Seed-Daten einspielen

```powershell
npm run db:init
npm run db:seed
```

(Das entspricht `wrangler d1 execute opapp-shards --remote --file=...`
für die beiden Migrations-Dateien.)

## 5. Deployen

```powershell
npm run deploy
```

Die Ausgabe zeigt eine URL wie
`https://opapp-shards-api.<dein-subdomain>.workers.dev`.

**Diese URL bitte an mich schicken** – damit baue ich im nächsten
Schritt die Flutter-Seite an (neuer `ApiConstants`-Eintrag, Model +
Repository fürs Allzeithoch, Detail-Sheet im OPShards-Screen mit Tap
auf ein Item, siehe Bild 2 aus dem letzten Update).

## 6. Testen

```powershell
curl https://opapp-shards-api.<dein-subdomain>.workers.dev/shards/ath
```

Sollte die 5 Seed-Werte zurückgeben (Diamant Block, Netherite Barren,
Gräbergemisch, Holzbündel, Steinplatten). Der Cron-Job läuft ab jetzt
automatisch alle 15 Minuten im Hintergrund – sobald ein Item einen
neuen Rekord erreicht, aktualisiert sich `/shards/ath` von allein,
ganz ohne weiteres Zutun.

Zum Debuggen zwischendurch:

```powershell
curl https://opapp-shards-api.<dein-subdomain>.workers.dev/shards/items
```

zeigt alle bekannten Items inkl. `is_active`-Status.

## 7. GitHub-Sync

Wie beim Rest des Projekts: Ordner in ein Repo pushen (neues Repo
`opapp-shards-api` empfohlen, damit es unabhängig vom Flutter-Build
deploybar bleibt). Einen GitHub-Actions-Workflow für automatisches
Redeploy bei Push (im gleichen Stil wie euer `deploy-web.yml`) kann
ich bei Bedarf ergänzen.
