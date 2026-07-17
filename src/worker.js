// ═══════════════════════════════════════════════════════════════
//  worker.js – OPAPP Shards-API (Cloudflare Worker + D1)
//
//  ✅ HIER ÄNDERN: RETENTION_DAYS unten, Cron-Intervall in wrangler.toml
//  ❌ NICHT ÄNDERN: extractItemKey() – MUSS exakt mit
//                   _extractNbtText() in lib/data/models/shard_rate.dart
//                   übereinstimmen, sonst laufen App und Worker mit
//                   unterschiedlichen Item-Keys auseinander!
//
//  ZWECK:
//    Läuft unabhängig von der App im Hintergrund (Cron Trigger, alle
//    15 Minuten) und ist die EINZIGE Instanz, die in die D1-Datenbank
//    schreibt. Die App selbst liest nur (siehe Endpunkte unten) – das
//    verhindert falsche/manipulierte Werte durch Clients und macht
//    Auth für Schreibzugriffe unnötig.
//
//  ABLAUF (jeder Cron-Lauf):
//    1. GET https://api.opsucht.net/merchant/rates abrufen
//    2. Für jedes Item einen stabilen item_key ableiten:
//         - normale Items (z.B. "diamond_block")  → source direkt
//         - Custom-Items (NBT-String)              → extrahierter
//           Anzeige-Text (z.B. "Gräbergemisch"), NICHT der rohe
//           NBT-String (der kann sich in Details wie Farbe oder
//           custom_model_data ändern, ohne ein neues Item zu sein)
//    3. items-Tabelle: upsert – neue Items werden automatisch
//       angelegt, first_seen_at bleibt, last_seen_at aktualisiert
//    4. rate_snapshots: ein neuer Datenpunkt (Basis für den späteren
//       Kursverlauf-Graphen)
//    5. all_time_high: NUR aktualisieren, wenn der neue Kurs höher
//       ist als der bisherige Rekord
//    6. Items, die in DIESEM Lauf nicht mehr in der API-Antwort
//       waren, werden auf is_active=0 gesetzt (NICHT gelöscht – so
//       bleiben Historie & Rekord erhalten, falls ein temporäres
//       Item später zurückkehrt)
//    7. Snapshots älter als RETENTION_DAYS werden aufgeräumt
//       (hält die 5-GB-Free-Grenze von D1 im Blick)
//
//  ENDPUNKTE (nur lesend, GET, öffentlich – keine sensiblen Daten):
//    GET /shards/ath                        → aktuelle Allzeithochs
//    GET /shards/history/{itemKey}?days=30  → Kursverlauf (für Graph)
//    GET /shards/items                      → bekannte Items + Status
// ═══════════════════════════════════════════════════════════════

const RATES_URL = 'https://api.opsucht.net/merchant/rates';
const RETENTION_DAYS = 180; // wie lange rate_snapshots aufbewahrt werden

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      pollAndStore(env).catch((err) => console.error('Cron-Lauf fehlgeschlagen:', err)),
    );
  },
};

// ─── Cron-Job: Rates abrufen & in D1 speichern ─────────────────

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

    // 3) Allzeithoch NUR aktualisieren, wenn der neue Kurs höher ist
    //    (oder noch kein Rekord existiert)
    statements.push(
      env.DB.prepare(
        `INSERT INTO all_time_high (item_key, rate, base, achieved_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(item_key) DO UPDATE SET
           rate = excluded.rate,
           base = excluded.base,
           achieved_at = excluded.achieved_at
         WHERE excluded.rate > all_time_high.rate`,
      ).bind(key, rate, base, now),
    );
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
 * (z.B. "Gräbergemisch") – NICHT der komplette NBT-String, da sich
 * Details wie Farbe oder custom_model_data ändern können, ohne dass
 * es sich um ein neues Item handelt. Spiegelt exakt die Logik von
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

  // GET /shards/ath → Allzeithoch je Item
  if (url.pathname === '/shards/ath') {
    const { results } = await env.DB.prepare(
      `SELECT item_key, rate, base, achieved_at FROM all_time_high ORDER BY item_key`,
    ).all();
    return jsonResponse(results, headers);
  }

  // GET /shards/history/{itemKey}?days=30 → Kursverlauf (für künftigen Graph)
  const historyMatch = url.pathname.match(/^\/shards\/history\/([^/]+)$/);
  if (historyMatch) {
    const itemKey = decodeURIComponent(historyMatch[1]);
    const requestedDays = Number(url.searchParams.get('days') ?? '30');
    const days = Math.min(Math.max(requestedDays || 30, 1), RETENTION_DAYS);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const { results } = await env.DB.prepare(
      `SELECT rate, base, fetched_at FROM rate_snapshots
       WHERE item_key = ? AND fetched_at >= ?
       ORDER BY fetched_at ASC`,
    ).bind(itemKey, since).all();
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
}

function jsonResponse(data, headers) {
  return new Response(JSON.stringify(data), {
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
