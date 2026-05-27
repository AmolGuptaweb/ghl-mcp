import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const app = express();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Basic Auth ────────────────────────────────────────────────────────────────
const DASH_USER = process.env.DASHBOARD_USER;
const DASH_PASS = process.env.DASHBOARD_PASS;
app.use((req, res, next) => {
  if (!DASH_USER || !DASH_PASS) return next();
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Basic ")) {
    const [u, p] = Buffer.from(auth.slice(6), "base64").toString().split(":");
    if (u === DASH_USER && p === DASH_PASS) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="M&A Dashboard"');
  res.status(401).send("Authentication required");
});

app.get("/franchise", (req, res) => res.redirect("/franchise.html"));
app.use(express.static(join(__dirname, "public")));

const GHL_ENVS = {
  ma:        { token: process.env.GHL_MA_PIT_TOKEN, location: process.env.GHL_MA_LOCATION_ID, label: "M&A" },
  franchise: { token: process.env.GHL_FR_PIT_TOKEN, location: process.env.GHL_FR_LOCATION_ID, label: "Franchise" },
};

const X8_APIKEY    = process.env["8X8_API_KEY"];
const X8_USER      = process.env["8X8_USERNAME"];
const X8_PASS      = process.env["8X8_PASSWORD"];
const X8_PBX       = process.env["8X8_PBX_ID"];

const STAGE_FIELD         = "GcCxxdgNIXhXat8kK5j6";
const STATUS_UPDATES_FIELD = "1oF4PvG6yzDCu4vpPHWi";
const CLOSED_KEYS         = ["close", "won", "lost"];

// ── 8x8 token cache ──────────────────────────────────────────────────────────
let _token = null, _tokenExp = 0;

// ── 8x8 CDR rolling cache (60-day window, refreshed every 20 min) ────────────
let _cdrCache = null, _cdrCacheExp = 0;
async function getCachedCDR(token) {
  if (_cdrCache && Date.now() < _cdrCacheExp) return _cdrCache;
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const start = new Date(`${todayStr}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 60);
  const startStr = start.toISOString().slice(0, 10);
  console.log(`[CDR cache] building ${startStr} → ${todayStr}…`);
  const records = await fetchCDRRange(startStr, todayStr, token);
  console.log(`[CDR cache] ${records.length} records cached`);
  _cdrCache = records;
  _cdrCacheExp = Date.now() + 20 * 60 * 1000;
  return records;
}
async function get8x8Token() {
  if (_token && Date.now() < _tokenExp) return _token;
  const body = new URLSearchParams({ username: X8_USER, password: X8_PASS });
  const r = await fetch("https://api.8x8.com/analytics/work/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "8x8-apikey": X8_APIKEY },
    body: body.toString(),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) {
    console.error("8x8 auth failed:", r.status, JSON.stringify(d));
    throw new Error(`8x8 auth failed: ${r.status} ${d.message ?? ""}`);
  }
  _token    = d.access_token;
  _tokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return _token;
}

// ── GHL: fetch all contacts added on a given date (EDT = UTC-4) ──────────────
async function fetchGHLLeads(date, ghlToken, ghlLocation) {
  const startMs = new Date(`${date}T00:00:00.000-04:00`).getTime();
  const endMs   = new Date(`${date}T23:59:59.999-04:00`).getTime();
  let contacts = [], startAfter = null, startAfterId = null;
  do {
    let url = `https://services.leadconnectorhq.com/contacts/?locationId=${ghlLocation}&startDate=${startMs}&endDate=${endMs}&limit=100`;
    if (startAfter) url += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${ghlToken}`, Version: "2021-07-28" } });
    const d = await r.json();
    contacts = contacts.concat(d.contacts ?? []);
    startAfter   = d.meta?.startAfter   ?? null;
    startAfterId = d.meta?.startAfterId ?? null;
  } while (startAfterId);
  return contacts;
}

// ── GHL: fetch location users → { userId: name } map ─────────────────────────
async function fetchLocationUsers(ghlLocation, ghlToken) {
  try {
    const r = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${ghlLocation}`, {
      headers: { Authorization: `Bearer ${ghlToken}`, Version: "2021-07-28" },
    });
    const d = await r.json();
    const map = {};
    for (const u of d.users ?? []) map[u.id] = u.name || `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email;
    return map;
  } catch { return {}; }
}

// ── GHL: fetch latest contact note (plain text, HTML stripped) ───────────────
function stripHtml(html) {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
  return text || null;
}

async function fetchLatestNote(contactId, ghlToken) {
  try {
    const r = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
      headers: { Authorization: `Bearer ${ghlToken}`, Version: "2021-07-28" },
    });
    const d = await r.json();
    const notes = (d.notes ?? []).sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
    // Skip auto-generated SharePoint notes (added by GHL workflow to every contact)
    for (const note of notes) {
      if (!note.body || note.body.includes("sharepoint.com")) continue;
      const text = stripHtml(note.body);
      if (text) return text;
    }
    return null;
  } catch { return null; }
}

// ── GHL: resolve "Contact Stage" custom field ID per location (cached) ────────
const _stageFieldCache = {};
async function resolveStageFieldId(ghlLocation, ghlToken) {
  if (_stageFieldCache[ghlLocation]) return _stageFieldCache[ghlLocation];
  try {
    const r = await fetch(`https://services.leadconnectorhq.com/locations/${ghlLocation}/customFields`, {
      headers: { Authorization: `Bearer ${ghlToken}`, Version: "2021-07-28" },
    });
    if (!r.ok) return (_stageFieldCache[ghlLocation] = STAGE_FIELD);
    const d = await r.json();
    const field = (d.customFields ?? []).find(f =>
      (f.name ?? "").toLowerCase().replace(/\s+/g, "") === "contactstage"
    );
    return (_stageFieldCache[ghlLocation] = field?.id ?? STAGE_FIELD);
  } catch {
    return (_stageFieldCache[ghlLocation] = STAGE_FIELD);
  }
}

// ── 8x8 CDR: fetch one 6-hour block (paginated) ──────────────────────────────
async function fetchBlockCDR(date, startHour, endHour, token) {
  const pad = n => String(n).padStart(2, "0");
  const s   = encodeURIComponent(`${date} ${pad(startHour)}:00:00`);
  const e   = encodeURIComponent(`${date} ${pad(endHour)}:59:59`);
  const tz  = encodeURIComponent("America/New_York");
  const base = `https://api.8x8.com/analytics/work/v2/call-records?pbxId=${X8_PBX}&startTime=${s}&endTime=${e}&timeZone=${tz}&pageSize=500`;
  const records = [], seenIds = new Set();
  try {
    for (let page = 1; page <= 50; page++) {
      const r = await fetch(`${base}&page=${page}`, { headers: { Authorization: `Bearer ${token}`, "8x8-apikey": X8_APIKEY } });
      if (!r.ok) break;
      const d = await r.json();
      const data = d.data ?? [];
      if (data.length === 0) break;
      let added = 0;
      for (const rec of data) {
        if (!seenIds.has(rec.callId)) { seenIds.add(rec.callId); records.push(rec); added++; }
      }
      if (added === 0 || data.length < 100) break; // no new records or last page
    }
  } catch (err) {
    console.error(`CDR block ${date} ${startHour}-${endHour} error:`, err.message);
  }
  return records;
}

// ── 8x8 CDR: fetch full day via 4 × 6-hour blocks ────────────────────────────
async function fetchDayCDR(date, token) {
  const blocks = [[0,5],[6,11],[12,17],[18,23]];
  const results = await Promise.all(blocks.map(([s, e]) => fetchBlockCDR(date, s, e, token)));
  const seen = new Set(), records = [];
  for (const list of results) {
    for (const r of list) {
      if (!seen.has(r.callId)) { seen.add(r.callId); records.push(r); }
    }
  }
  return records;
}

// ── 8x8 CDR: fetch every day from startDate to endDate (inclusive) ────────────
async function fetchCDRRange(startDate, endDate, token) {
  const dates = [];
  const cur = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  while (cur <= end) { dates.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1); }

  const seen = new Set(), records = [];
  const BATCH = 2;
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(dt => fetchDayCDR(dt, token)));
    for (const list of results) {
      for (const r of list) {
        if (!seen.has(r.callId)) { seen.add(r.callId); records.push(r); }
      }
    }
    if (i + BATCH < dates.length) await new Promise(r => setTimeout(r, 200));
  }
  return records;
}

// ── Normalize phone to last 10 digits ────────────────────────────────────────
function normPhone(p) {
  if (!p) return null;
  const d = p.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d || null;
}

// ── API endpoint ─────────────────────────────────────────────────────────────
app.get("/api/dashboard", async (req, res) => {
  try {
    const envKey = (req.query.env ?? "ma").toLowerCase();
    const ghl = GHL_ENVS[envKey] ?? GHL_ENVS.ma;
    if (!ghl.token || !ghl.location) return res.status(400).json({ error: `GHL credentials for env "${envKey}" are not configured.` });

    const date = req.query.date || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const [leads, token, userMap, stageFieldId] = await Promise.all([
      fetchGHLLeads(date, ghl.token, ghl.location),
      get8x8Token(),
      fetchLocationUsers(ghl.location, ghl.token),
      resolveStageFieldId(ghl.location, ghl.token),
    ]);
    const cdrRecords = await getCachedCDR(token);

    // For franchise: fetch latest note per lead (batched to avoid rate limits)
    const notesMap = {};
    if (envKey === "franchise") {
      const BATCH = 10;
      for (let i = 0; i < leads.length; i += BATCH) {
        const batch = leads.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(l => fetchLatestNote(l.id, ghl.token)));
        batch.forEach((l, idx) => { if (results[idx]) notesMap[l.id] = results[idx]; });
        if (i + BATCH < leads.length) await new Promise(r => setTimeout(r, 150));
      }
    }

    // Build set of phones that were called outbound
    const outboundCalled = new Set();
    for (const r of cdrRecords) {
      if ((r.direction ?? "").toLowerCase() === "outgoing") {
        const p = normPhone(r.callee);
        if (p) outboundCalled.add(p);
      }
    }

    const enriched = leads.map(lead => {
      const phone = normPhone(lead.phone);
      const cf    = lead.customFields ?? [];
      const stage = cf.find(f => f.id === stageFieldId)?.value ?? "Unknown";
      const statusUpdate = envKey === "franchise"
        ? (notesMap[lead.id] ?? null)
        : (cf.find(f => f.id === STATUS_UPDATES_FIELD)?.value ?? null);
      const closed = CLOSED_KEYS.some(k => stage.toLowerCase().includes(k));
      const called = phone ? outboundCalled.has(phone) : false;
      const owner  = userMap[lead.assignedTo] ?? null;

      const callDetails = cdrRecords.filter(r => {
        const callee = normPhone(r.callee);
        const caller = normPhone(r.caller);
        return (callee === phone) || (caller === phone);
      }).map(r => ({
        direction: r.direction,
        time: r.startTime,
        disposition: r.lastLegDisposition,
        talkTime: r.talkTime,
        agent: r.callerName || r.callee,
      }));

      return {
        id:          lead.id,
        name:        `${lead.firstName ?? ""} ${lead.lastName ?? ""}`.trim() || lead.email || "Unknown",
        email:       lead.email,
        phone:       lead.phone,
        source:      lead.source,
        dateAdded:   lead.dateAdded,
        owner,
        stage,
        closed,
        called,
        callDetails,
        statusUpdate,
      };
    });

    const total    = enriched.length;
    const called   = enriched.filter(l => l.called).length;
    const closed   = enriched.filter(l => l.closed).length;
    const noPhone  = enriched.filter(l => !l.phone).length;

    res.json({ date, env: envKey, envLabel: ghl.label, summary: { total, called, notCalled: total - called, closed, noPhone }, leads: enriched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Diagnostic: check a phone number against CDR cache ───────────────────────
app.get("/api/debug-phone", async (req, res) => {
  try {
    const phone = normPhone(req.query.phone ?? "");
    if (!phone) return res.status(400).json({ error: "?phone= required" });
    const token = await get8x8Token();
    const records = await getCachedCDR(token);
    const matches = records.filter(r => normPhone(r.callee) === phone || normPhone(r.caller) === phone);
    const directions = {};
    for (const r of records) { directions[r.direction] = (directions[r.direction] || 0) + 1; }
    const times = records.map(r => r.startTime).filter(Boolean).sort();
    const cdrRange = { earliest: times[0] ?? null, latest: times[times.length - 1] ?? null };
    res.json({ phone, totalCDR: records.length, cdrRange, directions, matchCount: matches.length, matches: matches.slice(0, 10).map(r => ({ direction: r.direction, callee: r.callee, caller: r.caller, time: r.startTime, disposition: r.lastLegDisposition })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Diagnostic: inspect raw CDR records for a date (shows all fields) ────────
app.get("/api/debug-cdr", async (req, res) => {
  try {
    const date = req.query.date;
    const ext  = req.query.ext;
    if (!date) return res.status(400).json({ error: "?date=YYYY-MM-DD required" });
    const token = await get8x8Token();
    const records = await getCachedCDR(token);
    let dayRecords = records.filter(r => (r.startTime ?? "").startsWith(date));
    if (ext) dayRecords = dayRecords.filter(r => r.caller === ext || r.callee === ext);
    res.json({ date, ext: ext ?? null, totalOnDay: dayRecords.length, records: dayRecords });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard → http://localhost:${PORT}`));
