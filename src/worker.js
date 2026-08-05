// ═══════════════════════════════════════════════════════════════
//  worker.js – OPAPP Shards-API (Cloudflare Worker + D1 + KV)
//
//  ✅ HIER ÄNDERN: RETENTION_DAYS, SLOW_THRESHOLD_MS, SERVICE_VERSION,
//                  EXTERNAL_API_TIMEOUT_MS unten
//  ✅ HIER ÄNDERN: STATUS_META (Farben/Emojis/ntfy-Tags je Zustand)
//  ❌ NICHT ÄNDERN: extractItemKey() – MUSS exakt mit
//                   _extractNbtText() in lib/data/models/shard_rate.dart
//                   übereinstimmen, sonst laufen App und Worker mit
//                   unterschiedlichen Item-Keys auseinander!
//  ❌ NICHT ÄNDERN: HEALTH_STATE_KEY / MAINTENANCE_KEY – siehe
//                   MONITORING.md, Änderung erfordert manuelle
//                   KV-Migration
//
//  ZWECK:
//    Läuft unabhängig von der App im Hintergrund und ist die EINZIGE
//    Instanz, die in D1 schreibt. Die App selbst liest nur (siehe
//    Endpunkte unten). Zusätzlich überwacht sich der Worker jetzt
//    SELBST per Cron und alarmiert bei Problemen über Discord/ntfy –
//    kein externer Dienst (z.B. Uptime Kuma) mehr nötig.
//
//  ABLAUF – Cron-Job A (alle 15 Min., unverändert):
//    1. GET https://api.opsucht.net/merchant/rates abrufen
//    2. Für jedes Item einen stabilen item_key ableiten (normale Items:
//       source direkt / Custom-Items: extrahierter NBT-Anzeigetext)
//    3. items-Tabelle: upsert, rate_snapshots: neuer Datenpunkt,
//       all_time_high: nur bei echtem neuem Rekord (siehe unten)
//    4. Items, die diesmal fehlten, auf is_active=0 (nicht löschen)
//    5. Snapshots älter als RETENTION_DAYS aufräumen
//
//  ABLAUF – Cron-Job B (jede Minute, NEU – siehe Alerting-Update):
//    1. Datenbank (D1), Cache (KV) und externe OPSUCHT-API live prüfen
//    2. Gesamtstatus berechnen (online/offline/slow/maintenance)
//    3. Mit dem in KV gespeicherten letzten Status vergleichen
//    4. Bei Änderung: neuen Status in KV schreiben + Discord- und
//       ntfy-Alert senden. Bei UNVERÄNDERTEM Status: nichts schreiben
//       (siehe "KV-Schreib-Budget" unten – wichtig!)
//
//  ÄNDERUNGEN (Allzeithoch-Fix):
//    - Rekord-Vergleich läuft EXPLIZIT in JS (erst SELECT, dann nur
//      bei echtem neuem Rekord schreiben) statt rein per SQL-WHERE im
//      Upsert – das war in der Praxis unzuverlässig.
//
//  ÄNDERUNGEN (Monitoring-Update, erste Runde):
//    - GET /health eingeführt, alle Endpunkte liefern bei Fehlern
//      echte HTTP-Fehlercodes statt HTTP 200 + {"error": ...}.
//
//  ÄNDERUNGEN (Alerting-Update, diese Runde – Wechsel von Uptime Kuma
//  zu eigenem Cloudflare-nativen Monitoring):
//    - GET /health liefert jetzt ein reichhaltiges JSON (Status,
//      Sub-Checks, Version, Uptime, ...) statt nur {"status": "ok"}.
//      Siehe MONITORING.md für das vollständige Format.
//    - Vier Zustände: online 🟢 / offline 🔴 / slow 🟠 / maintenance 🟡.
//      offline = Datenbank ODER externe API nicht erreichbar (503).
//      slow = alle Checks ok, aber Antwortzeit > SLOW_THRESHOLD_MS.
//      maintenance = Flag in KV gesetzt, überschreibt alles andere.
//    - KEINE separate /shards/health-Route: Es gibt aktuell nur einen
//      einzigen Service (diesen Worker) – eine "Auth API" oder
//      ähnliches existiert nicht. GET /health IST damit bereits der
//      vollständige Status dieses Backends, ein zusätzlicher globaler
//      Aggregations-Endpunkt wäre nur eine Dopplung. Falls später
//      weitere, eigenständige Worker dazukommen, lässt sich /health
//      leicht zum echten Aggregator ausbauen.
//    - NEU: KV-Namespace HEALTH_KV – speichert den zuletzt bekannten
//      Status (health:state) für Änderungserkennung + Uptime-Tracking,
//      und das Wartungsmodus-Flag (health:maintenance).
//    - NEU: Zweiter Cron-Trigger (jede Minute) für Health-Check +
//      Alerting, unterschieden von den 15-Minuten-Kursdaten über
//      event.cron in scheduled().
//    - WICHTIG – KV-Schreib-Budget: Free-Tier erlaubt nur 1.000
//      Writes/Tag, aber 100.000 Reads/Tag. Ein 1-Minuten-Cron macht
//      1.440 Ticks/Tag – bei einem Write pro Tick wäre das Limit
//      nachmittags erreicht. Deshalb: JEDER Tick LIEST den letzten
//      Status (günstig), aber es wird NUR bei tatsächlicher
//      Zustandsänderung geschrieben (selten). Bei sehr instabilen
//      Abhängigkeiten (viele Wechsel/Tag) kann das Limit trotzdem
//      erreicht werden – dann schlagen weitere Writes an diesem Tag
//      fehl (siehe console.error), Alerts werden aber weiterhin
//      versucht, unabhängig vom KV-Schreibergebnis.
//    - checks.externalApi wird NICHT bei jedem /health-Aufruf live
//      geprüft (würde die Antwortzeit von OPSUCHT abhängig machen),
//      sondern aus dem 1-Minuten-Cron übernommen (KV) – dadurch immer
//      höchstens ~60s alt, ohne dass /health selbst eine ausgehende
//      Anfrage an OPSUCHT auslöst. Der Cron selbst prüft OPSUCHT live.
//    - checks.cache prüft NUR einen Read auf HEALTH_KV (kein Write) –
//      schont ebenfalls das Schreib-Budget, ein erfolgreicher Read
//      (auch mit leerem Ergebnis) bestätigt die KV-Bindung.
//    - Wartungsmodus ist ein KV-Wert (health:maintenance = "true"),
//      KEIN wrangler.toml-Var – so lässt er sich ohne Redeploy
//      umschalten (siehe MONITORING.md für den genauen Befehl).
//    - Secrets (NIEMALS in wrangler.toml/[vars], das Repo ist
//      öffentlich!): DISCORD_WEBHOOK_URL, NTFY_TOPIC, optional
//      NTFY_SERVER (Default https://ntfy.sh). Setup siehe
//      MONITORING.md.
//
//  ENDPUNKTE (nur lesend, GET, öffentlich – keine sensiblen Daten):
//    GET /health                             → reichhaltiger Health-Check
//    GET /shards/ath                        → aktuelle Allzeithochs
//    GET /shards/history/{itemKey}?days=7|30 → Kursverlauf, serverseitig
//      aggregiert (stündlich bei ≤7 Tagen, sonst täglich)
//    GET /shards/items                      → bekannte Items + Status
// ═══════════════════════════════════════════════════════════════

const RATES_URL = 'https://api.opsucht.net/merchant/rates';
const RETENTION_DAYS = 180; // wie lange rate_snapshots aufbewahrt werden

const SERVICE_NAME = 'OPAPP Shards API';
const SERVICE_VERSION = '1.0.0'; // synchron zu package.json halten
const SLOW_THRESHOLD_MS = 800;
const EXTERNAL_API_TIMEOUT_MS = 5000;

const HEALTH_STATE_KEY = 'health:state';
const MAINTENANCE_KEY = 'health:maintenance';

// Farben als Discord-Embed-Dezimalwerte (Hex-Literal, JS wandelt das
// automatisch um) · ntfyPriority: "1" (min) … "5" (max), siehe
// https://docs.ntfy.sh/publish/#message-priority
const STATUS_META = {
  online:      { emoji: '🟢', color: 0x2ecc71, label: 'Online',  ntfyTag: 'white_check_mark', ntfyPriority: '3' },
  offline:     { emoji: '🔴', color: 0xe74c3c, label: 'Offline', ntfyTag: 'rotating_light',   ntfyPriority: '5' },
  slow:        { emoji: '🟠', color: 0xe67e22, label: 'Langsam', ntfyTag: 'warning',          ntfyPriority: '4' },
  maintenance: { emoji: '🟡', color: 0xf1c40f, label: 'Wartung', ntfyTag: 'construction',     ntfyPriority: '3' },
};

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '*/15 * * * *') {
      ctx.waitUntil(
        pollAndStore(env).catch((err) => console.error('Cron-Lauf (Kursdaten) fehlgeschlagen:', err)),
      );
    } else if (event.cron === '* * * * *') {
      ctx.waitUntil(
        runHealthCheckAndAlert(env).catch((err) => console.error('Cron-Lauf (Health-Check) fehlgeschlagen:', err)),
      );
    } else {
      console.error(`Unbekannter Cron-Trigger: ${event.cron}`);
    }
  },
};

// ─── Cron-Job A: Rates abrufen & in D1 speichern (unverändert) ──

async function pollAndStore(env) {
  const res = await fetch(RATES_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'OPAPP-ShardsWorker/1.0' },
  });
  if (!res.ok) {
    console.error(`Rates-Abruf fehlgeschlagen: HTTP ${res.status}`);
    return;
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error('Unerwartetes API-Format (kein Array).');
    return;
  }

  const now = Date.now();
  const statements = [];
  const seenKeys = [];

  for (const entry of data) {
    const source = entry?.source?.toString() ?? '';
    const key = extractItemKey(source);
    if (!key) continue;

    const rate = Number(entry.exchangeRate);
    const base = Number(entry.base);
    if (!Number.isFinite(rate) || !Number.isFinite(base)) continue;

    seenKeys.push(key);
    const material = isNbtSource(source) ? null : source;

    // 1) Item-Stammdaten – legt neue Items automatisch an
    statements.push(
      env.DB.prepare(
        `INSERT INTO items (item_key, material, is_active, first_seen_at, last_seen_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(item_key) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           is_active = 1`,
      ).bind(key, material, now, now),
    );

    // 2) Snapshot für den späteren Kursverlauf-Graphen
    statements.push(
      env.DB.prepare(
        `INSERT INTO rate_snapshots (item_key, rate, base, fetched_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(key, rate, base, now),
    );

    // 3) Allzeithoch – EXPLIZIT per SELECT geprüft (siehe Changelog
    //    "Allzeithoch-Fix" oben). Nur bei echtem neuem Rekord (oder
    //    erstem Wert überhaupt) wird geschrieben.
    const existingAth = await env.DB.prepare(
      `SELECT rate FROM all_time_high WHERE item_key = ?`,
    ).bind(key).first();

    if (!existingAth || rate > existingAth.rate) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO all_time_high (item_key, rate, base, achieved_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(item_key) DO UPDATE SET
             rate = excluded.rate,
             base = excluded.base,
             achieved_at = excluded.achieved_at`,
        ).bind(key, rate, base, now),
      );
    }
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }

  // Items, die diesmal NICHT mehr in der API-Antwort waren, als
  // inaktiv markieren (deckt "temporäre" Items ab) – wird NICHT gelöscht.
  if (seenKeys.length > 0) {
    const placeholders = seenKeys.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE items SET is_active = 0
       WHERE is_active = 1 AND item_key NOT IN (${placeholders})`,
    ).bind(...seenKeys).run();
  }

  // Alte Snapshots aufräumen (Speicher sparen, 5-GB-Free-Limit im Blick)
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  await env.DB.prepare(`DELETE FROM rate_snapshots WHERE fetched_at < ?`)
    .bind(cutoff)
    .run();
}

// ─── Item-Key ableiten (MUSS mit shard_rate.dart übereinstimmen!) ──

function isNbtSource(source) {
  return source.includes('[') || source.includes('custom_name');
}

/**
 * Für normale Items: der rohe Material-Name (z.B. "diamond_block").
 * Für Custom-Items: der extrahierte Anzeigetext aus dem NBT-String
 * (z.B. "Gräbergemisch"). Spiegelt exakt die Logik von
 * _extractNbtText() in lib/data/models/shard_rate.dart.
 */
function extractItemKey(source) {
  if (!source) return null;
  if (!isNbtSource(source)) return source;

  const regex = /text:\s*"([^"]*)"/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    if (match[1] && match[1].length > 0) return match[1];
  }
  return source; // Fallback (sollte in der Praxis nicht vorkommen)
}

// ─── HTTP-Endpunkte (nur lesend) ────────────────────────────────

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const headers = corsHeaders();

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers });
  }

  if (url.pathname === '/health') {
    return handleHealthCheck(env, headers);
  }

  try {
    // GET /shards/ath → Allzeithoch je Item
    if (url.pathname === '/shards/ath') {
      const { results } = await env.DB.prepare(
        `SELECT item_key, rate, base, achieved_at FROM all_time_high ORDER BY item_key`,
      ).all();
      return jsonResponse(results, headers);
    }

    // GET /shards/history/{itemKey}?days=7|30 → Kursverlauf-Graph.
    // Aggregiert serverseitig: bis 7 Tage stündlich, darüber täglich.
    const historyMatch = url.pathname.match(/^\/shards\/history\/([^/]+)$/);
    if (historyMatch) {
      let itemKey;
      try {
        itemKey = decodeURIComponent(historyMatch[1]);
      } catch {
        return errorResponse(400, 'Ungültiger Item-Key in der URL.', headers);
      }

      const requestedDays = Number(url.searchParams.get('days') ?? '30');
      const days = Math.min(Math.max(requestedDays || 30, 1), RETENTION_DAYS);
      const since = Date.now() - days * 24 * 60 * 60 * 1000;
      const bucketMs = days <= 7 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

      const { results } = await env.DB.prepare(
        `SELECT
           (fetched_at / ?) * ? AS fetched_at,
           AVG(rate) AS rate,
           AVG(base) AS base
         FROM rate_snapshots
         WHERE item_key = ? AND fetched_at >= ?
         GROUP BY fetched_at / ?
         ORDER BY fetched_at ASC`,
      ).bind(bucketMs, bucketMs, itemKey, since, bucketMs).all();
      return jsonResponse(results, headers);
    }

    // GET /shards/items → bekannte Items + Status (v.a. zum Debuggen)
    if (url.pathname === '/shards/items') {
      const { results } = await env.DB.prepare(
        `SELECT item_key, material, is_active, first_seen_at, last_seen_at
         FROM items ORDER BY item_key`,
      ).all();
      return jsonResponse(results, headers);
    }

    return new Response('Not found', { status: 404, headers });
  } catch (err) {
    console.error('Fehler bei der Anfrage-Verarbeitung:', err);
    return errorResponse(503, 'Datenbank aktuell nicht erreichbar.', headers);
  }
}

// ─── Health-Check: Einzel-Checks (Alerting-Update) ──────────────

async function checkDatabase(env) {
  const start = Date.now();
  try {
    await env.DB.prepare('SELECT 1 FROM items LIMIT 1').first();
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    console.error('Datenbank-Check fehlgeschlagen:', err);
    return { ok: false, ms: Date.now() - start };
  }
}

/**
 * Prüft NUR mit einem Read (kein Write) – Workers-KV ist im Free-Tier
 * auf 1.000 Writes/Tag begrenzt, Reads dagegen auf 100.000/Tag. Gibt
 * den gelesenen health:state-Wert gleich mit zurück, damit Aufrufer
 * ihn weiterverwenden können, ohne ein zweites Mal zu lesen.
 */
async function checkCache(env) {
  const start = Date.now();
  try {
    const state = await env.HEALTH_KV.get(HEALTH_STATE_KEY, { type: 'json' });
    return { ok: true, ms: Date.now() - start, state };
  } catch (err) {
    console.error('Cache-Check (KV) fehlgeschlagen:', err);
    return { ok: false, ms: Date.now() - start, state: null };
  }
}

/** Live-Check gegen OPSUCHT – wird NUR vom 1-Minuten-Cron aufgerufen,
 * NICHT bei jedem /health-Aufruf (siehe Changelog oben). */
async function checkExternalApiLive() {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_API_TIMEOUT_MS);
  try {
    const res = await fetch(RATES_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'OPAPP-ShardsWorker/1.0' },
      signal: controller.signal,
    });
    return { ok: res.ok, ms: Date.now() - start };
  } catch (err) {
    console.error('Externe-API-Check (OPSUCHT) fehlgeschlagen:', err);
    return { ok: false, ms: Date.now() - start };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * online:      alle Checks ok
 * offline:     Datenbank ODER externe API nicht erreichbar (503) –
 *              "cache" (KV) ist NICHT kritisch, da die eigentlichen
 *              Daten-Endpunkte nicht von KV abhängen, nur das
 *              Monitoring selbst
 * slow:        alle Checks ok, aber Antwortzeit > SLOW_THRESHOLD_MS
 * maintenance: Flag in KV gesetzt – überschreibt alles andere
 */
function computeStatus({ checks, maintenance, responseTimeMs }) {
  if (maintenance) return { status: 'maintenance', httpStatus: 200 };

  const criticalFailure = checks.database === 'error' || checks.externalApi === 'error';
  if (criticalFailure) return { status: 'offline', httpStatus: 503 };

  if (responseTimeMs > SLOW_THRESHOLD_MS) return { status: 'slow', httpStatus: 200 };

  return { status: 'online', httpStatus: 200 };
}

// ─── GET /health (Alerting-Update) ───────────────────────────────

async function handleHealthCheck(env, headers) {
  const start = Date.now();
  try {
    const [dbCheck, cacheCheck, maintenanceFlag] = await Promise.all([
      checkDatabase(env),
      checkCache(env),
      env.HEALTH_KV.get(MAINTENANCE_KEY).catch(() => null),
    ]);

    const state = cacheCheck.state;
    const maintenance = maintenanceFlag === 'true';

    const checks = {
      database: dbCheck.ok ? 'ok' : 'error',
      cache: cacheCheck.ok ? 'ok' : 'error',
      // Kommt aus dem 1-Minuten-Cron (KV), nicht live geprüft – siehe
      // Changelog oben. "unknown" nur direkt nach dem ersten Deploy,
      // bevor der erste Cron-Tick gelaufen ist.
      externalApi: state?.checks?.externalApi ?? 'unknown',
    };

    const responseTimeMs = Date.now() - start;
    const { status, httpStatus } = computeStatus({ checks, maintenance, responseTimeMs });
    const uptimeSeconds =
      status === 'online' && state?.onlineSince
        ? Math.floor((Date.now() - state.onlineSince) / 1000)
        : 0;

    const body = {
      service: SERVICE_NAME,
      status,
      httpStatus,
      responseTimeMs,
      version: SERVICE_VERSION,
      maintenance,
      timestamp: new Date().toISOString(),
      uptimeSeconds,
      checks,
    };

    return new Response(JSON.stringify(body), {
      status: httpStatus,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Health-Check unerwartet fehlgeschlagen:', err);
    return new Response(
      JSON.stringify({
        service: SERVICE_NAME,
        status: 'offline',
        httpStatus: 503,
        timestamp: new Date().toISOString(),
        error: 'Health-Check konnte nicht durchgeführt werden.',
      }),
      { status: 503, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }
}

// ─── Cron-Job B: Health-Check + Alerting (jede Minute, NEU) ──────

async function runHealthCheckAndAlert(env) {
  const [dbCheck, cacheCheck, extCheck] = await Promise.all([
    checkDatabase(env),
    checkCache(env),
    checkExternalApiLive(),
  ]);

  const previous = cacheCheck.state;

  let maintenance = false;
  try {
    maintenance = (await env.HEALTH_KV.get(MAINTENANCE_KEY)) === 'true';
  } catch (err) {
    console.error('Wartungsmodus-Flag konnte nicht gelesen werden:', err);
  }

  const checks = {
    database: dbCheck.ok ? 'ok' : 'error',
    cache: cacheCheck.ok ? 'ok' : 'error',
    externalApi: extCheck.ok ? 'ok' : 'error',
  };

  const responseTimeMs = Math.max(dbCheck.ms, cacheCheck.ms, extCheck.ms);
  const { status } = computeStatus({ checks, maintenance, responseTimeMs });

  const changed =
    !previous ||
    previous.status !== status ||
    previous.checks?.database !== checks.database ||
    previous.checks?.cache !== checks.cache ||
    previous.checks?.externalApi !== checks.externalApi;

  // ✅ Kein Schreibzugriff bei unverändertem Status – schont das
  // 1.000-Writes/Tag-Limit von KV (siehe Changelog oben).
  if (!changed) return;

  const onlineSince =
    status === 'online'
      ? previous?.status === 'online' && previous?.onlineSince
        ? previous.onlineSince
        : Date.now()
      : null;

  const newState = { status, checks, onlineSince, changedAt: Date.now() };

  try {
    await env.HEALTH_KV.put(HEALTH_STATE_KEY, JSON.stringify(newState));
  } catch (err) {
    console.error('Health-Status konnte nicht in KV geschrieben werden:', err);
  }

  // Alarmierung läuft unabhängig davon, ob der KV-Write geklappt hat.
  const results = await Promise.allSettled([
    sendDiscordAlert(env, { previous, current: newState }),
    sendNtfyAlert(env, { current: newState }),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('Alert fehlgeschlagen:', r.reason);
  }
}

function describeFailedChecks(checks) {
  const failed = Object.entries(checks)
    .filter(([, v]) => v === 'error')
    .map(([k]) => k);
  return failed.length > 0 ? failed.join(', ') : 'keine';
}

async function sendDiscordAlert(env, { previous, current }) {
  if (!env.DISCORD_WEBHOOK_URL) return; // Secret nicht gesetzt → stiller No-Op

  const meta = STATUS_META[current.status];
  const prevLabel = previous ? STATUS_META[previous.status]?.label ?? previous.status : 'unbekannt (erster Check)';

  const embed = {
    title: `${meta.emoji} Shards API: ${meta.label}`,
    description: `Status-Wechsel: **${prevLabel}** → **${meta.label}**`,
    color: meta.color,
    fields: [
      { name: 'Fehlgeschlagene Checks', value: describeFailedChecks(current.checks), inline: false },
      { name: 'Datenbank',   value: current.checks.database,    inline: true },
      { name: 'Cache (KV)',  value: current.checks.cache,       inline: true },
      { name: 'OPSUCHT-API', value: current.checks.externalApi, inline: true },
    ],
    footer: { text: 'OPAPP Shards API Monitoring' },
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) console.error(`Discord-Webhook antwortete mit HTTP ${res.status}`);
}

async function sendNtfyAlert(env, { current }) {
  if (!env.NTFY_TOPIC) return; // Secret nicht gesetzt → stiller No-Op

  const meta = STATUS_META[current.status];
  const server = env.NTFY_SERVER || 'https://ntfy.sh';

  const res = await fetch(`${server}/${env.NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      'Title': `Shards API: ${meta.label}`,
      'Priority': meta.ntfyPriority,
      'Tags': meta.ntfyTag,
    },
    body: `Status: ${meta.label}. Fehlgeschlagene Checks: ${describeFailedChecks(current.checks)}.`,
  });
  if (!res.ok) console.error(`ntfy-Push antwortete mit HTTP ${res.status}`);
}

function jsonResponse(data, headers) {
  return new Response(JSON.stringify(data), {
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function errorResponse(status, message, headers) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function corsHeaders() {
  // Öffentliche, rein lesende Spielökonomie-Daten – keine sensiblen
  // Infos, daher bewusst offen für alle Origins (auch opapp.pages.dev
  // und spätere Custom-Domains, ohne Liste pflegen zu müssen).
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
