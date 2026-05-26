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

app.use(express.static(join(__dirname, "public")));

const GHL_TOKEN    = process.env.GHL_MA_PIT_TOKEN;
const GHL_LOCATION = process.env.GHL_MA_LOCATION_ID;
const X8_APIKEY    = process.env["8X8_API_KEY"];
const X8_USER      = process.env["8X8_USERNAME"];
const X8_PASS      = process.env["8X8_PASSWORD"];
const X8_PBX       = process.env["8X8_PBX_ID"];

const STAGE_FIELD         = "GcCxxdgNIXhXat8kK5j6";
const STATUS_UPDATES_FIELD = "1oF4PvG6yzDCu4vpPHWi";
const CLOSED_KEYS         = ["close", "won", "lost"];

// ── 8x8 token cache ──────────────────────────────────────────────────────────
let _token = null, _tokenExp = 0;
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
async function fetchGHLLeads(date) {
  const startMs = new Date(`${date}T00:00:00.000-04:00`).getTime();
  const endMs   = new Date(`${date}T23:59:59.999-04:00`).getTime();
  let contacts = [], startAfter = null, startAfterId = null;
  do {
    let url = `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&startDate=${startMs}&endDate=${endMs}&limit=100`;
    if (startAfter) url += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-07-28" } });
    const d = await r.json();
    contacts = contacts.concat(d.contacts ?? []);
    startAfter   = d.meta?.startAfter   ?? null;
    startAfterId = d.meta?.startAfterId ?? null;
  } while (startAfterId);
  return contacts;
}

// ── 8x8 CDR: fetch one hour window ───────────────────────────────────────────
async function fetchHourCDR(date, hour, token) {
  const pad = n => String(n).padStart(2, "0");
  const s = encodeURIComponent(`${date} ${pad(hour)}:00:00`);
  const e = encodeURIComponent(`${date} ${pad(hour)}:59:59`);
  const tz = encodeURIComponent("America/New_York");
  const url = `https://api.8x8.com/analytics/work/v2/call-records?pbxId=${X8_PBX}&startTime=${s}&endTime=${e}&timeZone=${tz}&pageSize=100`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "8x8-apikey": X8_APIKEY } });
    if (!r.ok) return [];
    const d = await r.json();
    return d.data ?? [];
  } catch (err) {
    console.error(`CDR hour ${hour} error:`, err.message);
    return [];
  }
}

// ── 8x8 CDR: fetch full day in small batches to avoid rate limits ─────────────
async function fetch8x8CDR(date, token) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const seen = new Set(), records = [];
  const BATCH = 4;
  for (let i = 0; i < hours.length; i += BATCH) {
    const batch = hours.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(h => fetchHourCDR(date, h, token)));
    for (const list of results) {
      for (const r of list) {
        if (!seen.has(r.callId)) { seen.add(r.callId); records.push(r); }
      }
    }
    if (i + BATCH < hours.length) await new Promise(r => setTimeout(r, 150));
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
    // Default to today in EDT (UTC-4)
    const date = req.query.date || new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [leads, token] = await Promise.all([fetchGHLLeads(date), get8x8Token()]);
    const cdrRecords = await fetch8x8CDR(date, token);

    // Build set of phones that were called (outgoing) or attempted
    const outboundCalled = new Set();
    for (const r of cdrRecords) {
      if (r.direction === "Outgoing") {
        const p = normPhone(r.callee);
        if (p) outboundCalled.add(p);
      }
    }

    const enriched = leads.map(lead => {
      const phone = normPhone(lead.phone);
      const cf    = lead.customFields ?? [];
      const sf    = cf.find(f => f.id === STAGE_FIELD);
      const stage = sf?.value ?? "Unknown";
      const suf   = cf.find(f => f.id === STATUS_UPDATES_FIELD);
      const statusUpdate = suf?.value ?? null;
      const closed = CLOSED_KEYS.some(k => stage.toLowerCase().includes(k));
      const called = phone ? outboundCalled.has(phone) : false;

      // Find matching CDR records for call details
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
        assignedTo:  lead.assignedTo,
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

    res.json({ date, summary: { total, called, notCalled: total - called, closed, noPhone }, leads: enriched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard → http://localhost:${PORT}`));
