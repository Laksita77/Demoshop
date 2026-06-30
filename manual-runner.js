require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const genAI2 = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY);
const geminiModels = [
  // Key 1
  { model: genAI.getGenerativeModel({ model: "gemini-2.5-flash" }),        name: "Gemini 2.5 Flash [K1]"      },
  { model: genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" }),   name: "Gemini 2.5 Flash Lite [K1]" },
  { model: genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" }),name: "Gemini Flash Lite [K1]"     },
  { model: genAI.getGenerativeModel({ model: "gemini-2.0-flash" }),        name: "Gemini 2.0 Flash [K1]"      },
  // Key 2 (separate quota)
  { model: genAI2.getGenerativeModel({ model: "gemini-2.5-flash" }),       name: "Gemini 2.5 Flash [K2]"      },
  { model: genAI2.getGenerativeModel({ model: "gemini-2.5-flash-lite" }),  name: "Gemini 2.5 Flash Lite [K2]" },
  { model: genAI2.getGenerativeModel({ model: "gemini-flash-lite-latest"}),name: "Gemini Flash Lite [K2]"     },
  { model: genAI2.getGenerativeModel({ model: "gemini-2.0-flash" }),       name: "Gemini 2.0 Flash [K2]"      },
];

const { runBatchAutomation } = require("./automation");
const { getPageAndHtml, stripHtml, executeCheck } = require("./utils");
const { saveTestCases, saveRunResult }  = require("./storage");

const RUN_ID = `manual-run-${Date.now()}`;

// ── CLI args ──────────────────────────────────────────────────────────────────
// node manual-runner.js --url https://flipkart.com --tests "search bar exists|login button|cart icon" --sprint Sprint-23
const arg       = (flag) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : null; };
const TARGET_URL  = arg("--url");
const TESTS_RAW   = arg("--tests");
const TESTS_FILE  = arg("--tests-file");
const SPRINT_NAME = arg("--sprint") || `run-${new Date().toISOString().split("T")[0]}`;

let USER_TESTS = [];
if (TESTS_FILE) {
  try {
    const data = JSON.parse(require("fs").readFileSync(TESTS_FILE, "utf8"));
    USER_TESTS = (data.tests || []).map(t => t.trim()).filter(Boolean);
  } catch (e) { console.error("Failed to read tests file:", e.message); process.exit(1); }
} else if (TESTS_RAW) {
  USER_TESTS = TESTS_RAW.split("|").map(t => t.trim()).filter(Boolean);
}

// ── Post result to dashboard ──────────────────────────────────────────────────
async function postResult(data) {
  for (let i = 0; i < 3; i++) {
    try {
      await fetch(`${process.env.SERVER_URL || "http://localhost:3000"}/test-result`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ...data, runId: RUN_ID }),
        signal:  AbortSignal.timeout(3000)
      });
      return;
    } catch (_) {
      if (i < 2) await new Promise(r => setTimeout(r, 500));
    }
  }
}

// ── Ask AI to convert user descriptions to executable checks ─────────────────
async function convertToChecks(html, userTests) {
  const stripped = stripHtml(html, 60000);  // from utils.js

  const prompt = `
You are a senior QA engineer. A user has described test cases in plain English.
Convert EACH description into a Playwright executable check that runs in a real browser.

User test descriptions:
${userTests.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Use EXACTLY one check type per test. PREFER Playwright checks over HTML checks.

PLAYWRIGHT CHECKS (run against the live rendered page — preferred):
1. visible         → element is visible in the browser
   { "check": "visible", "selector": "CSS_selector" }
2. not_visible     → element is hidden or absent
   { "check": "not_visible", "selector": "CSS_selector" }
3. text_contains   → element's rendered text includes a string
   { "check": "text_contains", "selector": "CSS_selector", "value": "expected text" }
4. count_gte       → at least N matching elements exist
   { "check": "count_gte", "selector": "CSS_selector", "expectedCount": 1 }
5. attr_equals     → element attribute equals exact value
   { "check": "attr_equals", "selector": "CSS_selector", "attribute": "type", "expectedValue": "password" }
6. attr_contains   → element attribute contains substring
   { "check": "attr_contains", "selector": "CSS_selector", "attribute": "href", "value": "/cart" }
7. title_contains  → page tab title contains a string
   { "check": "title_contains", "value": "substring" }
8. click_then_visible → click an element, then verify something appears
   { "check": "click_then_visible", "clickSelector": "CSS_sel", "resultSelector": "CSS_sel" }
9. fill_and_submit → fill form fields with real values and submit (for login/registration/checkout flows)
   {
     "check": "fill_and_submit",
     "fields": [
       { "selector": "input[name='email'], input[type='email']", "value": "test@example.com" },
       { "selector": "input[name='password'], input[type='password']", "value": "Test@123" }
     ],
     "submitSelector": "button[type='submit'], input[type='submit']",
     "successSelector": ".account-header, [class*='account'], [class*='dashboard']"
   }
   Use successSelector (element that appears on success) OR successUrl (URL path after redirect), not both.

API CHECKS (use when the test validates a REST endpoint, not the browser UI):
10. api_request → make an HTTP request and verify status code, response body, and speed
   {
     "check": "api_request",
     "method": "GET",
     "url": "https://example.com/api/products",
     "expectedStatus": 200,
     "expectedBodyContains": "products",
     "expectedBodyNotContains": "error",
     "maxResponseTime": 3000
   }
   Fields: method (GET/POST/PUT/DELETE), url (required), headers (optional object),
   body (optional object for POST/PUT), expectedStatus (default 200),
   expectedBodyContains (optional string), expectedBodyNotContains (optional string),
   maxResponseTime in ms (default 5000).
   Use this for: REST API endpoints, JSON APIs, status-code checks, response content validation.

FALLBACK (only if no CSS selector can be reliably derived):
11. html_contains    → { "check": "html_contains",    "value": "exact string in raw HTML" }
12. html_not_contains → { "check": "html_not_contains", "value": "string that must NOT appear" }

CSS selector writing rules (critical for SPAs):
- Text matching:   button:has-text('Sign In'), a:has-text('Login'), button:has-text('Add to Cart')
- Aria attributes: [aria-label*='search'], [role='navigation'], [aria-label*='cart']
- Partial classes: [class*='logo'], [class*='cart'], [class*='nav'], [class*='search']
- Input types:     input[type='password'], input[type='email'], input[placeholder*='search']
- Links:           a[href*='/login'], a[href*='/cart'], a[href='/']
- Structural:      header, nav, footer, form, main
- AVOID exact obfuscated class names like ".sc-abc123"

Look at the HTML source below to find correct selectors that actually exist on the page.

Return ONLY valid JSON — no markdown, no extra text:
{
  "testCases": [
    {
      "id": "MT-01",
      "area": "Frontend",
      "name": "Short test name",
      "expected": "What correct behaviour looks like",
      "check": "visible",
      "selector": "header [class*='logo'], a[href='/']"
    }
  ]
}

HTML source (use this to pick selectors that actually exist):
${stripped}`;

  for (const { model, name: modelName } of geminiModels) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        console.log(`   🔵 AI converted ${userTests.length} descriptions → checks (${modelName})\n`);
        const raw = result.response.text().trim()
          .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        const parsed = JSON.parse(raw);
        return parsed.testCases ?? parsed;
      } catch (err) {
        const isQuota = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        const is404   = err.message?.includes("404");
        if (isQuota || is404) { console.log(`   ⚠️  ${modelName} ${is404 ? "not available" : "quota exhausted"} — switching…`); break; }
        const is429 = err.message?.includes("429");
        const is503 = err.message?.includes("503");
        if ((!is429 && !is503) || attempt === 4) { console.log(`   ⚠️  ${modelName} failed — switching…`); break; }
        const wait = is503 ? 10000 : 20000;
        console.log(`   ⏳ ${modelName} busy — retrying in ${wait / 1000}s… (${attempt}/4)`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  // ── Claude fallback ──────────────────────────────────────────────────────────
  if (process.env.CLAUDE_API_KEY) {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
      console.log("   🟣 Gemini quota exhausted — falling back to Claude Haiku…");
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }]
      });
      console.log("   🟣 Provider: Claude Haiku [fallback]\n");
      const raw = msg.content[0].text.trim()
        .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = JSON.parse(raw);
      return parsed.testCases ?? parsed;
    } catch (err) {
      console.log(`   ❌ Claude fallback failed: ${err.message.slice(0, 100)}`);
    }
  }
  throw new Error("All AI models are currently unavailable (quota exhausted or service down). Please try again later.");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (USER_TESTS.length === 0) {
    console.error("No test descriptions provided. Use --tests 'test1|test2|test3'");
    process.exit(1);
  }

  const siteName = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";

  console.log("═".repeat(54));
  console.log(`   ${siteName} — Manual Test Runner`);
  console.log(`   Sprint : ${SPRINT_NAME}`);
  console.log("═".repeat(54));
  console.log(`   Tests : ${USER_TESTS.length}`);
  USER_TESTS.forEach((t, i) => console.log(`   ${i + 1}. ${t}`));
  console.log("═".repeat(54) + "\n");

  // Step 1: Open browser — stays alive for the full run
  const { html, page, browser } = await getPageAndHtml(TARGET_URL);

  // Step 2: AI converts descriptions → executable Playwright checks
  let testCases;
  console.log(`🤖 Converting ${USER_TESTS.length} test descriptions to executable checks…`);
  try {
    testCases = await convertToChecks(html, USER_TESTS);
  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }

  const mode = page ? "Playwright (live)" : "HTML source";
  console.log(`\n   ▶  Running ${testCases.length} checks in ${mode} mode\n`);

  // Step 3: Run checks
  const failures = [];
  let passed = 0;

  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}  ${tc.name}... `);
    await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "running" });

    try {
      const result = await executeCheck(page, html, tc);
      if (result.passed) {
        console.log("✅ PASS");
        passed++;
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "pass" });
      } else {
        console.log(`❌ FAIL — ${result.actual}`);
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "fail", actual: result.actual });
        failures.push({
          id:         tc.id,
          title:      `${tc.id} — ${tc.name}`,
          errorValue: result.actual,
          culprit:    tc.id,
          testCase:   tc.id,
          expected:   tc.expected,
          area:       tc.area || "Frontend"
        });
      }
    } catch (err) {
      console.log(`💥 ERROR — ${err.message}`);
      await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "error", actual: err.message });
    }
  }

  // Step 4: AI classify failures → Jira
  let jiraCount      = 0;
  let duplicateCount = 0;
  if (failures.length > 0) {
    for (const f of failures) {
      await postResult({ id: f.id, name: f.title, status: "classifying" });
    }
    try {
      const results = await runBatchAutomation(failures, async (r) => {
        const failure = failures.find(f => f.id === r.id);
        await postResult({
          id: r.id, name: failure?.title || r.id, area: failure?.area,
          status: r.duplicate ? "duplicate" : "fail",
          actual: failure?.errorValue,
          category: r.category, reason: r.reason, jiraUrl: r.jiraUrl,
          duplicate: r.duplicate, repeatCount: r.repeatCount,
          pendingApproval: r.pendingApproval || false
        });
      });
      jiraCount      = results.filter(r => r.logged).length;
      duplicateCount = results.filter(r => r.duplicate).length;
    } catch (err) {
      console.log(`\n💥 AI Error — ${err.message}\n`);
    }
  }

  await postResult({ id: "__done__", runFinished: true });
  if (browser) await browser.close();

  // Save test cases and run results to storage
  saveTestCases(siteName, SPRINT_NAME, testCases, { source: "manual", url: TARGET_URL, userTests: USER_TESTS });
  saveRunResult(siteName, SPRINT_NAME, RUN_ID, [], {
    passed, failed: testCases.length - passed, total: testCases.length, sprint: SPRINT_NAME
  });

  console.log("\n" + "═".repeat(54));
  console.log(`   ✅ Passed       : ${passed}`);
  console.log(`   ❌ Failed       : ${testCases.length - passed}`);
  console.log(`   🎫 Jira tickets : ${jiraCount} created`);
  if (duplicateCount > 0)
    console.log(`   🔁 Repeated     : ${duplicateCount} bug(s) already in Jira (skipped)`);
  console.log(`   💾 Saved to     : test-suites/${siteName}/${SPRINT_NAME}/`);
  console.log("═".repeat(54) + "\n");
}

main().catch(err => {
  console.error("[Manual Runner Error]", err.message);
  process.exit(1);
});
