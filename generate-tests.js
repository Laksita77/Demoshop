require("dotenv").config();
const fs                     = require("fs");
const path                   = require("path");
const Groq                   = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { runBatchAutomation } = require("./automation");
const { getHtml, stripHtml, runCheck: execCheck } = require("./utils");
const { saveTestCases, saveRunResult } = require("./storage");

const groq         = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI        = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModels = [
  genAI.getGenerativeModel({ model: "gemini-2.5-flash" }),
  genAI.getGenerativeModel({ model: "gemini-1.5-flash" }),
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
You are a senior QA engineer analyzing an e-commerce HTML page for bugs.

Analyze the HTML and generate test cases that check for issues detectable from the HTML source only.
Focus on:
- Input field types (password fields → type="password", phone → type="tel", email → type="email")
- Presence of validation attributes (pattern, required, maxlength, min, max)
- Form security (no credentials in plaintext inputs)
- Correct element attributes for accessibility and validation

Use EXACTLY one of these check types per test case:

1. attribute_value — check a specific input's attribute
   Required extra fields: "elementId", "attribute", "expectedValue"
   Only use this if the element has a clear, unique id attribute in the HTML.

2. html_contains — the HTML source must contain this exact string
   Required extra fields: "value"

3. html_not_contains — the HTML source must NOT contain this exact string
   Required extra fields: "value"

Return a JSON object with a "testCases" array of EXACTLY ${TEST_COUNT || "8–12"} test cases in this exact format:
{
  "testCases": [
    {
      "id": "AI-01",
      "area": "Security|Backend|Frontend|Performance",
      "name": "Short test name",
      "expected": "What correct behaviour looks like",
      "check": "attribute_value",
      "elementId": "element-id-without-hash",
      "attribute": "type",
      "expectedValue": "password"
    }
  ]
}

HTML:
${stripped}`;

  console.log(`\n🤖 Sending ${SOURCE_LABEL} to AI for test case generation…\n`);

  let rawText;
  try {
    const response = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      response_format: { type: "json_object" }
    });
    console.log("   🟢 Provider: Groq (Llama 3.3 70B)");
    rawText = response.choices[0].message.content;
  } catch (groqErr) {
    const blocked = groqErr.status === 403 || groqErr.message?.includes("403") || groqErr.message?.includes("blocked");
    console.log(`   ⚠️  Groq unavailable (${blocked ? "blocked by network" : groqErr.message}) — falling back to Gemini…`);

    const modelNames = ["Gemini 2.5 Flash", "Gemini 1.5 Flash"];
    for (let m = 0; m < geminiModels.length; m++) {
      const model = geminiModels[m];
      const modelName = modelNames[m];
      let succeeded = false;

      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const result = await model.generateContent(prompt);
          console.log(`   🔵 Provider: ${modelName} (fallback)`);
          rawText = result.response.text();
          succeeded = true;
          break;
        } catch (gemErr) {
          const isQuota = gemErr.message?.includes("quota") || gemErr.message?.includes("RESOURCE_EXHAUSTED");
          if (isQuota) {
            console.log(`   ⚠️  ${modelName} quota exhausted — switching to next model…`);
            break;
          }
          const retryable = gemErr.message?.includes("503") || gemErr.message?.includes("429");
          if (!retryable || attempt === 4) throw gemErr;
          const match  = gemErr.message.match(/retry in (\d+(?:\.\d+)?)s/i);
          const wait   = gemErr.message?.includes("503") ? 15000 : (match ? Math.ceil(parseFloat(match[1])) * 1000 + 1000 : 30000);
          console.log(`   ⏳ ${modelName} busy — waiting ${Math.ceil(wait / 1000)}s then retrying (${attempt}/4)…`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
      if (succeeded) break;
    }
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
async function runGeneratedTests(testCases, html) {
  const domain   = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";
  const failures = [];
  let passed = 0;

  console.log("═".repeat(54));
  console.log(`   ${domain} — AI Generated Test Runner`);
  console.log(`   Sprint : ${SPRINT_NAME}`);
  console.log("═".repeat(54) + "\n");

  // Phase 1: run all checks
  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}... `);
    await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "running" });

    try {
      const result = execCheck(html, tc);   // from utils.js
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
  let jiraCount = 0;
  if (failures.length > 0) {
    for (const f of failures) await postResult({ id: f.id, name: f.title, status: "classifying" });
    try {
      const batchResults = await runBatchAutomation(failures, async (r) => {
        const failure = failures.find(f => f.id === r.id);
        await postResult({
          id: r.id, name: failure?.title || r.id, area: failure?.area,
          status: "fail", actual: failure?.errorValue,
          category: r.category, reason: r.reason, jiraUrl: r.jiraUrl
        });
      });
      jiraCount = batchResults.filter(r => r.logged).length;
    } catch (err) {
      console.log(`\n💥 Batch AI Error — ${err.message}\n`);
    }
  }

  await postResult({ id: "__done__", runFinished: true });

  console.log("\n" + "═".repeat(54));
  console.log(`   ✅ Passed       : ${passed}`);
  console.log(`   ❌ Failed       : ${testCases.length - passed}`);
  console.log(`   🎫 Jira tickets : ${jiraCount} created`);
  console.log(`   💾 Saved to     : test-suites/${domain}/${SPRINT_NAME}/`);
  console.log("═".repeat(54) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const html      = await getHtml(TARGET_URL);
  const testCases = await generateTestCases(html);
  await runGeneratedTests(testCases, html);
}

main().catch(err => {
  console.error("[Generate Error]", err.message);
  process.exit(1);
});
