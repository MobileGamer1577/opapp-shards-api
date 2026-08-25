// ═══════════════════════════════════════════════════════════════
//  worker.js – OPAPP API (Cloudflare Worker + D1 + KV)
//
//  ✅ Discord-Fields strikt untereinander (inline: false für PC & Handy)
//  ✅ Routen-Monitoring für /shards/ath, /shards/items, /shards/history,
//     /server/peak & /server/peak/today
//  ✅ RETENTION_DAYS, SLOW_THRESHOLD_MS, SERVICE_VERSION anpassbar
//  ✅ Inklusive Routen-Level-Monitoring & ChatGPT Discord-Embed-Design
//  ENDPUNKTE (nur lesend, GET, öffentlich – keine sensiblen Daten):
//    GET /health                             → reichhaltiger Health-Check
//    GET /shards/ath                        → aktuelle Allzeithochs
//    GET /shards/history/{itemKey}?days=7|30 → Kursverlauf, serverseitig
//      aggregiert (stündlich bei ≤7 Tagen, sonst täglich)
//    GET /shards/items                      → bekannte Items + Status
//    GET /server/peak                       → Spieler-Rekord (höchste je
//      gemessene Online-Spielerzahl + Datum) – Server-Status-Update
//    GET /server/peak/today                 → höchste Online-Spielerzahl
//      HEUTE (Kalendertag Europe/Berlin) + Zeitpunkt – NEU,
//      Server-Info-Update
//
//  ✅ UMBENANNT (Server-Status-Update): "opapp-shards-api" → "opapp-api",
//  da der Worker jetzt mehr als nur die OPShard-Kurse abdeckt. Beim
//  Deployen dieser Umbenennung unbedingt die Reihenfolge aus dem
//  Kommentar in wrangler.toml beachten (alten Worker erst NACH
//  erfolgreichem Redeploy löschen, sonst doppelte Cron-Ticks auf
//  derselben D1-Datenbank)!
//
//  ⚠️ DEPLOY-REIHENFOLGE (Server-Info-Update): Vor diesem Deploy zuerst
//  migrations/0004_daily_peak.sql remote ausführen (npm run
//  db:migrate-daily-peak) – sonst schlägt updateDailyPeak() im Cron mit
//  einem SQL-Fehler fehl (wird nur geloggt, Tages-Peak bliebe bis zur
//  Migration leer, kein harter Crash für den Rest des Workers).
// ═══════════════════════════════════════════════════════════════

const RATES_URL = 'https://api.opsucht.net/merchant/rates';
const RETENTION_DAYS = 180;

// ✅ NEU (Server-Status-Update): Live-Serverstatus für den Spieler-
// Rekord. Bewusst "bc4.opsucht.iwmedia.ovh" statt "opsucht.net" (auf
// Wunsch) – siehe auch ApiConstants.serverStatusUrl in der Flutter-App,
// die dieselbe Adresse für die Live-Anzeige verwendet (dort wird direkt
// gegen mc-api.io gefetcht, nicht über diesen Worker – hier läuft nur
// die Rekord-Erfassung).
const PLAYER_STATUS_URL = 'https://mc-api.io/server/java/bc4.opsucht.iwmedia.ovh';

const SERVICE_NAME = 'OPAPP API';
const SERVICE_VERSION = '1.1.0';
const SLOW_THRESHOLD_MS = 800;
const EXTERNAL_API_TIMEOUT_MS = 5000;

const HEALTH_STATE_KEY = 'health:state';
const MAINTENANCE_KEY = 'health:maintenance';

const STATUS_META = {
  online:      { emoji: '🟢', color: 3066993,  label: 'Online',  ntfyTag: 'white_check_mark', ntfyPriority: '3' },
  offline:     { emoji: '🔴', color: 15158332, label: 'Offline', ntfyTag: 'rotating_light',   ntfyPriority: '5' },
  slow:        { emoji: '🟠', color: 15105570, label: 'Langsam', ntfyTag: 'warning',          ntfyPriority: '4' },
  maintenance: { emoji: '🟡', color: 16776960, label: 'Wartung', ntfyTag: 'construction',     ntfyPriority: '3' },
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
      // ✅ pollPlayerPeak() läuft im selben 1-Minuten-Tick wie der
      // Health-Check mit – kein dritter Cron-Trigger nötig. Beide
      // unabhängig voneinander (ein Fehler im einen blockiert den
      // anderen nicht). Seit dem Server-Info-Update pflegt
      // pollPlayerPeak() aus EINEM Fetch sowohl den All-Time-Rekord
      // als auch den Tages-Peak.
      ctx.waitUntil(
        Promise.all([
          runHealthCheckAndAlert(env).catch((err) => console.error('Cron-Lauf (Health-Check) fehlgeschlagen:', err)),
          pollPlayerPeak(env).catch((err) => console.error('Cron-Lauf (Spieler-Rekord) fehlgeschlagen:', err)),
        ]),
      );
    } else {
      console.error(`Unbekannter Cron-Trigger: ${event.cron}`);
    }
  },
};

// ─── Cron-Job A: Rates abrufen & in D1 speichern ────────────────

async function pollAndStore(env) {
  const res = await fetch(RATES_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'OPAPP-ShardsWorker/1.0' },
  });
  if (!res.ok) {
    console.error(`Rates-Abruf fehlgeschlagen: HTTP ${res.status}`);
    return;
  }

  const data = await res.json();
  if (!Array.isArray(data)) return;

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

    statements.push(
      env.DB.prepare(
        `INSERT INTO items (item_key, material, is_active, first_seen_at, last_seen_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(item_key) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           is_active = 1`,
      ).bind(key, material, now, now),
    );

    statements.push(
      env.DB.prepare(
        `INSERT INTO rate_snapshots (item_key, rate, base, fetched_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(key, rate, base, now),
    );

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

  if (seenKeys.length > 0) {
    const placeholders = seenKeys.map(() => '?').join(',');
    await env.DB.prepare(
      `UPDATE items SET is_active = 0
       WHERE is_active = 1 AND item_key NOT IN (${placeholders})`,
    ).bind(...seenKeys).run();
  }

  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  await env.DB.prepare(`DELETE FROM rate_snapshots WHERE fetched_at < ?`)
    .bind(cutoff)
    .run();
}

function isNbtSource(source) {
  return source.includes('[') || source.includes('custom_name');
}

function extractItemKey(source) {
  if (!source) return null;
  if (!isNbtSource(source)) return source;

  const regex = /text:\s*"([^"]*)"/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    if (match[1] && match[1].length > 0) return match[1];
  }
  return source;
}

// ─── Cron-Job B (Teil 2): Spieler-Rekord (All-Time + Heute) pollen &
// bei neuem Rekord in D1 speichern (Server-Status-Update, erweitert im
// Server-Info-Update um den Tages-Peak) ──────────────────────────────
//
// ❌ WICHTIG: Bewusst SELECT-then-compare in JS statt eines WHERE-
// conditional Upserts – letzteres ist mit D1 unzuverlässig (siehe
// gleiches Muster schon in pollAndStore() für all_time_high oben).
//
// ✅ NEU (Server-Info-Update): EIN Fetch pro Cron-Tick wird jetzt für
// ZWEI Aktualisierungen genutzt (All-Time-Rekord UND Tages-Peak) –
// vorher gab es hier nur den All-Time-Teil. Kein zusätzlicher Request
// an mc-api.io nötig, dadurch keine höhere Last auf der externen API.

async function pollPlayerPeak(env) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_API_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(PLAYER_STATUS_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'OPAPP-Worker/1.0' },
      signal: controller.signal,
    });
    if (!res.ok) return;
    data = await res.json();
  } catch (err) {
    console.error('Spieler-Rekord-Check fehlgeschlagen:', err);
    return;
  } finally {
    clearTimeout(timeoutId);
  }

  const count = Number(data.onlinePlayers);
  if (!Number.isFinite(count)) return;
  const now = Date.now();

  await Promise.all([
    updateAllTimePeak(env, count, now),
    updateDailyPeak(env, count, now),
  ]);
}

async function updateAllTimePeak(env, count, now) {
  try {
    const existing = await env.DB.prepare(
      `SELECT player_count FROM player_count_peak WHERE id = 1`,
    ).first();

    if (!existing || count > existing.player_count) {
      await env.DB.prepare(
        `INSERT INTO player_count_peak (id, player_count, achieved_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           player_count = excluded.player_count,
           achieved_at = excluded.achieved_at`,
      ).bind(count, now).run();
    }
  } catch (err) {
    console.error('All-Time-Rekord-Update fehlgeschlagen:', err);
  }
}

// ✅ NEU (Server-Info-Update): Tages-Peak, Tagesgrenze = Europe/Berlin
// Mitternacht (inkl. Sommer-/Winterzeit, siehe berlinDateString()
// unten). Eine Zeile PRO KALENDERTAG (daily_peak, siehe migrations/
// 0004_daily_peak.sql) – kein Retention-Cleanup nötig, das wächst nur
// um ~365 Zeilen/Jahr. Eigener try/catch, damit ein Fehler hier NICHT
// auch updateAllTimePeak() betrifft (Promise.all oben liefe sonst als
// Ganzes auf reject, obwohl der All-Time-Teil erfolgreich war).
async function updateDailyPeak(env, count, now) {
  try {
    const today = berlinDateString(now);

    const existing = await env.DB.prepare(
      `SELECT player_count FROM daily_peak WHERE date = ?`,
    ).bind(today).first();

    if (!existing || count > existing.player_count) {
      await env.DB.prepare(
        `INSERT INTO daily_peak (date, player_count, achieved_at)
         VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           player_count = excluded.player_count,
           achieved_at = excluded.achieved_at`,
      ).bind(today, count, now).run();
    }
  } catch (err) {
    console.error('Tages-Peak-Update fehlgeschlagen:', err);
  }
}

// Kalendertag (YYYY-MM-DD) in Europe/Berlin für einen Unix-Millisekunden-
// Zeitstempel. Nutzt Intl.DateTimeFormat.formatToParts() statt sich auf
// ein bestimmtes Locale-Ausgabeformat (z.B. "en-CA" → YYYY-MM-DD) zu
// verlassen – so bleibt das Ergebnis stabil, egal wie sich Intl-Locale-
// Defaults künftig verhalten. Berücksichtigt Sommer-/Winterzeit
// automatisch über die in workerd integrierte IANA-Zeitzonendatenbank.
function berlinDateString(timestampMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestampMs));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

// ─── HTTP-Endpunkte ──────────────────────────────────────────────

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const headers = corsHeaders();

  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers });

  if (url.pathname === '/health') {
    return handleHealthCheck(env, headers);
  }

  try {
    if (url.pathname === '/shards/ath') {
      const { results } = await env.DB.prepare(
        `SELECT item_key, rate, base, achieved_at FROM all_time_high ORDER BY item_key`,
      ).all();
      return jsonResponse(results, headers);
    }

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

    if (url.pathname === '/shards/items') {
      const { results } = await env.DB.prepare(
        `SELECT item_key, material, is_active, first_seen_at, last_seen_at
         FROM items ORDER BY item_key`,
      ).all();
      return jsonResponse(results, headers);
    }

    // Spieler-Rekord (All-Time). Noch keine Zeile vorhanden (z.B.
    // direkt nach Deploy/Migration, bevor der erste Cron-Tick lief)? →
    // playerCount/achievedAt bewusst null statt Fehler, App zeigt dann
    // "Noch keine Daten" (siehe ServerPeak in der Flutter-App).
    if (url.pathname === '/server/peak') {
      const row = await env.DB.prepare(
        `SELECT player_count, achieved_at FROM player_count_peak WHERE id = 1`,
      ).first();
      if (!row) {
        return jsonResponse({ playerCount: null, achievedAt: null }, headers);
      }
      return jsonResponse(
        { playerCount: row.player_count, achievedAt: row.achieved_at },
        headers,
      );
    }

    // ✅ NEU (Server-Info-Update): Tages-Peak (höchste Online-Spieler-
    // zahl seit Mitternacht Europe/Berlin). Noch keine Zeile für heute
    // (z.B. kurz nach Mitternacht, bevor der erste Cron-Tick lief, oder
    // direkt nach der Migration)? → playerCount/achievedAt bewusst
    // null, gleiches Fallback-Prinzip wie /server/peak oben – GENAU
    // dasselbe JSON-Format, ServerPeak.fromJson in der Flutter-App
    // deckt beide Endpunkte ab.
    if (url.pathname === '/server/peak/today') {
      const today = berlinDateString(Date.now());
      const row = await env.DB.prepare(
        `SELECT player_count, achieved_at FROM daily_peak WHERE date = ?`,
      ).bind(today).first();
      if (!row) {
        return jsonResponse({ playerCount: null, achievedAt: null }, headers);
      }
      return jsonResponse(
        { playerCount: row.player_count, achievedAt: row.achieved_at },
        headers,
      );
    }

    return new Response('Not found', { status: 404, headers });
  } catch (err) {
    console.error('Fehler bei der Anfrage-Verarbeitung:', err);
    return errorResponse(503, 'Datenbank aktuell nicht erreichbar.', headers);
  }
}

// ─── Health-Checks & Routen-Tests ───────────────────────────────

async function checkDatabase(env) {
  const start = Date.now();
  try {
    await env.DB.prepare('SELECT 1 FROM items LIMIT 1').first();
    return { ok: true, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, ms: Date.now() - start };
  }
}

async function checkCache(env) {
  const start = Date.now();
  try {
    const state = await env.HEALTH_KV.get(HEALTH_STATE_KEY, { type: 'json' });
    return { ok: true, ms: Date.now() - start, state };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, state: null };
  }
}

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
    return { ok: false, ms: Date.now() - start };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Prüft gezielt alle einzelnen API-Routen durch interne Requests
async function checkAllRoutes(env) {
  const routesToTest = [
    { name: 'Shards ATH (/shards/ath)', path: '/shards/ath' },
    { name: 'Shards Items (/shards/items)', path: '/shards/items' },
    { name: 'Shards History (/shards/history)', path: '/shards/history/test?days=7' },
    { name: 'Server Peak (/server/peak)', path: '/server/peak' },
    // ✅ NEU (Server-Info-Update)
    { name: 'Server Peak Today (/server/peak/today)', path: '/server/peak/today' },
  ];

  for (const route of routesToTest) {
    try {
      const mockReq = new Request(`https://internal-check.local${route.path}`);
      const res = await handleRequest(mockReq, env);
      if (res.status >= 400) {
        return { ok: false, failedRoute: route.name, status: res.status };
      }
    } catch (err) {
      return { ok: false, failedRoute: route.name, status: 500 };
    }
  }

  return { ok: true, failedRoute: null };
}

function computeStatus({ checks, maintenance, responseTimeMs }) {
  if (maintenance) return { status: 'maintenance', httpStatus: 200 };

  const criticalFailure = checks.database === 'error' || checks.externalApi === 'error' || checks.routes === 'error';
  if (criticalFailure) return { status: 'offline', httpStatus: 503 };

  if (responseTimeMs > SLOW_THRESHOLD_MS) return { status: 'slow', httpStatus: 200 };

  return { status: 'online', httpStatus: 200 };
}

// ─── GET /health ─────────────────────────────────────────────────

async function handleHealthCheck(env, headers) {
  const start = Date.now();
  try {
    const [dbCheck, cacheCheck, routeCheck, maintenanceFlag] = await Promise.all([
      checkDatabase(env),
      checkCache(env),
      checkAllRoutes(env),
      env.HEALTH_KV.get(MAINTENANCE_KEY).catch(() => null),
    ]);

    const state = cacheCheck.state;
    const maintenance = maintenanceFlag === 'true';

    const checks = {
      database: dbCheck.ok ? 'ok' : 'error',
      cache: cacheCheck.ok ? 'ok' : 'error',
      externalApi: state?.checks?.externalApi ?? 'unknown',
      routes: routeCheck.ok ? 'ok' : 'error',
      failedRouteName: routeCheck.failedRoute
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

// ─── Cron-Job B (Teil 1): Monitoring & Alerts ────────────────────

async function runHealthCheckAndAlert(env) {
  const [dbCheck, cacheCheck, extCheck, routeCheck] = await Promise.all([
    checkDatabase(env),
    checkCache(env),
    checkExternalApiLive(),
    checkAllRoutes(env),
  ]);

  const previous = cacheCheck.state;
  let maintenance = false;
  try {
    maintenance = (await env.HEALTH_KV.get(MAINTENANCE_KEY)) === 'true';
  } catch (err) {}

  const checks = {
    database: dbCheck.ok ? 'ok' : 'error',
    cache: cacheCheck.ok ? 'ok' : 'error',
    externalApi: extCheck.ok ? 'ok' : 'error',
    routes: routeCheck.ok ? 'ok' : 'error',
    failedRouteName: routeCheck.failedRoute,
  };

  const responseTimeMs = Math.max(dbCheck.ms, cacheCheck.ms, extCheck.ms);
  const { status, httpStatus } = computeStatus({ checks, maintenance, responseTimeMs });

  const changed =
    !previous ||
    previous.status !== status ||
    previous.checks?.database !== checks.database ||
    previous.checks?.externalApi !== checks.externalApi ||
    previous.checks?.routes !== checks.routes;

  if (!changed) return;

  const nowMs = Date.now();
  const onlineSince = status === 'online'
    ? (previous?.status === 'online' && previous?.onlineSince ? previous.onlineSince : nowMs)
    : null;

  const offlineSince = status === 'offline'
    ? (previous?.status === 'offline' && previous?.offlineSince ? previous.offlineSince : nowMs)
    : null;

  const newState = {
    status,
    httpStatus,
    checks,
    onlineSince,
    offlineSince,
    changedAt: nowMs,
    responseTimeMs
  };

  try {
    await env.HEALTH_KV.put(HEALTH_STATE_KEY, JSON.stringify(newState));
  } catch (err) {
    console.error('Health-Status in KV speichern fehlgeschlagen:', err);
  }

  const results = await Promise.allSettled([
    sendDiscordAlert(env, { previous, current: newState }),
    sendNtfyAlert(env, { current: newState }),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('Alert fehlgeschlagen:', r.reason);
  }
}

// ─── Hilfsfunktionen für Embed-Formatierung ───────────────────────

function formatGermanDate(dateObj) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = pad(dateObj.getDate());
  const m = pad(dateObj.getMonth() + 1);
  const y = dateObj.getFullYear();
  const hh = pad(dateObj.getHours());
  const mm = pad(dateObj.getMinutes());
  const ss = pad(dateObj.getSeconds());
  return `${d}.${m}.${y} • ${hh}:${mm}:${ss}`;
}

function formatDowntime(ms) {
  if (!ms || ms <= 0) return '0 Sekunden';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes} Minute${minutes > 1 ? 'n' : ''} ${seconds} Sekunde${seconds !== 1 ? 'n' : ''}`;
  }
  return `${seconds} Sekunde${seconds !== 1 ? 'n' : ''}`;
}

// ─── Discord-Webhook (Alle Fields auf inline: false gesetzt) ──────

async function sendDiscordAlert(env, { previous, current }) {
  if (!env.DISCORD_WEBHOOK_URL) return;

  const isOnline = current.status === 'online';
  const isOffline = current.status === 'offline';
  const isSlow = current.status === 'slow';
  const isMaintenance = current.status === 'maintenance';

  const now = new Date();
  const dateStr = formatGermanDate(now);

  let title = '';
  let color = STATUS_META[current.status].color;
  let fields = [];

  // Ermitteln, welche API-Komponente genau ausgefallen ist
  let affectedApiName = SERVICE_NAME;
  if (current.checks.routes === 'error' && current.checks.failedRouteName) {
    affectedApiName = current.checks.failedRouteName;
  } else if (current.checks.database === 'error') {
    affectedApiName = 'D1 Datenbank (/shards/*, /server/*)';
  } else if (current.checks.externalApi === 'error') {
    affectedApiName = 'OPSUCHT Merchant API Sync';
  }

  if (isOffline) {
    title = '🔴 OPAPP API-Alarm';
    fields = [
      { name: '❌ Status', value: 'Offline', inline: false },
      { name: '📦 API', value: affectedApiName, inline: false },
      { name: '📡 HTTP Status', value: `${current.httpStatus} Service Unavailable`, inline: false },
      { name: '🌐 URL', value: 'https://opapp-api.px32.workers.dev/health', inline: false },
      { name: '⏱️ Antwortzeit', value: 'Timeout / Error', inline: false },
      { name: '🕒 Erkannt', value: dateStr, inline: false }
    ];
  } else if (isOnline) {
    title = '🟢 OPAPP API';
    const downtimeMs = previous?.offlineSince ? Date.now() - previous.offlineSince : 0;
    fields = [
      { name: '✅ Status', value: 'Online', inline: false },
      { name: '📦 API', value: SERVICE_NAME, inline: false },
      { name: '⚡ Ping', value: `${current.responseTimeMs} ms`, inline: false },
      { name: '🌐 URL', value: 'https://opapp-api.px32.workers.dev/health', inline: false },
      { name: '⏱️ Downtime', value: formatDowntime(downtimeMs), inline: false },
      { name: '🕒 Wieder online', value: now.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' }), inline: false }
    ];
  } else if (isMaintenance) {
    title = '🟡 OPAPP Wartungsmodus';
    fields = [
      { name: '🛠️ Status', value: 'Wartung', inline: false },
      { name: '📦 API', value: SERVICE_NAME, inline: false },
      { name: 'ℹ️ Grund', value: 'System-Wartung / KV Migration', inline: false }
    ];
  } else if (isSlow) {
    title = '🟠 OPAPP API Leistungs-Warnung';
    fields = [
      { name: '⚠️ Status', value: 'Hohe Latenz (Slow)', inline: false },
      { name: '📦 API', value: SERVICE_NAME, inline: false },
      { name: '⏱️ Antwortzeit', value: `${current.responseTimeMs} ms (> ${SLOW_THRESHOLD_MS}ms)`, inline: false }
    ];
  }

  const embed = {
    title: title,
    description: '━━━━━━━━━━━━━━━━━━',
    color: color,
    fields: fields,
    footer: { text: isOnline ? 'OPAPP Uptime Monitoring • Resolved' : 'OPAPP Uptime Monitoring • System Alert' }
  };

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'OPAPP Monitoring', embeds: [embed] }),
  });
  if (!res.ok) console.error(`Discord-Webhook antwortete mit HTTP ${res.status}`);
}

// ─── ntfy-Push ───────────────────────────────────────────────────

async function sendNtfyAlert(env, { current }) {
  if (!env.NTFY_TOPIC) return;

  const meta = STATUS_META[current.status];
  const server = env.NTFY_SERVER || 'https://ntfy.sh';

  let failedText = 'Keine';
  if (current.checks.routes === 'error' && current.checks.failedRouteName) {
    failedText = current.checks.failedRouteName;
  } else if (current.checks.database === 'error') {
    failedText = 'D1 Datenbank';
  } else if (current.checks.externalApi === 'error') {
    failedText = 'OPSUCHT API Sync';
  }

  const res = await fetch(`${server}/${env.NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      'Title': `OPAPP API: ${meta.label}`,
      'Priority': meta.ntfyPriority,
      'Tags': meta.ntfyTag,
    },
    body: `Status: ${meta.label} (${current.httpStatus}). Betroffen: ${failedText}. Ping: ${current.responseTimeMs}ms.`,
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
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
