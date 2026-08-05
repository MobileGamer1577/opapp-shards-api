# Monitoring & Alerting – opapp-shards-api

Eigenständiges Cloudflare-natives Monitoring (Cron Trigger + KV + Discord/ntfy),
ersetzt den früheren Uptime-Kuma-Ansatz. Kein externer Dienst mehr nötig.

## 1. Einmalige Einrichtung

**KV-Namespace anlegen:**

```bash
npx wrangler kv namespace create HEALTH_KV
```

Die zurückgegebene `id` in `wrangler.toml` bei `[[kv_namespaces]]` eintragen
(ersetzt `TODO_NACH_WRANGLER_KV_NAMESPACE_CREATE_EINTRAGEN`).

**Secrets setzen** (niemals in `wrangler.toml` – das Repo ist öffentlich):

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
# Discord: Server-Einstellungen → Integrationen → Webhooks → Neuer Webhook → URL kopieren

npx wrangler secret put NTFY_TOPIC
# Empfehlung: langer, zufälliger Name statt "opapp-alerts" – ntfy.sh-Topics sind
# standardmäßig öffentlich, jeder mit dem Namen kann mitlesen oder selbst posten.
# Zum Erzeugen z. B.: openssl rand -hex 16

npx wrangler secret put NTFY_SERVER
# Optional – nur setzen, falls ihr selbst-gehostetes ntfy nutzt. Ohne diesen
# Secret wird https://ntfy.sh verwendet.
```

**Deploy:**

```bash
npx wrangler deploy
```

Ab dem ersten Cron-Tick (max. 1 Minute nach Deploy) füllt sich `health:state`
in KV, danach zeigt `GET /health` den echten `externalApi`-Status statt `"unknown"`.

## 2. `/health`-Format

```json
{
  "service": "OPAPP Shards API",
  "status": "online",
  "httpStatus": 200,
  "responseTimeMs": 12,
  "version": "1.0.0",
  "maintenance": false,
  "timestamp": "2026-08-05T15:02:14.000Z",
  "uptimeSeconds": 86400,
  "checks": {
    "database": "ok",
    "cache": "ok",
    "externalApi": "ok"
  }
}
```

| Feld | Bedeutung |
|---|---|
| `status` | `online` / `offline` / `slow` / `maintenance` |
| `checks.database` | D1 – kritisch, löst bei `"error"` `offline` aus |
| `checks.cache` | HEALTH_KV – informativ, löst NICHT `offline` aus (nur das Monitoring selbst hängt daran, nicht die Daten-Endpunkte) |
| `checks.externalApi` | OPSUCHT-API – kritisch, löst bei `"error"` `offline` aus. Kommt aus dem 1-Minuten-Cron (max. ~60s alt), nicht live bei jedem Aufruf geprüft. Zeigt `"unknown"`, bis der erste Cron-Tick gelaufen ist |
| `uptimeSeconds` | Sekunden seit dem letzten Wechsel zu `online` (Workers haben keinen langlebigen Prozess – "Uptime" ist hier eine Ableitung aus dem gespeicherten Status, kein OS-Wert) |

**Status-Logik:**
- `maintenance` (Flag in KV gesetzt) überschreibt alles andere → HTTP 200
- `database` oder `externalApi` = `error` → `offline` → HTTP 503
- alle Checks ok, aber `responseTimeMs` > 800ms (`SLOW_THRESHOLD_MS` in `worker.js`) → `slow` → HTTP 200
- sonst → `online` → HTTP 200

## 3. Wartungsmodus umschalten

```bash
# Aktivieren
npx wrangler kv key put --binding=HEALTH_KV "health:maintenance" "true"

# Deaktivieren
npx wrangler kv key put --binding=HEALTH_KV "health:maintenance" "false"
```

Wirkt sofort, ohne Redeploy. Beim nächsten Cron-Tick (max. 1 Minute) geht außerdem
ein Discord/ntfy-Alert für den Wechsel zu bzw. aus `maintenance` raus.

## 4. Wie das Alerting funktiont

- Cron läuft jede Minute, prüft Datenbank + Cache + externe API.
- Ergebnis wird mit dem letzten in KV gespeicherten Status verglichen.
- **Nur bei tatsächlicher Änderung** (Status oder einzelner Check kippt) wird
  a) der neue Status in KV geschrieben und b) ein Discord-Embed + ein
  ntfy-Push gesendet. Bleibt alles gleich, passiert nichts – das ist Absicht,
  siehe Punkt 5.
- Discord-Farben: 🟢 Grün (online) · 🔴 Rot (offline) · 🟠 Orange (slow) ·
  🟡 Gelb (maintenance).
- ntfy-Tags: `white_check_mark` (online) · `rotating_light` (offline) ·
  `warning` (slow) · `construction` (maintenance), Priorität 3–5.

## 5. Bekannte Grenzen

- **KV-Schreiblimit (Free-Tier: 1.000 Writes/Tag):** Bei 1.440 Cron-Ticks/Tag
  würde ein Write pro Tick das Limit überschreiten. Deshalb wird nur bei
  Zustandsänderung geschrieben. Bei einer sehr instabilen Abhängigkeit (viele
  Wechsel an einem Tag) kann das Limit trotzdem erreicht werden – weitere
  Writes schlagen dann für den Rest des Tages fehl (sichtbar in
  `wrangler tail`), Alerts werden aber weiterhin versucht.
- `checks.externalApi` ist nie "live" im strengen Sinn, sondern maximal ~60s
  alt (siehe oben) – bewusste Entscheidung, damit `/health` selbst nicht von
  OPSUCHTs Antwortzeit abhängt.
- Es gibt nur einen Service (diesen Worker) – `/health` ist bereits der
  vollständige Status, kein separater globaler Aggregations-Endpunkt nötig.
