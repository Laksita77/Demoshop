// story-runner.js
// Usage: node story-runner.js --url https://flipkart.com --story "As a user I want to search..." --sprint Sprint-23 --count 6
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { runBatchAutomation } = require("./automation");
const { getHtml, stripHtml, runCheck } = require("./utils");
const { saveTestCases, saveRunResult } = require("./storage");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModels = [
  genAI.getGenerativeModel({ model: "gemini-2.5-flash" }),
  genAI.getGenerativeModel({ model: "gemini-1.5-flash" }),
];

// ── CLI args ──────────────────────────────────────────────────────────────────
const arg  = (flag) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : null; };

const TARGET_URL  = arg("--url");
const USER_STORY  = arg("--story");
const SPRINT_NAME = arg("--sprint") || `run-${new Date().toISOString().split("T")[0]}`;
const TEST_COUNT  = arg("--count")  ? parseInt(arg("--count")) : 8;
const RUN_ID      = `story-run-${Date.now()}`;

// ── Post result to dashboard ──────────────────────────────────────────────────
async function postResult(data) {
  for (let i = 0; i < 3; i++) {
    try {
      await fetch("http://localhost:3000/test-result", {
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
Your job is to generate EXACTLY ${TEST_COUNT} test cases that verify this user story is correctly implemented on the webpage.

USER STORY:
"${story}"

Focus on:
- Is the relevant UI element visible and correctly labelled?
- Are required input fields present with correct types (email, password, tel)?
- Are validation attributes present (required, pattern, maxlength)?
- Are any error states or success messages referenced in the story present in HTML?
- Are call-to-action buttons present and correctly named?

Use EXACTLY one check type per test:
1. html_contains   → { "check": "html_contains",  "value": "exact string in HTML" }
2. html_not_contains → { "check": "html_not_contains", "value": "string that must NOT be in HTML" }
3. attribute_value → { "check": "attribute_value", "elementId": "id-without-hash", "attribute": "type", "expectedValue": "password" }

Return ONLY valid JSON in this exact format — no extra text:
{
  "testCases": [
    {
      "id": "US-01",
      "area": "Frontend",
      "name": "Short test name (max 60 chars)",
      "expected": "What correct behaviour looks like",
      "check": "html_contains",
      "value": "exact string to search for"
    }
  ]
}

HTML SOURCE:
${stripped}`;

  const modelNames = ["Gemini 2.5 Flash", "Gemini 1.5 Flash"];
  for (let m = 0; m < geminiModels.length; m++) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const result = await geminiModels[m].generateContent(prompt);
        console.log(`   🔵 AI generated ${TEST_COUNT} test cases from user story (${modelNames[m]})\n`);
        const raw = result.response.text().trim()
          .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        const parsed = JSON.parse(raw);
        return parsed.testCases ?? parsed;
      } catch (err) {
        const isQuota = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        if (isQuota) { console.log(`   ⚠️  ${modelNames[m]} quota — switching…`); break; }
        const retryable = err.message?.includes("429") || err.message?.includes("503");
        if (!retryable || attempt === 4) throw err;
        const wait = err.message?.includes("503") ? 15000 : 30000;
        console.log(`   ⏳ Retrying in ${wait / 1000}s… (${attempt}/4)`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw new Error("All AI models exhausted");
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

  // Step 1: Fetch HTML
  const html = await getHtml(TARGET_URL);

  // Step 2: AI generates test cases from the user story
  console.log(`🤖 Generating ${TEST_COUNT} test cases aligned to your user story…\n`);
  const testCases = await generateFromStory(html, USER_STORY);

  // Step 3: Save test cases to storage (domain / sprint)
  saveTestCases(domain, SPRINT_NAME, testCases, {
    source: "user-story",
    url: TARGET_URL,
    story: USER_STORY
  });

  // Step 4: Run all checks
  const failures = [];
  let passed = 0;

  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}  ${tc.name}… `);
    await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "running" });

    try {
      const result = runCheck(html, tc);
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
  let jiraCount = 0;
  if (failures.length > 0) {
    for (const f of failures) await postResult({ id: f.id, name: f.title, status: "classifying" });
    try {
      const results = await runBatchAutomation(failures, async (r) => {
        const failure = failures.find(f => f.id === r.id);
        await postResult({
          id: r.id, name: failure?.title || r.id, area: failure?.area,
          status: "fail", actual: failure?.errorValue,
          category: r.category, reason: r.reason, jiraUrl: r.jiraUrl
        });
      });
      jiraCount = results.filter(r => r.logged).length;
    } catch (err) {
      console.log(`\n💥 AI Error — ${err.message}\n`);
    }
  }

  await postResult({ id: "__done__", runFinished: true });

  console.log("\n" + "═".repeat(60));
  console.log(`   ✅ Passed       : ${passed}`);
  console.log(`   ❌ Failed       : ${testCases.length - passed}`);
  console.log(`   🎫 Jira tickets : ${jiraCount} created`);
  console.log(`   💾 Saved to     : test-suites/${domain}/${SPRINT_NAME}/`);
  console.log("═".repeat(60) + "\n");
}

main().catch(err => {
  console.error("[Story Runner Error]", err.message);
  process.exit(1);
});
