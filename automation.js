require("dotenv").config();
const Groq                   = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const groq  = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModels = [
  genAI.getGenerativeModel({ model: "gemini-2.5-flash" }),
  genAI.getGenerativeModel({ model: "gemini-1.5-flash" }),
];

const JIRA_AUTH = Buffer.from(
  `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
).toString("base64");

// ── Jira via PowerShell (uses Windows native HTTP + system proxy) ─────────────
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { execSync } = require("child_process");

async function postJiraPS(fields) {
  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issue`;
  const ts  = Date.now();
  const tmpBody   = path.join(os.tmpdir(), `jira_body_${ts}.json`);
  const tmpScript = path.join(os.tmpdir(), `jira_run_${ts}.ps1`);
  const tmpOut    = path.join(os.tmpdir(), `jira_out_${ts}.txt`);

  fs.writeFileSync(tmpBody, JSON.stringify({ fields }), "utf8");

  const script = `
$ErrorActionPreference = 'Stop'
$headers = @{ Authorization='Basic ${JIRA_AUTH}'; Accept='application/json' }
try {
  $r = Invoke-RestMethod -Uri '${url}' -Method POST -Headers $headers \`
       -InFile '${tmpBody.replace(/\\/g, "/")}' -ContentType 'application/json'
  $r.key | Out-File '${tmpOut.replace(/\\/g, "/")}' -Encoding utf8 -NoNewline
} catch {
  $code = [int]$_.Exception.Response.StatusCode
  $body = ''
  try { $body = $_.ErrorDetails.Message } catch {}
  "$code::$body" | Out-File '${tmpOut.replace(/\\/g, "/")}' -Encoding utf8 -NoNewline
  exit 1
}`.trim();

  fs.writeFileSync(tmpScript, script, "utf8");

  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`, {
      encoding: "utf8", timeout: 30000
    });
    const key = fs.readFileSync(tmpOut, "utf8").trim();
    return key;
  } catch {
    const out = fs.existsSync(tmpOut) ? fs.readFileSync(tmpOut, "utf8").trim() : "no output";
    throw new Error(out);
  } finally {
    [tmpBody, tmpScript, tmpOut].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  }
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
let _jiraAccountId  = process.env.JIRA_ACCOUNT_ID || null;
let _jiraSprintId   = null;
let _jiraContextDone = false;

async function loadJiraContext() {
  if (_jiraContextDone) return;
  _jiraContextDone = true;

  const ts  = Date.now();
  const ps1 = path.join(os.tmpdir(), `jira_ctx_${ts}.ps1`);
  const out = path.join(os.tmpdir(), `jira_ctx_out_${ts}.txt`);

  fs.writeFileSync(ps1, `
$ErrorActionPreference = 'SilentlyContinue'
$h = @{ Authorization='Basic ${JIRA_AUTH}'; Accept='application/json' }
$me  = Invoke-RestMethod -Uri '${process.env.JIRA_BASE_URL}/rest/api/3/myself' -Headers $h
$spr = Invoke-RestMethod -Uri '${process.env.JIRA_BASE_URL}/rest/agile/1.0/board/1/sprint?state=active&maxResults=1' -Headers $h
$sid = if ($spr.values.Count -gt 0) { $spr.values[0].id } else { '' }
"$($me.accountId)|$sid" | Out-File '${out.replace(/\\/g,"/")}' -Encoding utf8 -NoNewline
`.trim(), "utf8");

  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { timeout: 10000 });
    const [acct, sprint] = fs.readFileSync(out, "utf8").trim().split("|");
    if (acct)   _jiraAccountId = acct.trim();
    if (sprint) _jiraSprintId  = parseInt(sprint.trim());
    if (_jiraAccountId) console.log(`   👤 Jira assignee: ${_jiraAccountId}`);
    if (_jiraSprintId)  console.log(`   🏃 Active sprint: ${_jiraSprintId}`);
  } catch (_) {}
  finally { [ps1, out].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} }); }
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
      const key = await postJiraPS(fields);
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

// ── AI call: Groq primary → Gemini fallback ───────────────────────────────────
async function generateWithRetry(prompt, maxRetries = 4) {
  // Try Groq first (higher quota, faster)
  try {
    const response = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      response_format: { type: "json_object" }
    });
    console.log("   🟢 Provider: Groq (Llama 3.3 70B)");
    return response.choices[0].message.content;
  } catch (groqErr) {
    const blocked = groqErr.status === 403 || groqErr.message?.includes("403") || groqErr.message?.includes("blocked");
    const groqMsg = blocked ? "blocked by network" : groqErr.message;
    console.log(`   ⚠️  Groq unavailable (${groqMsg}) — falling back to Gemini…`);
  }

  // Fallback: try gemini-2.5-flash first, then gemini-1.5-flash if quota exceeded
  const modelNames = ["Gemini 2.5 Flash", "Gemini 1.5 Flash"];
  for (let m = 0; m < geminiModels.length; m++) {
    const model = geminiModels[m];
    const modelName = modelNames[m];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        console.log(`   🔵 Provider: ${modelName} (fallback)`);
        return result.response.text().trim()
          .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      } catch (err) {
        const isQuota   = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        const is429     = err.message?.includes("429");
        const is503     = err.message?.includes("503");
        const isRetryable = (is429 || is503) && !isQuota;

        if (isQuota) {
          console.log(`   ⚠️  ${modelName} quota exhausted — switching to next model…`);
          break;
        }

        if (!isRetryable || attempt === maxRetries) {
          console.log(`   ❌ ${modelName} failed (attempt ${attempt}): ${err.message}`);
          if (m === geminiModels.length - 1) throw err;
          break;
        }

        const match  = err.message.match(/retry in (\d+(?:\.\d+)?)s/i);
        const waitMs = is503 ? 15000 : (match ? Math.ceil(parseFloat(match[1])) * 1000 + 1000 : 30000);
        console.log(`   ⏳ ${modelName} ${is503 ? "overloaded" : "rate limited"} — waiting ${Math.ceil(waitMs / 1000)}s then retrying (${attempt}/${maxRetries})…`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  throw new Error("All Gemini models exhausted");
}

// ── BATCH pipeline — ONE Groq call for ALL failures ──────────────────────────
// failures: [{ id, title, errorType, errorValue, culprit, expected, area, testCase }]
// onResult(result) is called immediately after each ticket is created/skipped
async function runBatchAutomation(failures, onResult = null) {
  if (failures.length === 0) return [];

  console.log(`\n🤖 Sending ${failures.length} failure(s) to Groq AI for batch classification…\n`);

  const prompt = `
You are a senior QA engineer. Classify ALL of these failing test cases from a DemoShop e-commerce app in ONE response.

Categories:
- Security    → password exposure, card data issues, auth bypass, data leaks
- Backend     → wrong calculations, logic errors, missing validation
- Frontend    → UI display bugs, broken labels, wrong counts, case-sensitivity
- Performance → inefficient algorithms, wrong sort methods
- Trivial     → cosmetic issues, minor text errors

Test cases to classify:
${failures.map((f, i) => `
[${i + 1}] ID: ${f.id}
    Name    : ${f.title}
    Expected: ${f.expected}
    Actual  : ${f.errorValue}
    Location: ${f.culprit}
`).join("")}

Reply ONLY with a valid JSON object containing a "results" array:
{
  "results": [
    {
      "id": "TC-XX",
      "category": "Security|Backend|Frontend|Performance|Trivial",
      "classificationReason": "One sentence explaining why",
      "brokenCode": "One sentence describing the broken code",
      "fixes": ["Fix 1", "Fix 2", "Fix 3"],
      "emailBody": "Professional 2-sentence summary for the dev team"
    }
  ]
}`;

  const rawText = (await generateWithRetry(prompt)).trim()
    .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(rawText);
  const classifications = parsed.results ?? parsed;

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
      const jiraUrl = await createJiraTicket({
        title:          `[${ai.category.toUpperCase()}] ${failure.title}`,
        adfDescription: buildADF({
          title:                failure.title,
          testCase:             failure.testCase || failure.id,
          area:                 failure.area || ai.category,
          category:             ai.category,
          expected:             failure.expected,
          actual:               failure.errorValue,
          classificationReason: ai.classificationReason,
          brokenCode:           ai.brokenCode,
          fixes:                ai.fixes
        }),
        priority:        catConfig.priority,
        labels:          ["bug", "demoshop", ai.category.toLowerCase()],
        category:        ai.category,
        dueDays:         catConfig.dueDays,
        storyPoints:     catConfig.storyPoints
      });
      const item = { id: ai.id, logged: true, category: ai.category, reason: ai.classificationReason, jiraUrl, fixes: ai.fixes };
      output.push(item);
      if (onResult) await onResult(item);
    } catch (err) {
      console.log(`   ⚠️  Jira error for ${ai.id}: ${err.message}`);
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

Classify this bug into EXACTLY one of these categories:
- Security    → password exposure, card data issues, auth bypass, data leaks
- Backend     → wrong calculations, logic errors, missing validation on server
- Frontend    → UI display bugs, broken labels, wrong counts, case-sensitivity
- Performance → inefficient algorithms, wrong sort methods, unnecessary recalculations
- Trivial     → cosmetic issues, minor text errors, low-impact UI glitches

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

module.exports = { runAutomation, runBatchAutomation };
