require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModels = [
  genAI.getGenerativeModel({ model: "gemini-2.5-flash" }),
  genAI.getGenerativeModel({ model: "gemini-1.5-flash" }),
];

const { runBatchAutomation } = require("./automation");
const { getHtml, stripHtml, runCheck } = require("./utils");
const { saveTestCases, saveRunResult }  = require("./storage");

const RUN_ID = `manual-run-${Date.now()}`;

// ── CLI args ──────────────────────────────────────────────────────────────────
// node manual-runner.js --url https://flipkart.com --tests "search bar exists|login button|cart icon" --sprint Sprint-23
const arg       = (flag) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : null; };
const TARGET_URL  = arg("--url");
const TESTS_RAW   = arg("--tests");
const SPRINT_NAME = arg("--sprint") || `run-${new Date().toISOString().split("T")[0]}`;
const USER_TESTS  = TESTS_RAW ? TESTS_RAW.split("|").map(t => t.trim()).filter(Boolean) : [];

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

// getHtml and httpsGet are now in utils.js

// ── Ask AI to convert user descriptions to executable checks ─────────────────
async function convertToChecks(html, userTests) {
  const stripped = stripHtml(html, 60000);  // from utils.js

  const prompt = `
You are a senior QA engineer. A user has described test cases in plain English.
Convert EACH description into an executable check against the HTML provided.

Use EXACTLY one check type per test:
1. html_contains      → "value": "exact string to find in HTML"
2. html_not_contains  → "value": "string that must NOT be in HTML"
3. attribute_value    → "elementId", "attribute", "expectedValue"

User test descriptions:
${userTests.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Return ONLY valid JSON:
{
  "testCases": [
    {
      "id": "MT-01",
      "area": "Frontend",
      "name": "Short test name",
      "expected": "What correct behaviour looks like",
      "check": "html_contains",
      "value": "exact string to search for in HTML"
    }
  ]
}

HTML source:
${stripped}`;

  for (let m = 0; m < geminiModels.length; m++) {
    const modelNames = ["Gemini 2.5 Flash", "Gemini 1.5 Flash"];
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const result = await geminiModels[m].generateContent(prompt);
        console.log(`   🔵 AI converted ${userTests.length} descriptions → checks (${modelNames[m]})\n`);
        const raw = result.response.text().trim()
          .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        const parsed = JSON.parse(raw);
        return parsed.testCases ?? parsed;
      } catch (err) {
        const isQuota = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        if (isQuota) { console.log(`   ⚠️  ${modelNames[m]} quota — switching…`); break; }
        const is429 = err.message?.includes("429");
        const is503 = err.message?.includes("503");
        if ((!is429 && !is503) || attempt === 4) throw err;
        const wait = is503 ? 15000 : 30000;
        console.log(`   ⏳ Retrying in ${wait / 1000}s…`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw new Error("All AI models exhausted");
}

// runCheck is imported from utils.js

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

  // Step 1: Fetch HTML
  const html = await getHtml(TARGET_URL);  // from utils.js

  // Step 2: AI converts descriptions → executable checks
  console.log(`🤖 Converting ${USER_TESTS.length} test descriptions to executable checks…`);
  const testCases = await convertToChecks(html, USER_TESTS);

  // Step 3: Run checks
  const failures = [];
  let passed = 0;

  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}  ${tc.name}... `);
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

  // Step 4: AI classify failures → Jira
  let jiraCount = 0;
  if (failures.length > 0) {
    for (const f of failures) {
      await postResult({ id: f.id, name: f.title, status: "classifying" });
    }
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

  // Save test cases and run results to storage
  saveTestCases(siteName, SPRINT_NAME, testCases, { source: "manual", url: TARGET_URL, userTests: USER_TESTS });
  saveRunResult(siteName, SPRINT_NAME, RUN_ID, [], {
    passed, failed: testCases.length - passed, total: testCases.length, sprint: SPRINT_NAME
  });

  console.log("\n" + "═".repeat(54));
  console.log(`   ✅ Passed       : ${passed}`);
  console.log(`   ❌ Failed       : ${testCases.length - passed}`);
  console.log(`   🎫 Jira tickets : ${jiraCount} created`);
  console.log(`   💾 Saved to     : test-suites/${siteName}/${SPRINT_NAME}/`);
  console.log("═".repeat(54) + "\n");
}

main().catch(err => {
  console.error("[Manual Runner Error]", err.message);
  process.exit(1);
});
