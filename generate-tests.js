require("dotenv").config();
const fs                     = require("fs");
const path                   = require("path");
const { runBatchAutomation } = require("./automation");
const { getPageAndHtml, stripHtml, executeCheck, captureFailureScreenshot } = require("./utils");
const { saveTestCases, saveRunResult } = require("./storage");
const { generateJsonWithFallback } = require("./ai-provider");

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

  const baseUrl = TARGET_URL || "";
  const prompt = `
You are a senior QA engineer auditing a real-world website for bugs.
Analyse the HTML and generate EXACTLY ${TEST_COUNT || 10} test cases that cover MULTIPLE BUG CATEGORIES.

MANDATORY DISTRIBUTION — you MUST include at least one test from each category:
• Security  (🔴) — auth controls, form security, no sensitive data in HTML, HTTPS, no novalidate on login
• Backend   (🟠) — API endpoints respond correctly, form submission behavior, server-side validation
• Frontend  (🟡) — key UI elements visible, correct text rendered, broken layout
• Performance(🔵) — critical page/API responds within 3 seconds
• Trivial   (⚪) — label text, capitalisation, minor content check

DO NOT generate only Frontend checks. Spread evenly.

PASS/FAIL MIXING RULE:
- Prefer a realistic MIX of tests that are likely to pass and tests that may expose defects.
- Include positive checks for behavior the HTML clearly supports, plus negative/boundary/security checks where a defect is plausible.
- Do NOT invent impossible failures just to force failed results.
- If the website clearly supports only passing checks or only failing checks, then same-kind results are allowed.

CHECK TYPES — pick the best type for each category:

PLAYWRIGHT (live browser — use for Frontend/Security UI checks):
1. visible         → { "check": "visible", "selector": "CSS_selector" }
2. not_visible     → { "check": "not_visible", "selector": "CSS_selector" }
3. text_contains   → { "check": "text_contains", "selector": "CSS_selector", "value": "text" }
4. count_gte       → { "check": "count_gte", "selector": "CSS_selector", "expectedCount": 1 }
5. attr_equals     → { "check": "attr_equals", "selector": "CSS_selector", "attribute": "type", "expectedValue": "password" }
6. attr_contains   → { "check": "attr_contains", "selector": "CSS_selector", "attribute": "href", "value": "/cart" }
7. title_contains  → { "check": "title_contains", "value": "substring" }
8. fill_and_submit → fill a form and verify success/error (login, register, search)
   { "check": "fill_and_submit", "fields": [{"selector": "input[type='email']", "value": "test@test.com"}], "submitSelector": "button[type='submit']", "successSelector": ".dashboard" }

API (direct HTTP — use for Backend/Performance/Security):
9. api_request → { "check": "api_request", "method": "GET", "url": "${baseUrl}/api/...", "expectedStatus": 200, "expectedBodyContains": "key", "maxResponseTime": 3000 }
   Use this for REST endpoints, JSON APIs, or checking that unauthenticated requests get 401/403.

HTML FALLBACK (use for security string checks):
10. html_not_contains → { "check": "html_not_contains", "value": "password" }  ← passwords not exposed in HTML
11. html_contains     → { "check": "html_contains",     "value": "string" }

SECURITY TEST PATTERNS (always include at least 1–2):
- Password field type: attr_equals on input[type='password'] — must equal "password"
- Login form has no "novalidate": html_not_contains with value "novalidate"
- Passwords not in page source: html_not_contains with value "password" (checks raw HTML)
- Admin URL blocked: api_request to /admin or /dashboard expecting 401 or 403
- HTTPS redirect: api_request to the HTTP version expecting status 301 or 302

BACKEND TEST PATTERNS (always include at least 1):
- api_request to a known endpoint (products list, categories, search) expecting 200 + key field in body
- fill_and_submit a login form with wrong credentials and verify an error message appears

PERFORMANCE TEST PATTERN (always include at least 1):
- api_request to the homepage or main API with maxResponseTime: 3000

CSS selector rules (critical for SPAs):
- Text:    button:has-text('Sign In'), a:has-text('Login')
- Aria:    [aria-label*='search'], [role='navigation']
- Partial: [class*='logo'], [class*='cart'], [class*='nav']
- Inputs:  input[type='password'], input[placeholder*='email']
- Links:   a[href*='/login'], a[href*='/cart']
- Avoid exact obfuscated classes like ".sc-abc123"

Return ONLY valid JSON — no markdown, no extra text:
{
  "testCases": [
    {
      "id": "AI-01",
      "area": "Security|Backend|Frontend|Performance|Trivial",
      "name": "Short test name (max 60 chars)",
      "expected": "What correct behaviour looks like",
      "check": "visible",
      "selector": "..."
    }
  ]
}

HTML SOURCE:
${stripped}`;

  console.log(`\n🤖 Sending ${SOURCE_LABEL} to AI for test case generation…\n`);

  const { data: testCases } = await generateJsonWithFallback(prompt, {
    maxTokens: 8192,
    successMessage: `AI generated ${TEST_COUNT || 10} test cases`
  });

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
        const screenshot = await captureFailureScreenshot(page, RUN_ID, tc.id);
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "fail", actual: result.actual, screenshot });
        failures.push({
          id: tc.id, title: `${tc.id} — ${tc.name}`,
          errorType: tc.name, errorValue: result.actual,
          culprit: tc.id, testCase: tc.id, expected: tc.expected, area: tc.area || "",
          screenshot
        });
      }
    } catch (err) {
      console.log(`💥 ERROR — ${err.message}`);
      const screenshot = await captureFailureScreenshot(page, RUN_ID, tc.id);
      await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "error", actual: err.message, screenshot });
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
          screenshot: failure?.screenshot,
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
