import dotenv from "dotenv";
dotenv.config();

const GHL_ENVS = {
  ma:        { token: process.env.GHL_MA_PIT_TOKEN, location: process.env.GHL_MA_LOCATION_ID, label: "M&A" },
  franchise: { token: process.env.GHL_FR_PIT_TOKEN, location: process.env.GHL_FR_LOCATION_ID, label: "Franchise" },
};
const X8_APIKEY    = process.env["8X8_API_KEY"];
const X8_USER      = process.env["8X8_USERNAME"];
const X8_PASS      = process.env["8X8_PASSWORD"];
const X8_PBX       = process.env["8X8_PBX_ID"];

function normPhone(p) {
  if (!p) return null;
  const d = p.replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d || null;
}

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
  if (!r.ok || !d.access_token) throw new Error(`8x8 auth: ${r.status} ${d.message ?? ""}`);
  _token = d.access_token;
  _tokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return _token;
}

async function fetchGHLLeads(startDate, endDate, ghlToken, ghlLocation) {
  const startMs = new Date(`${startDate}T00:00:00.000-04:00`).getTime();
  const endMs   = new Date(`${endDate}T23:59:59.999-04:00`).getTime();
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

// Fetch a 6-hour CDR block (startHour..endHour inclusive, e.g. 0–5, 6–11, 12–17, 18–23)
async function fetchBlockCDR(date, startHour, endHour, token) {
  const pad = n => String(n).padStart(2, "0");
  const s  = encodeURIComponent(`${date} ${pad(startHour)}:00:00`);
  const e  = encodeURIComponent(`${date} ${pad(endHour)}:59:59`);
  const tz = encodeURIComponent("America/New_York");
  const url = `https://api.8x8.com/analytics/work/v2/call-records?pbxId=${X8_PBX}&startTime=${s}&endTime=${e}&timeZone=${tz}&pageSize=100`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "8x8-apikey": X8_APIKEY } });
    if (!r.ok) return [];
    const d = await r.json();
    return d.data ?? [];
  } catch { return []; }
}

async function fetchDayCDR(date, token) {
  const blocks = [[0, 5], [6, 11], [12, 17], [18, 23]];
  const results = await Promise.all(blocks.map(([s, e]) => fetchBlockCDR(date, s, e, token)));
  const seen = new Set(), records = [];
  for (const list of results) {
    for (const r of list) {
      if (!seen.has(r.callId)) { seen.add(r.callId); records.push(r); }
    }
  }
  return records;
}

// Parse 8x8 startTime — format is "2026-04-29T05:42:21.254-0400" (no colon in offset)
function parseCallTime(t) {
  if (!t) return null;
  const ms = new Date(String(t)).getTime();
  if (!isNaN(ms)) return ms;
  // Fallback: treat as Eastern local time if no TZ info
  return new Date(String(t).replace(" ", "T") + "-04:00").getTime() || null;
}

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

function fmtEDT(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function pct(n, total) {
  if (!total) return "0%";
  return Math.round((n / total) * 100) + "%";
}

async function main() {
  const DAYS   = parseInt(process.argv[2] ?? "28");
  const envKey = (process.argv[3] ?? "ma").toLowerCase();
  const ghl    = GHL_ENVS[envKey] ?? GHL_ENVS.ma;
  if (!ghl.token || !ghl.location) { console.error(`GHL credentials for env "${envKey}" not configured in .env`); process.exit(1); }

  // Date range in America/New_York (handles DST correctly)
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const startDt  = new Date(`${todayStr}T12:00:00`);
  startDt.setDate(startDt.getDate() - (DAYS - 1));
  const startStr = startDt.toISOString().slice(0, 10);

  console.log(`\nLead-to-Call Time Report  [${ghl.label}]`);
  console.log(`Range : ${startStr} → ${todayStr}  (${DAYS} days, EDT)`);
  console.log("─".repeat(60));

  // Fetch GHL leads + 8x8 token in parallel
  console.log("Fetching GHL leads...");
  const [rawLeads, token] = await Promise.all([fetchGHLLeads(startStr, todayStr, ghl.token, ghl.location), get8x8Token()]);
  console.log(`  → ${rawLeads.length} leads total`);

  const STAGE_FIELD = "GcCxxdgNIXhXat8kK5j6";

  const leads = rawLeads.filter(lead => {
    // Drop weekend leads (check in Eastern time)
    const dayET = new Date(lead.dateAdded).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long" });
    if (dayET === "Saturday" || dayET === "Sunday") return false;

    // Drop leads that entered as "Discovery Scheduled" (pre-booked, no call needed)
    const cf = lead.customFields ?? [];
    const stage = (cf.find(f => f.id === STAGE_FIELD)?.value ?? "").toLowerCase();
    if (stage.includes("disc scheduled")) return false;

    return true;
  });

  const droppedWeekend   = rawLeads.filter(l => { const d = new Date(l.dateAdded).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long" }); return d === "Saturday" || d === "Sunday"; }).length;
  const droppedScheduled = rawLeads.length - leads.length - droppedWeekend;
  console.log(`  → ${droppedWeekend} removed (weekend), ${droppedScheduled} removed (already scheduled)`);
  console.log(`  → ${leads.length} leads remaining`);

  // Build list of dates in range (use noon UTC to avoid DST date shifts)
  const dates = [];
  const cur = new Date(`${startStr}T12:00:00Z`);
  const endD = new Date(`${todayStr}T12:00:00Z`);
  while (cur <= endD) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  // Fetch 8x8 CDR — 2 days per batch (= 8 concurrent block requests per batch)
  console.log(`Fetching 8x8 CDR (${dates.length} days, 4 blocks/day)...`);
  const allCDR = [];
  const seenIds = new Set();
  for (let i = 0; i < dates.length; i += 2) {
    const batch = dates.slice(i, i + 2);
    const results = await Promise.all(batch.map(dt => fetchDayCDR(dt, token)));
    for (const list of results) {
      for (const r of list) {
        if (!seenIds.has(r.callId)) { seenIds.add(r.callId); allCDR.push(r); }
      }
    }
    if (i + 2 < dates.length) await new Promise(r => setTimeout(r, 200));
    process.stdout.write(`\r  → ${Math.min(i + 2, dates.length)}/${dates.length} days fetched`);
  }
  console.log(`\n  → ${allCDR.length} CDR records`);

  // Build map: normalised phone → sorted list of outbound call timestamps
  const outboundByPhone = new Map();
  for (const r of allCDR) {
    if (r.direction !== "Outgoing") continue;
    const p = normPhone(r.callee);
    if (!p) continue;
    const t = parseCallTime(r.startTime);
    if (!t) continue;
    if (!outboundByPhone.has(p)) outboundByPhone.set(p, []);
    outboundByPhone.get(p).push(t);
  }
  for (const [, times] of outboundByPhone) times.sort((a, b) => a - b);

  // Match each lead to its first outbound call at or after lead creation
  const rows = leads.map(lead => {
    const phone   = normPhone(lead.phone);
    const addedMs = new Date(lead.dateAdded).getTime();
    const name    = `${lead.firstName ?? ""} ${lead.lastName ?? ""}`.trim() || lead.email || "Unknown";

    if (!phone) return { name, phone: null, addedMs, firstCallMs: null, responseMs: null, status: "No Phone" };

    const calls = outboundByPhone.get(phone) ?? [];
    // First outbound call >= lead creation (allow 5 min grace for near-simultaneous)
    const firstCallMs = calls.find(t => t >= addedMs - 300_000) ?? null;

    if (!firstCallMs) return { name, phone: lead.phone, addedMs, firstCallMs: null, responseMs: null, status: "Not Called" };

    return {
      name, phone: lead.phone, addedMs, firstCallMs,
      responseMs: Math.max(0, firstCallMs - addedMs),
      status: "Called",
    };
  }).sort((a, b) => b.addedMs - a.addedMs);

  // ── Print table ──────────────────────────────────────────────────────────────
  const W = [28, 14, 20, 20, 14];
  const div = "─".repeat(W.reduce((a, b) => a + b, 0) + W.length * 2);
  const headers = ["Lead Name", "Phone", "Lead Added (ET)", "First Called (ET)", "Response Time"];

  console.log("\n" + div);
  console.log(headers.map((h, i) => h.padEnd(W[i])).join("  "));
  console.log(div);

  for (const r of rows) {
    const cols = [
      r.name.slice(0, W[0] - 1),
      (r.phone ?? "—").slice(0, W[1] - 1),
      fmtEDT(r.addedMs),
      r.firstCallMs ? fmtEDT(r.firstCallMs) : r.status,
      r.responseMs !== null ? formatDuration(r.responseMs) : "—",
    ];
    console.log(cols.map((c, i) => (c ?? "").padEnd(W[i])).join("  "));
  }
  console.log(div);

  // ── Summary stats ────────────────────────────────────────────────────────────
  const called    = rows.filter(r => r.status === "Called");
  const notCalled = rows.filter(r => r.status === "Not Called");
  const noPhone   = rows.filter(r => r.status === "No Phone");

  console.log(`\nSummary`);
  console.log(`  Total leads   : ${rows.length}`);
  console.log(`  Called        : ${called.length}  (${pct(called.length, rows.length)})`);
  console.log(`  Not Called    : ${notCalled.length}  (${pct(notCalled.length, rows.length)})`);
  console.log(`  No Phone      : ${noPhone.length}`);

  if (called.length > 0) {
    const times = called.map(r => r.responseMs).sort((a, b) => a - b);
    const avg   = times.reduce((a, b) => a + b, 0) / times.length;
    const med   = times[Math.floor(times.length / 2)];
    const u1h   = times.filter(t => t <= 3_600_000).length;
    const u4h   = times.filter(t => t <= 14_400_000).length;
    const u24h  = times.filter(t => t <= 86_400_000).length;
    const u48h  = times.filter(t => t <= 172_800_000).length;

    console.log(`\nResponse Time (called leads only)`);
    console.log(`  Average       : ${formatDuration(avg)}`);
    console.log(`  Median        : ${formatDuration(med)}`);
    console.log(`  Fastest       : ${formatDuration(times[0])}`);
    console.log(`  Slowest       : ${formatDuration(times[times.length - 1])}`);
    console.log(`  Within 1 hour : ${u1h}  (${pct(u1h, called.length)})`);
    console.log(`  Within 4 hours: ${u4h}  (${pct(u4h, called.length)})`);
    console.log(`  Within 24 hrs : ${u24h}  (${pct(u24h, called.length)})`);
    console.log(`  Within 48 hrs : ${u48h}  (${pct(u48h, called.length)})`);
  }
  console.log("");
}

main().catch(err => { console.error("Error:", err.message); process.exit(1); });
