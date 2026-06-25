require("dotenv").config();
const fs                     = require("fs");
const path                   = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { runBatchAutomation } = require("./automation");
const { getPageAndHtml, stripHtml, executeCheck } = require("./utils");
const { saveTestCases, saveRunResult } = require("./storage");

const genAI        = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const genAI2       = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY);
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

const RUN_ID = `ai-run-${Date.now()}`;

// ── CLI args ──────────────────────────────────────────────────────────────────
// node generate-tests.js --url https://flipkart.com --count 4 --sprint Sprint-23
const arg = (flag) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : null; };

const TARGET_URL   = arg("--url");
const TEST_COUNT   = arg("--count") ? parseInt(arg("--count")) : null;
const SPRINT_NAME  = arg("--sprint") || `run-${new Date().toISOString().split("T")[0]}`;
const SOURCE_LABEL = TARGET_URL || "shop.html";

async function postResult(data) {
  try {
    await fetch(`${process.env.SERVER_URL || "http://localhost:3000"}/test-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, runId: RUN_ID }),
      signal: AbortSignal.timeout(2000)
    });
  } catch (_) {}
}

// ── Step 1: Ask AI to generate test cases from the HTML ───────────────────────
async function generateTestCases(html) {
  const stripped = stripHtml(html, 80000);  // from utils.js

  const prompt = `
You are a senior QA engineer analyzing an e-commerce webpage for bugs.
You will receive the rendered HTML source. Generate EXACTLY ${TEST_COUNT || "8–12"} realistic test cases.

Focus on:
- Navigation links and menus are visible (logo, categories, cart, profile, search)
- Input fields use correct types: password → type="password", email → type="email", phone → type="tel"
- Presence of validation attributes: required, pattern, maxlength
- Form security: login forms must NOT have the "novalidate" attribute
- Call-to-action buttons are visible and correctly labelled
- Page title is meaningful and contains the brand name

PREFERRED: Use Playwright check types — they run against the LIVE rendered page:
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
6. attr_contains   → element attribute contains a substring
   { "check": "attr_contains", "selector": "CSS_selector", "attribute": "href", "value": "/cart" }
7. title_contains  → browser tab title contains a substring
   { "check": "title_contains", "value": "substring" }

FALLBACK (only when no CSS selector can be derived — e.g. security string checks):
8. html_contains    → { "check": "html_contains",    "value": "exact string in raw HTML" }
9. html_not_contains→ { "check": "html_not_contains", "value": "string that must NOT appear" }

CSS selector writing rules (critical for SPAs with obfuscated classes):
- Text matching:   button:has-text('Sign In'), a:has-text('Login')
- Aria attributes: [aria-label*='search'], [role='navigation'], [aria-haspopup]
- Partial classes: [class*='logo'], [class*='nav'], [class*='cart'], [class*='search']
- Input attrs:     input[type='password'], input[placeholder*='search'], input[name='email']
- Links:           a[href*='/login'], a[href*='/cart'], a[href='/']
- Structural:      header, nav, footer, form, main
- AVOID exact obfuscated class names like ".sc-abc123"

Return ONLY valid JSON — no extra text, no markdown:
{
  "testCases": [
    {
      "id": "AI-01",
      "area": "Security|Backend|Frontend|Performance",
      "name": "Short test name (max 60 chars)",
      "expected": "What correct behaviour looks like",
      "check": "visible",
      "selector": "input[type='password'], input[placeholder*='password']"
    }
  ]
}

HTML SOURCE:
${stripped}`;

  console.log(`\n🤖 Sending ${SOURCE_LABEL} to AI for test case generation…\n`);

  let rawText;
  for (const { model, name: modelName } of geminiModels) {
    let succeeded = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        console.log(`   🔵 Provider: ${modelName}`);
        rawText = result.response.text();
        succeeded = true;
        break;
      } catch (gemErr) {
        const isQuota = gemErr.message?.includes("quota") || gemErr.message?.includes("RESOURCE_EXHAUSTED");
        const is404   = gemErr.message?.includes("404");
        if (isQuota || is404) {
          console.log(`   ⚠️  ${modelName} ${is404 ? "not available" : "quota exhausted"} — switching to next model…`);
          break;
        }
        const retryable = gemErr.message?.includes("503") || gemErr.message?.includes("429");
        if (!retryable || attempt === 4) { console.log(`   ⚠️  ${modelName} failed — switching…`); break; }
        const match = gemErr.message.match(/retry in (\d+(?:\.\d+)?)s/i);
        const wait  = gemErr.message?.includes("503") ? 10000 : (match ? Math.ceil(parseFloat(match[1])) * 1000 + 1000 : 20000);
        console.log(`   ⏳ ${modelName} busy — waiting ${Math.ceil(wait / 1000)}s then retrying (${attempt}/4)…`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
    if (succeeded) break;
  }

  if (!rawText) {
    throw new Error("All AI models are currently unavailable (quota exhausted or service down). Please try again later.");
  }
  rawText = rawText.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const parsed    = JSON.parse(rawText);
  const testCases = parsed.testCases ?? parsed;

  // Save to organised folder: test-suites/{domain}/{sprint}/testcases.json
  const domain = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";
  saveTestCases(domain, SPRINT_NAME, testCases, { source: "url", url: TARGET_URL });

  // Also keep flat file for backward compat (testrunner.js reads it)
  fs.writeFileSync(path.join(__dirname, "ai-testcases.json"), JSON.stringify(testCases, null, 2));

  console.log(`✅ AI generated ${testCases.length} test cases\n`);
  return testCases;
}

// ── Step 2 + 3: Run generated tests → batch AI classify → Jira ───────────────
async function runGeneratedTests(testCases, html, page = null) {
  const domain   = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";
  const failures = [];
  let passed = 0;

  const mode = page ? "Playwright (live)" : "HTML source";
  console.log("═".repeat(54));
  console.log(`   ${domain} — AI Generated Test Runner`);
  console.log(`   Sprint : ${SPRINT_NAME}   Mode: ${mode}`);
  console.log("═".repeat(54) + "\n");

  // Phase 1: run all checks
  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}... `);
    await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "running" });

    try {
      const result = await executeCheck(page, html, tc);  // Playwright or HTML fallback
      if (result.passed) {
        console.log("✅ PASS");
        passed++;
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "pass" });
      } else {
        console.log(`❌ FAIL — ${result.actual}`);
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "fail", actual: result.actual });
        failures.push({
          id: tc.id, title: `${tc.id} — ${tc.name}`,
          errorType: tc.name, errorValue: result.actual,
          culprit: tc.id, testCase: tc.id, expected: tc.expected, area: tc.area || ""
        });
      }
    } catch (err) {
      console.log(`💥 ERROR — ${err.message}`);
      await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "error", actual: err.message });
    }
  }

  // Save run results to storage
  const summary = { passed, failed: testCases.length - passed, total: testCases.length, sprint: SPRINT_NAME };
  saveRunResult(domain, SPRINT_NAME, RUN_ID, [], summary);

  // Phase 2: batch AI classify failures → Jira
  let jiraCount      = 0;
  let duplicateCount = 0;
  if (failures.length > 0) {
    for (const f of failures) await postResult({ id: f.id, name: f.title, status: "classifying" });
    try {
      const batchResults = await runBatchAutomation(failures, async (r) => {
        const failure = failures.find(f => f.id === r.id);
        await postResult({
          id: r.id, name: failure?.title || r.id, area: failure?.area,
          status: "fail", actual: failure?.errorValue,
          category: r.category, reason: r.reason, jiraUrl: r.jiraUrl,
          duplicate: r.duplicate, repeatCount: r.repeatCount,
          pendingApproval: r.pendingApproval || false
        });
      });
      jiraCount      = batchResults.filter(r => r.logged).length;
      duplicateCount = batchResults.filter(r => r.duplicate).length;
    } catch (err) {
      console.log(`\n💥 Batch AI Error — ${err.message}\n`);
    }
  }

  await postResult({ id: "__done__", runFinished: true });

  console.log("\n" + "═".repeat(54));
  console.log(`   ✅ Passed       : ${passed}`);
  console.log(`   ❌ Failed       : ${testCases.length - passed}`);
  console.log(`   🎫 Jira tickets : ${jiraCount} created`);
  if (duplicateCount > 0)
    console.log(`   🔁 Repeated     : ${duplicateCount} bug(s) already in Jira (skipped)`);
  console.log(`   💾 Saved to     : test-suites/${domain}/${SPRINT_NAME}/`);
  console.log("═".repeat(54) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Open browser once — page stays alive while AI generates tests, then runs them
  const { html, page, browser } = await getPageAndHtml(TARGET_URL);
  try {
    const testCases = await generateTestCases(html);
    await runGeneratedTests(testCases, html, page);
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(err => {
  console.error("[Generate Error]", err.message);
  process.exit(1);
});
