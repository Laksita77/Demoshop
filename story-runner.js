// story-runner.js
// Usage: node story-runner.js --url https://flipkart.com --story "As a user I want to search..." --sprint Sprint-23 --count 6
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { runBatchAutomation } = require("./automation");
const { getPageAndHtml, stripHtml, executeCheck } = require("./utils");
const { saveTestCases, saveRunResult } = require("./storage");

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

// ── CLI args ──────────────────────────────────────────────────────────────────
const arg  = (flag) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : null; };

const TARGET_URL  = arg("--url");
const STORY_FILE  = arg("--story-file");
const SPRINT_NAME = arg("--sprint") || `run-${new Date().toISOString().split("T")[0]}`;
const TEST_COUNT  = arg("--count")  ? parseInt(arg("--count")) : 8;
const RUN_ID      = `story-run-${Date.now()}`;

let USER_STORY = arg("--story") || null;
if (STORY_FILE) {
  try {
    const data = JSON.parse(require("fs").readFileSync(STORY_FILE, "utf8"));
    USER_STORY = data.story || USER_STORY;
  } catch (e) { console.error("Failed to read story file:", e.message); process.exit(1); }
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

// ── AI: generate test cases from user story + HTML ───────────────────────────
async function generateFromStory(html, story) {
  const stripped = stripHtml(html, 80000);

  const prompt = `
You are a senior QA engineer. A team member has provided a user story.
Generate EXACTLY ${TEST_COUNT} test cases that verify this user story is correctly implemented.

USER STORY:
"${story}"

For each test case, ask: "How would a QA engineer verify this in a real browser?"
Focus on:
- Is the relevant UI element visible and correctly labelled?
- Input fields have correct types (password → type="password", email → type="email")
- Required validation attributes are present (required, pattern, maxlength)
- CTAs are visible and clickable with the right label
- Error or success states mentioned in the story are present

PREFERRED: Use Playwright check types (run against the LIVE rendered page):
1. visible         → element is visible
   { "check": "visible", "selector": "CSS_selector" }
2. not_visible     → element is hidden/absent
   { "check": "not_visible", "selector": "CSS_selector" }
3. text_contains   → element's rendered text includes a value
   { "check": "text_contains", "selector": "CSS_selector", "value": "expected text" }
4. count_gte       → at least N elements match
   { "check": "count_gte", "selector": "CSS_selector", "expectedCount": 1 }
5. attr_equals     → element attribute equals exact value
   { "check": "attr_equals", "selector": "CSS_selector", "attribute": "type", "expectedValue": "password" }
6. attr_contains   → element attribute contains substring
   { "check": "attr_contains", "selector": "CSS_selector", "attribute": "href", "value": "/login" }
7. title_contains  → page tab title contains substring
   { "check": "title_contains", "value": "substring" }
8. click_then_visible → click element, verify result appears
   { "check": "click_then_visible", "clickSelector": "CSS_sel", "resultSelector": "CSS_sel" }
9. fill_and_submit → fill form fields with real values and submit (login/registration/checkout flows)
   {
     "check": "fill_and_submit",
     "fields": [
       { "selector": "input[name='email'], input[type='email']", "value": "test@example.com" },
       { "selector": "input[name='password'], input[type='password']", "value": "Test@123" }
     ],
     "submitSelector": "button[type='submit'], input[type='submit']",
     "successSelector": ".account-header, [class*='account']"
   }
   Use successSelector (element that appears on success) OR successUrl (URL path after redirect), not both.

API CHECKS (use when the story requires validating a REST endpoint directly):
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

FALLBACK (only when there is no reliable CSS selector):
11. html_contains    → { "check": "html_contains",    "value": "exact string in raw HTML" }
12. html_not_contains → { "check": "html_not_contains", "value": "string" }

CSS selector writing rules (critical for SPAs with obfuscated classes):
- Text matching:   button:has-text('Sign In'), a:has-text('Login')
- Aria attributes: [aria-label*='search'], [role='navigation']
- Partial classes: [class*='logo'], [class*='cart'], [class*='search']
- Input attrs:     input[type='password'], input[placeholder*='email'], input[name='phone']
- Links:           a[href*='/login'], a[href*='/cart'], a[href='/']
- Structural:      header, nav, footer, form
- AVOID exact obfuscated class names like ".sc-abc123"

Return ONLY valid JSON — no markdown, no extra text:
{
  "testCases": [
    {
      "id": "US-01",
      "area": "Frontend",
      "name": "Short test name (max 60 chars)",
      "expected": "What correct behaviour looks like",
      "check": "visible",
      "selector": "input[type='password'], input[placeholder*='password']"
    }
  ]
}

HTML SOURCE:
${stripped}`;

  for (const { model, name: modelName } of geminiModels) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        console.log(`   🔵 AI generated ${TEST_COUNT} test cases from user story (${modelName})\n`);
        const raw = result.response.text().trim()
          .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        const parsed = JSON.parse(raw);
        return parsed.testCases ?? parsed;
      } catch (err) {
        const isQuota = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        const is404   = err.message?.includes("404");
        if (isQuota || is404) { console.log(`   ⚠️  ${modelName} ${is404 ? "not available" : "quota exhausted"} — switching…`); break; }
        const retryable = err.message?.includes("429") || err.message?.includes("503");
        if (!retryable || attempt === 4) { console.log(`   ⚠️  ${modelName} failed — switching…`); break; }
        const wait = err.message?.includes("503") ? 10000 : 20000;
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
  if (!USER_STORY) {
    console.error("No user story provided. Use: --story 'As a user, I want to…'");
    process.exit(1);
  }

  const domain = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";

  console.log("═".repeat(60));
  console.log(`   📋 Story-Based Test Runner`);
  console.log("═".repeat(60));
  console.log(`   Site   : ${domain}`);
  console.log(`   Sprint : ${SPRINT_NAME}`);
  console.log(`   Story  : ${USER_STORY.slice(0, 80)}${USER_STORY.length > 80 ? "…" : ""}`);
  console.log(`   Tests  : ${TEST_COUNT}`);
  console.log("═".repeat(60) + "\n");

  // Step 1: Open browser — stays alive while AI generates + runs tests
  const { html, page, browser } = await getPageAndHtml(TARGET_URL);

  // Step 2: AI generates test cases from the user story
  console.log(`🤖 Generating ${TEST_COUNT} test cases aligned to your user story…\n`);
  let testCases;
  try {
    testCases = await generateFromStory(html, USER_STORY);
  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }

  // Step 3: Save test cases to storage (domain / sprint)
  saveTestCases(domain, SPRINT_NAME, testCases, {
    source: "user-story",
    url: TARGET_URL,
    story: USER_STORY
  });

  const mode = page ? "Playwright (live)" : "HTML source";
  console.log(`   ▶  Running ${testCases.length} checks in ${mode} mode\n`);

  // Step 4: Run all checks
  const failures = [];
  let passed = 0;

  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}  ${tc.name}… `);
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

  // Step 5: Save run results to storage
  const summary = {
    passed,
    failed:  testCases.length - passed,
    total:   testCases.length,
    sprint:  SPRINT_NAME,
    story:   USER_STORY.slice(0, 120)
  };
  saveRunResult(domain, SPRINT_NAME, RUN_ID, [], summary);

  // Step 6: AI classify failures → Jira
  let jiraCount      = 0;
  let duplicateCount = 0;
  if (failures.length > 0) {
    for (const f of failures) await postResult({ id: f.id, name: f.title, status: "classifying" });
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

  console.log("\n" + "═".repeat(60));
  console.log(`   ✅ Passed       : ${passed}`);
  console.log(`   ❌ Failed       : ${testCases.length - passed}`);
  console.log(`   🎫 Jira tickets : ${jiraCount} created`);
  if (duplicateCount > 0)
    console.log(`   🔁 Repeated     : ${duplicateCount} bug(s) already in Jira (skipped)`);
  console.log(`   💾 Saved to     : test-suites/${domain}/${SPRINT_NAME}/`);
  console.log("═".repeat(60) + "\n");
}

main().catch(err => {
  console.error("[Story Runner Error]", err.message);
  process.exit(1);
});
