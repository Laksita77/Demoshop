// story-runner.js
// Usage: node story-runner.js --url https://flipkart.com --story "As a user I want to search..." --sprint Sprint-23 --count 6
require("dotenv").config();
const { runBatchAutomation } = require("./automation");
const { getPageAndHtml, stripHtml, executeCheck, captureFailureScreenshot } = require("./utils");
const { saveTestCases, saveRunResult } = require("./storage");
const { generateJsonWithFallback } = require("./ai-provider");

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

  const baseUrl = TARGET_URL ? TARGET_URL.replace(/\/$/, "") : "";

  const prompt = `
You are a senior QA engineer. A team member has provided a user story.
Generate EXACTLY ${TEST_COUNT} test cases that verify this user story is correctly implemented.

USER STORY:
"${story}"

MANDATORY: Assign the correct "area" to every test case — this drives bug classification:
- "Security"    → login security, password masking, form validation controls, auth bypass prevention
- "Backend"     → server responses, API status codes, login credential rejection, redirects
- "Frontend"    → UI element visibility, text rendering, layout, images
- "Performance" → page/API response time
- "Trivial"     → page title, minor text labels, capitalisation

MANDATORY DISTRIBUTION — spread areas across the ${TEST_COUNT} tests. Do NOT put "Frontend" for everything.
At least 1 Security, 1 Backend, 1 Performance, 1 Trivial, rest Frontend.

DESIGN SOME TESTS TO PASS — at least 2 tests must be ones that will clearly succeed on a real site
(e.g. password field IS masked, login page IS visible, title IS present, homepage loads quickly).

PASS/FAIL MIXING RULE:
- Prefer a realistic MIX of tests that are likely to pass and tests that may expose defects.
- Include positive story-acceptance checks and negative/boundary checks when the story naturally allows them.
- Do NOT invent impossible failures just to force failed results.
- If this story and website clearly support only passing checks or only failing checks, then same-kind results are allowed.

CHECK TYPES — pick the right one per area:

PLAYWRIGHT (for Security UI + Frontend):
1. visible        → { "check": "visible", "selector": "CSS" }
2. not_visible    → { "check": "not_visible", "selector": "CSS" }
3. text_contains  → { "check": "text_contains", "selector": "CSS", "value": "text" }
4. count_gte      → { "check": "count_gte", "selector": "CSS", "expectedCount": 1 }
5. attr_equals    → { "check": "attr_equals", "selector": "CSS", "attribute": "type", "expectedValue": "password" }
6. title_contains → { "check": "title_contains", "value": "Swag Labs" }
7. fill_and_submit → fill form and verify outcome
   { "check": "fill_and_submit", "fields": [{"selector": "#user-name", "value": "standard_user"}, {"selector": "#password", "value": "secret_sauce"}], "submitSelector": "#login-button", "successSelector": ".inventory_list" }

API (for Backend + Performance — no login required):
8. api_request → { "check": "api_request", "method": "GET", "url": "${baseUrl}/", "expectedStatus": 200, "maxResponseTime": 3000 }
   Use for: homepage response time, checking unauthenticated access to protected pages gets 200 (login redirect)

HTML FALLBACK (for Security string checks):
9. html_not_contains → { "check": "html_not_contains", "value": "secret_sauce" }
10. html_contains    → { "check": "html_contains", "value": "string" }

SAUCEDEMO SELECTORS (use these — they are correct):
- Username field:   #user-name
- Password field:   #password
- Login button:     #login-button
- Error message:    [data-test="error"]
- Product list:     .inventory_list
- Cart badge:       .shopping_cart_badge
- App logo:         .app_logo
- Page title:       .title

Return ONLY valid JSON — no markdown, no extra text:
{
  "testCases": [
    {
      "id": "US-01",
      "area": "Security",
      "name": "Password field is masked on login page",
      "expected": "Password input type is password so characters are hidden",
      "check": "attr_equals",
      "selector": "#password",
      "attribute": "type",
      "expectedValue": "password"
    },
    {
      "id": "US-02",
      "area": "Backend",
      "name": "Login with wrong credentials shows error",
      "expected": "Server returns an error message for invalid credentials",
      "check": "fill_and_submit",
      "fields": [{"selector": "#user-name", "value": "wronguser"}, {"selector": "#password", "value": "wrongpass"}],
      "submitSelector": "#login-button",
      "successSelector": "[data-test='error']"
    },
    {
      "id": "US-03",
      "area": "Frontend",
      "name": "Product list renders on inventory page",
      "expected": "At least one product card is visible after login",
      "check": "fill_and_submit",
      "fields": [{"selector": "#user-name", "value": "standard_user"}, {"selector": "#password", "value": "secret_sauce"}],
      "submitSelector": "#login-button",
      "successSelector": ".inventory_list"
    },
    {
      "id": "US-04",
      "area": "Performance",
      "name": "Homepage responds within 3 seconds",
      "expected": "GET request to homepage completes in under 3000ms",
      "check": "api_request",
      "method": "GET",
      "url": "${baseUrl}/",
      "expectedStatus": 200,
      "maxResponseTime": 3000
    },
    {
      "id": "US-05",
      "area": "Trivial",
      "name": "Page title contains Swag Labs",
      "expected": "Browser tab title contains Swag Labs",
      "check": "title_contains",
      "value": "Swag Labs"
    }
  ]
}

HTML SOURCE:
${stripped}`;

  const { data: testCases } = await generateJsonWithFallback(prompt, {
    maxTokens: 8192,
    successMessage: `AI generated ${TEST_COUNT} test cases from user story`
  });
  return testCases;
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
        const screenshot = await captureFailureScreenshot(page, RUN_ID, tc.id);
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "fail", actual: result.actual, screenshot });
        failures.push({
          id:         tc.id,
          title:      `${tc.id} — ${tc.name}`,
          errorValue: result.actual,
          culprit:    tc.id,
          testCase:   tc.id,
          expected:   tc.expected,
          area:       tc.area || "Frontend",
          screenshot
        });
      }
    } catch (err) {
      console.log(`💥 ERROR — ${err.message}`);
      const screenshot = await captureFailureScreenshot(page, RUN_ID, tc.id);
      await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "error", actual: err.message, screenshot });
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
          screenshot: failure?.screenshot,
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
