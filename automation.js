require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { sendBugEmail, sendApprovalEmail } = require("./email");
const { sendAlerts }         = require("./alerts");
const crypto                 = require("crypto");

const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const genAI2 = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY);
const geminiModels = [
  // Key 1
  { model: genAI.getGenerativeModel({ model: "gemini-2.5-flash" }),       name: "Gemini 2.5 Flash [K1]"      },
  { model: genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" }),  name: "Gemini 2.5 Flash Lite [K1]" },
  { model: genAI.getGenerativeModel({ model: "gemini-flash-lite-latest"}),name: "Gemini Flash Lite [K1]"     },
  { model: genAI.getGenerativeModel({ model: "gemini-2.0-flash" }),       name: "Gemini 2.0 Flash [K1]"      },
  // Key 2 (separate quota)
  { model: genAI2.getGenerativeModel({ model: "gemini-2.5-flash" }),      name: "Gemini 2.5 Flash [K2]"      },
  { model: genAI2.getGenerativeModel({ model: "gemini-2.5-flash-lite" }), name: "Gemini 2.5 Flash Lite [K2]" },
  { model: genAI2.getGenerativeModel({ model: "gemini-flash-lite-latest"}),name: "Gemini Flash Lite [K2]"    },
  { model: genAI2.getGenerativeModel({ model: "gemini-2.0-flash" }),      name: "Gemini 2.0 Flash [K2]"      },
];

const JIRA_AUTH = Buffer.from(
  `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
).toString("base64");

const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ── Pure Node.js HTTPS helper — works on Windows, Linux, and Render ───────────
function jiraRequest({ method = "GET", urlPath, body = null }) {
  return new Promise((resolve, reject) => {
    const base   = new URL(process.env.JIRA_BASE_URL);
    const data   = body ? JSON.stringify(body) : null;
    const opts   = {
      hostname: base.hostname,
      port:     base.port || 443,
      path:     urlPath,
      method,
      headers: {
        "Authorization": `Basic ${JIRA_AUTH}`,
        "Accept":        "application/json",
        "Content-Type":  "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      },
      rejectUnauthorized: false   // handles Zscaler / corporate proxy certs
    };
    const req = https.request(opts, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        } else {
          reject(new Error(`${res.statusCode}::${raw.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Create Jira issue via HTTPS POST ──────────────────────────────────────────
async function postJiraHTTPS(fields) {
  const result = await jiraRequest({
    method:  "POST",
    urlPath: "/rest/api/3/issue",
    body:    { fields }
  });
  return result.key;
}

// ── Category config ───────────────────────────────────────────────────────────
const CATEGORY_CONFIG = {
  Security:    { priority: "Highest", emoji: "🔴", logToJira: true,  dueDays: 3,  storyPoints: 8 },
  Backend:     { priority: "High",    emoji: "🟠", logToJira: true,  dueDays: 7,  storyPoints: 5 },
  Frontend:    { priority: "Medium",  emoji: "🟡", logToJira: true,  dueDays: 14, storyPoints: 3 },
  Performance: { priority: "Medium",  emoji: "🔵", logToJira: true,  dueDays: 14, storyPoints: 3 },
  Trivial:     { priority: "Low",     emoji: "⚪", logToJira: false, dueDays: 30, storyPoints: 1 }
};

// ── Fetch Jira context (assignee + active sprint) once at first ticket ─────────
let _jiraAccountId   = process.env.JIRA_ACCOUNT_ID || null;
let _jiraSprintId    = null;
let _jiraContextDone = false;

async function loadJiraContext() {
  if (_jiraContextDone) return;
  _jiraContextDone = true;
  try {
    const me = await jiraRequest({ urlPath: "/rest/api/3/myself" });
    if (me.accountId) {
      _jiraAccountId = me.accountId;
      console.log(`   👤 Jira assignee: ${_jiraAccountId}`);
    }
  } catch (_) {}
  try {
    const spr = await jiraRequest({ urlPath: "/rest/agile/1.0/board/1/sprint?state=active&maxResults=1" });
    if (spr.values && spr.values.length > 0) {
      _jiraSprintId = spr.values[0].id;
      console.log(`   🏃 Active sprint : ${_jiraSprintId}`);
    }
  } catch (_) {}
}

// ── Rich ADF description builder ──────────────────────────────────────────────
function buildADF({ title, testCase, area, category, expected, actual, classificationReason, brokenCode, fixes }) {
  const emoji = (CATEGORY_CONFIG[category] || {}).emoji || "🐛";

  const p  = (txt) => ({ type: "paragraph", content: [{ type: "text", text: String(txt || "—") }] });
  const h  = (lvl, txt) => ({ type: "heading", attrs: { level: lvl }, content: [{ type: "text", text: txt }] });
  const hr = () => ({ type: "rule" });
  const row = (label, value) => ({
    type: "tableRow",
    content: [
      { type: "tableHeader", attrs: {}, content: [p(label)] },
      { type: "tableCell",   attrs: {}, content: [p(value)] }
    ]
  });
  const table = (rows) => ({
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: rows
  });
  const bullets = (items) => ({
    type: "bulletList",
    content: (items || []).map(item => ({
      type: "listItem",
      content: [p(item)]
    }))
  });

  return {
    type: "doc", version: 1,
    content: [
      h(2, `${emoji} ${title}`),
      hr(),
      h(3, "📋 Test Details"),
      table([
        row("Test Case ID",         testCase  || "—"),
        row("Area",                 area      || category || "—"),
        row("Severity",             "🔴 ERROR"),
        row("Category",             `${emoji} ${category}`),
        row("Expected Behaviour",   expected  || "—"),
        row("Actual Behaviour",     actual    || "—"),
      ]),
      h(3, "🤖 AI Classification"),
      p(classificationReason || "—"),
      h(3, "🔧 Root Cause"),
      p(brokenCode || "—"),
      h(3, "✅ Suggested Fixes"),
      bullets(fixes && fixes.length ? fixes : ["Review and fix the identified issue."]),
      hr(),
      p(`Auto-detected by DemoShop AI Bug Pipeline on ${new Date().toLocaleString()}`)
    ]
  };
}

// ── Local deduplication cache (jira-dedup-cache.json) ─────────────────────────
const DEDUP_CACHE_FILE = path.join(__dirname, "jira-dedup-cache.json");

function loadDedupCache() {
  try { return JSON.parse(fs.readFileSync(DEDUP_CACHE_FILE, "utf8")); } catch (_) { return {}; }
}
function saveDedupCache(cache) {
  try { fs.writeFileSync(DEDUP_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8"); } catch (_) {}
}
function normalizeTitleForDedup(title) {
  return title
    .replace(/^\[[\w\s]+\]\s*/i, "")             // remove [FRONTEND] etc.
    .replace(/^[\w]+-[\d-]+\s*[—\-]\s*/i, "")   // remove US-01-01 — or MT-01 —
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
function normalizeErrorForDedup(errorValue) {
  if (!errorValue) return null;
  return "err::" + errorValue
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
// Check by BOTH test name AND actual error value — catches same bug even if AI
// generated a different test name on a different run
function checkDedupCache(title, errorValue) {
  const cache    = loadDedupCache();
  const titleKey = normalizeTitleForDedup(title);
  const errorKey = normalizeErrorForDedup(errorValue);
  return cache[titleKey] || (errorKey ? cache[errorKey] : null) || null;
}
// Increment the repeat counter for both keys and return the new count
function incrementDedupCount(title, errorValue) {
  const cache    = loadDedupCache();
  const titleKey = normalizeTitleForDedup(title);
  const errorKey = normalizeErrorForDedup(errorValue);
  let entry = cache[titleKey] || (errorKey ? cache[errorKey] : null);
  if (!entry) return 1;
  entry.count = (entry.count || 0) + 1;
  if (cache[titleKey]) cache[titleKey] = entry;
  if (errorKey && cache[errorKey]) cache[errorKey] = entry;
  saveDedupCache(cache);
  return entry.count;
}
// Save under BOTH keys so future runs are caught whichever way they arrive
// originalTitle and bugDescription are stored for semantic dedup comparison
function saveToDedupCache(title, errorValue, jiraKey, jiraUrl, originalTitle, bugDescription) {
  const cache = loadDedupCache();
  const entry  = {
    jiraKey, jiraUrl,
    createdAt: new Date().toISOString(),
    count: 1,
    originalTitle:  originalTitle  || title,
    bugDescription: bugDescription || ""
  };
  cache[normalizeTitleForDedup(title)] = entry;
  const errorKey = normalizeErrorForDedup(errorValue);
  if (errorKey) cache[errorKey] = entry;
  saveDedupCache(cache);
}

// ── Pending approvals — self-contained signed tokens (no file storage) ───────
// Bug data is encoded directly in the URL so Render restarts don't lose tokens.

const TOKEN_SECRET = process.env.TOKEN_SECRET || process.env.GEMINI_API_KEY || "qa-pipeline-secret";

function createApprovalToken(bugData) {
  const payload = Buffer.from(JSON.stringify(bugData)).toString("base64url");
  const sig     = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex").slice(0, 16);
  return `${payload}.${sig}`;
}

function verifyApprovalToken(token) {
  try {
    const [payload, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex").slice(0, 16);
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (_) { return null; }
}

// Keep file-based store only to track already-processed tokens (prevent double-approve)
const PENDING_APPROVALS_FILE = path.join(__dirname, "pending-approvals.json");
function loadProcessedTokens() {
  try { return JSON.parse(fs.readFileSync(PENDING_APPROVALS_FILE, "utf8")); } catch (_) { return {}; }
}
function markTokenProcessed(sig, status) {
  const store = loadProcessedTokens();
  store[sig] = { status, processedAt: new Date().toISOString() };
  try { fs.writeFileSync(PENDING_APPROVALS_FILE, JSON.stringify(store, null, 2)); } catch (_) {}
}
function isTokenProcessed(sig) {
  return loadProcessedTokens()[sig] || null;
}

// Legacy wrappers kept so nothing else needs to change
function addPendingApproval(token, bugData) { /* data is in the token itself now */ }
function getPendingApproval(token) {
  const bugData = verifyApprovalToken(token);
  if (!bugData) return null;
  const sig = token.split(".")[1];
  const processed = isTokenProcessed(sig);
  return { status: processed ? processed.status : "pending", bugData };
}
function markApprovalStatus(token, status) {
  const sig = token.split(".")[1];
  markTokenProcessed(sig, status);
}

// ── Semantic duplicate check — AI compares new bug against existing titles ────
// Returns the Jira key of the matching existing bug, or null if genuinely new.
async function semanticDedupCheck(newTitle, newDescription) {
  const cache = loadDedupCache();
  const existingBugs = Object.entries(cache)
    .filter(([key, val]) => val.jiraKey && !key.startsWith("err::") && val.originalTitle)
    .slice(0, 30)
    .map(([, val]) => `• [${val.jiraKey}] ${val.originalTitle}${val.bugDescription ? " — " + val.bugDescription : ""}`);

  if (existingBugs.length === 0) return null;

  const prompt = `You are a QA deduplication expert. Decide if the NEW BUG below describes the same issue as any EXISTING BUG, even if the wording is different.

NEW BUG: ${newTitle}
Description: ${newDescription || ""}

EXISTING BUGS:
${existingBugs.join("\n")}

Rules:
- Mark as duplicate only when the root cause AND the failing behaviour are the same.
- Different symptoms in the same feature area are NOT duplicates.
- Respond with JSON only (no markdown).

If duplicate: {"duplicate": true, "matchingKey": "SCRUM-XXX", "reason": "one sentence"}
If new:       {"duplicate": false}`;

  try {
    const rawText = (await generateWithRetry(prompt)).trim()
      .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const result = JSON.parse(rawText);
    if (result.duplicate && result.matchingKey) {
      console.log(`   🧠 Semantic dedup: matches ${result.matchingKey} — ${result.reason}`);
      return result.matchingKey;
    }
  } catch (err) {
    console.log(`   ⚠️  Semantic dedup skipped: ${err.message.slice(0, 80)}`);
  }
  return null;
}

// ── Jira search fallback — catches tickets NOT yet in local cache ──────────────
async function searchJiraForDuplicate(title) {
  const keywords = title
    .replace(/^\[[\w\s]+\]\s*/i, "")
    .replace(/^[\w]+-[\d-]+\s*[—\-]\s*/i, "")
    .replace(/[^a-z0-9 ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(w => w.length > 3)
    .slice(0, 5)
    .join(" ");
  // If keyword extraction produced nothing (very short or noisy titles),
  // try a phrase search using the full title as a fallback. That improves
  // matching for short summaries and reduces accidental duplicate creation.
  if (!keywords) {
    try {
      const phrase = title.replace(/"/g, '\\"');
      const jqlPhrase = `project = "${process.env.JIRA_PROJECT_KEY}" AND summary ~ "${phrase}" ORDER BY created DESC`;
      const encPhrase = encodeURIComponent(jqlPhrase);
      const resPhrase = await jiraRequest({ urlPath: `/rest/api/3/search?jql=${encPhrase}&maxResults=1&fields=key` });
      if (resPhrase.issues && resPhrase.issues.length > 0) return resPhrase.issues[0].key;
    } catch (_) {}
    return null;
  }

  const jql = `project = "${process.env.JIRA_PROJECT_KEY}" AND summary ~ "${keywords.replace(/"/g, '\\"')}" ORDER BY created DESC`;
  const enc = encodeURIComponent(jql);

  try {
    const result = await jiraRequest({ urlPath: `/rest/api/3/search?jql=${enc}&maxResults=1&fields=key` });
    if (result.issues && result.issues.length > 0) return result.issues[0].key;
    return null;
  } catch (_) {
    return null;
  }
}

// ── Jira ticket creator ───────────────────────────────────────────────────────
async function createJiraTicket({ title, adfDescription, priority, labels, category, dueDays, storyPoints }) {
  await loadJiraContext();

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (dueDays || 14));
  const dueDateStr = dueDate.toISOString().split("T")[0];

  const base = {
    project:     { key: process.env.JIRA_PROJECT_KEY },
    summary:     title,
    description: adfDescription,
    duedate:     dueDateStr,
    customfield_10016: storyPoints || 3,   // Story point estimate
    labels
  };

  if (_jiraAccountId) base.assignee = { accountId: _jiraAccountId };
  if (_jiraSprintId)  base.customfield_10020 = { id: _jiraSprintId };

  const attempts = [
    { ...base, issuetype: { name: "Bug"  }, priority: { name: priority } },
    { ...base, issuetype: { name: "Task" }, priority: { name: priority } },
    { ...base, issuetype: { name: "Bug"  }, priority: { name: priority }, customfield_10016: undefined, customfield_10020: undefined },
    { ...base, issuetype: { name: "Task" }, customfield_10016: undefined, customfield_10020: undefined },
    { project: base.project, summary: base.summary, description: base.description, issuetype: { name: "Task" } },
  ];

  let lastErr = "";
  for (const fields of attempts) {
    try {
      const key = await postJiraHTTPS(fields);
      const ticketUrl = `${process.env.JIRA_BASE_URL}/browse/${key}`;
      console.log(`   🎫 Jira ticket created: ${key} → ${ticketUrl}`);
      return ticketUrl;
    } catch (err) {
      lastErr = err.message;
      const status = lastErr.split("::")[0];
      if (status === "401" || status === "403") {
        console.log(`   ❌ Jira auth failed — check JIRA_EMAIL and JIRA_API_TOKEN in .env`);
        break;
      }
      console.log(`   ↩️  Retrying with simpler fields…`);
    }
  }

  throw new Error(`Jira failed — ${lastErr.slice(0, 200)}`);
}

function getAgingInfo(firstSeen, level) {
  const daysOld = Math.floor((Date.now() - new Date(firstSeen)) / 86400000);
  const isUrgent = (level === "error" || level === "fatal") && daysOld >= 15;
  return { daysOld, isUrgent };
}

// ── Rule-based classifier (last resort when ALL AI models fail) ───────────────
function ruleBasedClassify(failures) {
  const results = failures.map(f => {
    const text = `${f.title} ${f.errorValue} ${f.culprit}`.toLowerCase();

    // Use the test's declared area first — it's the most reliable signal
    let category = CATEGORY_CONFIG[f.area] ? f.area : "Frontend";
    let reason   = f.area && CATEGORY_CONFIG[f.area]
      ? `Classified as ${f.area} based on test area (AI models temporarily unavailable)`
      : "Default classification — AI models temporarily unavailable";

    // Only override if the actual error text strongly contradicts the area
    if (!f.area || !CATEGORY_CONFIG[f.area]) {
      if (/password|card|credit|auth|token|secret|leak|xss|inject/.test(text)) {
        category = "Security";
        reason   = "Contains security-sensitive keywords (password/card/auth)";
      } else if (/calculat|total|sum|price|shipping|tax|backend|server|logic|validat/.test(text)) {
        category = "Backend";
        reason   = "Relates to calculation or server-side validation logic";
      } else if (/timeout|enetunreach|slow|performance|connect/.test(text)) {
        category = "Performance";
        reason   = "Relates to speed or connectivity failure";
      } else if (/capitalisa|casing|whitespace|cosmetic|label/.test(text)) {
        category = "Trivial";
        reason   = "Cosmetic or non-critical text mismatch";
      }
    }

    category = resolveCategory(f);
    reason = `Classified as ${category} from the test name, expected result, and actual failure text`;

    return {
      id:                   f.id,
      category,
      classificationReason: reason,
      brokenCode:           `Issue in ${f.culprit}: ${f.errorValue}`,
      fixes:                ["Review and fix the identified issue", "Add automated test coverage", "Verify fix in staging"],
      emailBody:            `Bug detected: ${f.title}. Actual: ${f.errorValue}`
    };
  });

  return JSON.stringify({ results });
}

// ── AI call: Gemini (tries each model in order) ───────────────────────────────
async function generateWithRetry(prompt, maxRetries = 4) {
  const cleanAndValidateJson = (raw) => {
    const cleaned = String(raw || "")
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    JSON.parse(cleaned);
    return cleaned;
  };

  const claudeKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  const claudeModel = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

  if (claudeKey) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: claudeKey });
      const msg = await anthropic.messages.create({
        model: claudeModel,
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }]
      });
      const raw = msg.content
        .map(part => part.type === "text" ? part.text : "")
        .join("\n");
      const cleaned = cleanAndValidateJson(raw);
      console.log(`   Provider: Claude (${claudeModel})`);
      return cleaned;
    } catch (err) {
      console.log(`   Claude failed: ${err.message.slice(0, 140)} - switching to Gemini...`);
    }
  } else {
    console.log("   Claude not configured - using Gemini...");
  }

  for (let m = 0; m < geminiModels.length; m++) {
    const { model, name: modelName } = geminiModels[m];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        const cleaned = cleanAndValidateJson(result.response.text());
        console.log(`   Provider: ${modelName}`);
        return cleaned;
      } catch (err) {
        const isQuota = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        const is429 = err.message?.includes("429");
        const is503 = err.message?.includes("503");
        const is404 = err.message?.includes("404");
        const isRetryable = (is429 || is503) && !isQuota;

        if (isQuota || is404) {
          const reason = is404 ? "not available" : "quota exhausted";
          console.log(`   ${modelName} ${reason} - switching to next model...`);
          break;
        }

        if (is503 && attempt < maxRetries) {
          console.log(`   ${modelName} overloaded - switching to next model...`);
          break;
        }

        if (!isRetryable || attempt === maxRetries) {
          console.log(`   ${modelName} failed (attempt ${attempt}): ${err.message.slice(0, 120)}`);
          if (m === geminiModels.length - 1) throw err;
          break;
        }

        const match = err.message.match(/retry in (\d+(?:\.\d+)?)s/i);
        const waitMs = Math.min(match ? Math.ceil(parseFloat(match[1])) * 1000 + 500 : 4000, 5000);
        console.log(`   ${modelName} rate limited - waiting ${Math.ceil(waitMs / 1000)}s then retrying (${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  throw new Error("Claude and Gemini are unavailable or returned invalid JSON");
}

// ── Infer the real category from test name + error — never trust area=Frontend blindly ──
function resolveCategory(f) {
  const text = `${f.title || ""} ${f.expected || ""} ${f.errorValue || ""}`.toLowerCase();

  if (/(locator\.(click|fill|isvisible)|element not found|not visible|not found in inventory|not found in cart|product not found|product.*not.*visible|button.*not.*available|button.*did not appear|cart item.*not found|cart badge shows|remove button|could not click|selector|rendered|ui check failed)/.test(text))
    return "Frontend";

  if (/password.*mask|mask.*password|autocomplete|novalidate|sensitive.*data|html.*password|sql.?inject|xss|csrf|token|secret|auth bypass|without.*auth.*40[13]|admin.*40[13]|https.*redirect|http.*https/.test(text))
    return "Security";

  if (/(response.?time|load.?time|within \d+\s*(ms|millisec|second)|3 second|1 second|800ms|500ms|speed|slow|page.*timeout|api.*timeout|request.*timeout)/.test(text) &&
      !/(locator|click|button|element|selector|not visible|not found)/.test(text))
    return "Performance";

  if (/(api.*respond|endpoint|status.*4\d\d|status.*5\d\d|returns.*\d\d\d|server|backend|calculation|total|sum|price|shipping|tax|coupon|order.*accepted|redirect.*wrong|wrong.*redirect|form.*submit|server.*valid|valid\s+(login|credentials)|login\s+with\s+valid|invalid\s+credentials|wrong\s+credentials|locked\s+out|credentials.*accepted|login.*rejected|login.*did not redirect)/.test(text))
    return "Backend";

  if (/page.?title|browser.*title|copyright|footer.*text|button.*text.*say|says.*sign.?in|says.*login|favicon|meta.*robot|capitalisa/.test(text))
    return "Trivial";

  if (f.area && f.area !== "Frontend" && CATEGORY_CONFIG[f.area]) return f.area;

  return "Frontend";
}

// ── BATCH pipeline — classifies ALL failures then sends for approval ──────────
// failures: [{ id, title, errorType, errorValue, culprit, expected, area, testCase }]
// onResult(result) is called immediately after each ticket is created/skipped
async function runBatchAutomation(failures, onResult = null) {
  if (failures.length === 0) return [];

  console.log(`\n🤖 Sending ${failures.length} failure(s) to AI for descriptions…\n`);

  const prompt = `
You are a senior QA engineer. For each failing test, write a short professional description of why it failed and how to fix it.
Do NOT change the category — it is already set. Just write the reason and fixes.

${failures.map((f, i) => `
[${i + 1}] ID: ${f.id}
    Category  : ${resolveCategory(f)}
    Test name : ${f.title}
    Expected  : ${f.expected}
    Actual    : ${f.errorValue}
`).join("")}

Reply ONLY with valid JSON:
{
  "results": [
    {
      "id": "TC-XX",
      "classificationReason": "One sentence: which layer broke and why",
      "brokenCode": "One sentence: what specifically needs fixing",
      "fixes": ["Fix 1", "Fix 2", "Fix 3"],
      "emailBody": "Professional 2-sentence summary for the dev team"
    }
  ]
}`;

  let descriptions = {};
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 40000));
    const rawText = (await Promise.race([generateWithRetry(prompt), timeout])).trim()
      .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(rawText);
    const results = parsed.results ?? parsed;
    for (const r of results) descriptions[r.id] = r;
  } catch (_) {
    console.log(`\n   ⚠️  AI description unavailable — using defaults`);
  }

  // Build classifications — resolveCategory reads test name + error, never blindly uses area
  const classifications = failures.map(f => {
    const category = resolveCategory(f);
    const d = descriptions[f.id] || {};
    return {
      id:                   f.id,
      category,
      classificationReason: d.classificationReason || `${category} issue: ${f.errorValue?.slice(0, 80) || "check failed"}`,
      brokenCode:           d.brokenCode           || `Issue in ${f.culprit || f.id}: ${f.errorValue?.slice(0, 80) || ""}`,
      fixes:                d.fixes                || ["Review and fix the identified issue", "Add automated test coverage", "Verify fix in staging"],
      emailBody:            d.emailBody            || `Bug detected in ${category}: ${f.title}. Actual: ${f.errorValue?.slice(0, 100) || ""}`
    };
  });

  const output = [];

  for (const ai of classifications) {
    const failure = failures.find(f => f.id === ai.id);
    if (!failure) continue;

    if (!CATEGORY_CONFIG[ai.category]) ai.category = "Frontend";
    const catConfig = CATEGORY_CONFIG[ai.category];

    console.log(`   ${catConfig.emoji} ${ai.id} → ${ai.category}: ${ai.classificationReason}`);

    if (!catConfig.logToJira) {
      console.log(`   ⏭️  ${ai.id}: Trivial — skipping Jira`);
      const item = { id: ai.id, logged: false, category: ai.category, reason: ai.classificationReason, jiraUrl: null };
      output.push(item);
      if (onResult) await onResult(item);
      continue;
    }

    try {
      const ticketTitle = `[${ai.category.toUpperCase()}] ${failure.title}`;

      // ── Step 1: Check local cache (instant — catches tickets from previous runs) ─
      const cached = checkDedupCache(ticketTitle, failure.errorValue);
      if (cached) {
        const repeatCount = incrementDedupCount(ticketTitle, failure.errorValue);
        console.log(`   🔁 ${ai.id} → Repeated ×${repeatCount} — already logged as ${cached.jiraKey} (skipping)`);
        const item = { id: ai.id, logged: false, duplicate: true, duplicateKey: cached.jiraKey,
                       repeatCount, category: ai.category, reason: ai.classificationReason, jiraUrl: cached.jiraUrl };
        output.push(item);
        if (onResult) await onResult(item);
        continue;
      }

      // ── Step 2: Search Jira (catches old tickets not yet in local cache) ──────
      const existingKey = await searchJiraForDuplicate(ticketTitle);
      if (existingKey) {
        const existingUrl = `${process.env.JIRA_BASE_URL}/browse/${existingKey}`;
        saveToDedupCache(ticketTitle, failure.errorValue, existingKey, existingUrl, ticketTitle);
        const repeatCount = incrementDedupCount(ticketTitle, failure.errorValue);
        console.log(`   🔁 ${ai.id} → Repeated ×${repeatCount} — already logged as ${existingKey} (skipping)`);
        const item = { id: ai.id, logged: false, duplicate: true, duplicateKey: existingKey,
                       repeatCount, category: ai.category, reason: ai.classificationReason, jiraUrl: existingUrl };
        output.push(item);
        if (onResult) await onResult(item);
        continue;
      }

      // ── Step 3: Semantic AI dedup — catches same bug with different wording ──
      const semDescription = `${failure.expected} vs ${failure.errorValue}`;
      const semanticMatch  = await semanticDedupCheck(ticketTitle, semDescription);
      if (semanticMatch) {
        const existingUrl = `${process.env.JIRA_BASE_URL}/browse/${semanticMatch}`;
        saveToDedupCache(ticketTitle, failure.errorValue, semanticMatch, existingUrl, ticketTitle, semDescription);
        const repeatCount = incrementDedupCount(ticketTitle, failure.errorValue);
        console.log(`   🔁 ${ai.id} → Semantic duplicate ×${repeatCount} of ${semanticMatch} (skipping)`);
        const item = { id: ai.id, logged: false, duplicate: true, duplicateKey: semanticMatch,
                       repeatCount, category: ai.category, reason: ai.classificationReason, jiraUrl: existingUrl };
        output.push(item);
        if (onResult) await onResult(item);
        continue;
      }

      // ── Step 4: Genuinely new bug — send approval email; tester decides ──────
      const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;

      const adfDescription = buildADF({
        title:                failure.title,
        testCase:             failure.testCase || failure.id,
        area:                 failure.area || ai.category,
        category:             ai.category,
        expected:             failure.expected,
        actual:               failure.errorValue,
        classificationReason: ai.classificationReason,
        brokenCode:           ai.brokenCode,
        fixes:                ai.fixes
      });

      // Encode all bug data into the token itself — survives Render restarts
      const bugData = {
        title:          failure.title,
        ticketTitle,
        category:       ai.category,
        expected:       failure.expected,
        actual:         failure.errorValue,
        reason:         ai.classificationReason,
        fixes:          ai.fixes,
        testCase:       failure.testCase || failure.id,
        errorValue:     failure.errorValue,
        bugDescription: ai.classificationReason,
        adfDescription,
        priority:       catConfig.priority,
        labels:         ["bug", "demoshop", ai.category.toLowerCase()],
        dueDays:        catConfig.dueDays,
        storyPoints:    catConfig.storyPoints
      };
      const token      = createApprovalToken(bugData);
      const approveUrl = `${serverUrl}/approve/${token}`;
      const declineUrl = `${serverUrl}/decline/${token}`;
      addPendingApproval(token, bugData); // no-op now, kept for compatibility

      await sendApprovalEmail({
        title:      failure.title,
        category:   ai.category,
        expected:   failure.expected,
        actual:     failure.errorValue,
        reason:     ai.classificationReason,
        fixes:      ai.fixes,
        testCase:   failure.testCase || failure.id,
        approveUrl,
        declineUrl
      });

      console.log(`   📬 ${ai.id} → Approval email sent (token: ${token.slice(0, 8)}…)`);
      const item = { id: ai.id, logged: false, pendingApproval: true,
                     category: ai.category, reason: ai.classificationReason, jiraUrl: null };
      output.push(item);
      if (onResult) await onResult(item);

    } catch (err) {
      console.log(`   ⚠️  Jira error for ${ai.id}: ${err.message.slice(0, 200)}`);
      const item = { id: ai.id, logged: false, category: ai.category, reason: ai.classificationReason, jiraUrl: null };
      output.push(item);
      if (onResult) await onResult(item);
    }
  }

  return output;
}

// ── Single pipeline (used by playwright-runner & generate-tests) ──────────────
async function runAutomation(payload) {
  const issue      = payload.data?.issue || payload;
  const errorTitle = issue.title       || "Unknown Error";
  const errorLevel = issue.level       || "error";
  const culprit    = issue.culprit     || "Unknown location";
  const firstSeen  = issue.firstSeen   || new Date().toISOString();
  const errorType  = issue.metadata?.type  || errorTitle;
  const errorValue = issue.metadata?.value || "";
  const project    = issue.project?.name   || "DemoShop";

  const { daysOld, isUrgent } = getAgingInfo(firstSeen, errorLevel);

  const prompt = `
You are a senior QA engineer reviewing a bug report from an e-commerce app.

Project : ${project}
Error   : ${errorType} — ${errorValue}
Location: ${culprit}
Severity: ${errorLevel}
Open for: ${daysOld} day(s)

Classify this bug using these overrides first:
1. SECURITY: title/error mentions SQL injection, XSS, CSRF, injection, auth bypass, data exposure → Security
2. BACKEND: title mentions login, authentication, credentials, password, sign in, redirect → Backend

Categories:
- Security    → SQL injection not blocked, XSS not sanitized, auth bypass, credentials exposed
- Backend     → login/auth failure, wrong redirect, API wrong data, server-side logic broken
- Frontend    → UI element missing/not rendered, form field absent, element not visible
- Performance → connection timeout, page load timeout, slow response
- Trivial     → minor cosmetic difference, non-critical text mismatch

Reply ONLY with valid JSON (no markdown, no code fences):
{
  "category": "Security|Backend|Frontend|Performance|Trivial",
  "classificationReason": "One sentence explaining why this category was chosen",
  "brokenCode": "One sentence describing what code is broken and why",
  "fixes": ["Fix 1", "Fix 2", "Fix 3"],
  "emailBody": "Professional 2-sentence summary of this bug for the dev team"
}`;

  const rawText = (await generateWithRetry(prompt)).trim()
    .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const parsed  = JSON.parse(rawText);

  const inferredCategory = resolveCategory({
    title: errorTitle,
    expected: issue.metadata?.expected || "",
    errorValue,
    area: issue.metadata?.area || "",
    culprit
  });
  if (!CATEGORY_CONFIG[parsed.category] || inferredCategory === "Frontend" || inferredCategory === "Performance") {
    parsed.category = inferredCategory;
  }

  if (!CATEGORY_CONFIG[parsed.category]) parsed.category = "Frontend";
  const ai = parsed;
  console.log(`   🤖 AI classification complete`);

  const catConfig = CATEGORY_CONFIG[ai.category] || CATEGORY_CONFIG.Frontend;
  console.log(`   ${catConfig.emoji} Category : ${ai.category}`);
  console.log(`   📋 Reason   : ${ai.classificationReason}`);

  if (!catConfig.logToJira) {
    console.log(`   ⏭️  Skipping Jira — Trivial bug`);
    return { logged: false, category: ai.category, reason: ai.classificationReason, jiraUrl: null };
  }

  const priority = isUrgent ? "Highest" : catConfig.priority;
  const labels   = ["bug", "demoshop", ai.category.toLowerCase(), ...(isUrgent ? ["URGENT"] : [])];

  try {
    const jiraUrl = await createJiraTicket({
      title:          `[${ai.category.toUpperCase()}] ${errorTitle}`,
      adfDescription: buildADF({
        title:                errorTitle,
        testCase:             issue.metadata?.testCase || culprit,
        area:                 issue.metadata?.area || ai.category,
        category:             ai.category,
        expected:             issue.metadata?.expected || "See test case",
        actual:               errorValue,
        classificationReason: ai.classificationReason,
        brokenCode:           ai.brokenCode,
        fixes:                ai.fixes
      }),
      priority,
      labels,
      category:    ai.category,
      dueDays:     catConfig.dueDays,
      storyPoints: catConfig.storyPoints
    });
    return { logged: true, category: ai.category, reason: ai.classificationReason, jiraUrl, fixes: ai.fixes };
  } catch (err) {
    console.log(`   ⚠️  Jira error: ${err.message}`);
    return { logged: false, category: ai.category, reason: ai.classificationReason, jiraUrl: null };
  }
}

// ── Approve: create Jira ticket from a pending approval ───────────────────────
async function processApproval(token) {
  const approval = getPendingApproval(token);
  if (!approval) throw new Error("Approval token not found");
  if (approval.status !== "pending") throw new Error(`Already ${approval.status}`);

  const { bugData } = approval;

  const jiraUrl = await createJiraTicket({
    title:          bugData.ticketTitle,
    adfDescription: bugData.adfDescription,
    priority:       bugData.priority,
    labels:         bugData.labels,
    category:       bugData.category,
    dueDays:        bugData.dueDays,
    storyPoints:    bugData.storyPoints
  });

  const jiraKey = jiraUrl.split("/browse/")[1] || jiraUrl;
  saveToDedupCache(bugData.ticketTitle, bugData.errorValue, jiraKey, jiraUrl, bugData.ticketTitle, bugData.bugDescription);
  markApprovalStatus(token, "approved");

  await sendAlerts({
    title:    bugData.title,
    category: bugData.category,
    expected: bugData.expected,
    actual:   bugData.actual,
    reason:   bugData.reason,
    fixes:    bugData.fixes,
    jiraUrl,
    testCase: bugData.testCase
  });

  return { jiraUrl, jiraKey, category: bugData.category, title: bugData.title, testCase: bugData.testCase };
}

// ── Decline: dismiss the pending approval without creating any Jira ticket ────
function declineApproval(token) {
  const approval = getPendingApproval(token);
  if (!approval) throw new Error("Approval token not found");
  if (approval.status !== "pending") throw new Error(`Already ${approval.status}`);
  markApprovalStatus(token, "declined");
  return { category: approval.bugData.category, title: approval.bugData.title, testCase: approval.bugData.testCase };
}

module.exports = { runAutomation, runBatchAutomation, processApproval, declineApproval, getPendingApproval };
