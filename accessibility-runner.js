// accessibility-runner.js
// node accessibility-runner.js --url https://myntra.com --sprint Sprint-01
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getHtml, stripHtml, runCheck } = require("./utils");
const { saveTestCases, saveRunResult }  = require("./storage");
const { runBatchAutomation }            = require("./automation");

const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const genAI2 = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY);
const geminiModels = [
  { model: genAI.getGenerativeModel({ model: "gemini-2.5-flash" }),        name: "Gemini 2.5 Flash [K1]"      },
  { model: genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" }),   name: "Gemini 2.5 Flash Lite [K1]" },
  { model: genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" }),name: "Gemini Flash Lite [K1]"     },
  { model: genAI.getGenerativeModel({ model: "gemini-2.0-flash" }),        name: "Gemini 2.0 Flash [K1]"      },
  { model: genAI2.getGenerativeModel({ model: "gemini-2.5-flash" }),       name: "Gemini 2.5 Flash [K2]"      },
  { model: genAI2.getGenerativeModel({ model: "gemini-2.5-flash-lite" }),  name: "Gemini 2.5 Flash Lite [K2]" },
  { model: genAI2.getGenerativeModel({ model: "gemini-flash-lite-latest"}),name: "Gemini Flash Lite [K2]"     },
  { model: genAI2.getGenerativeModel({ model: "gemini-2.0-flash" }),       name: "Gemini 2.0 Flash [K2]"      },
];

const RUN_ID = `a11y-${Date.now()}`;
const arg = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i+1] : null; };
const TARGET_URL  = arg("--url");
const SPRINT_NAME = arg("--sprint") || `a11y-${new Date().toISOString().split("T")[0]}`;

async function postResult(data) {
  try {
    await fetch(`${process.env.SERVER_URL || "http://localhost:3000"}/test-result`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ ...data, runId: RUN_ID }),
      signal: AbortSignal.timeout(3000)
    });
  } catch(_) {}
}

async function generateA11yTests(html) {
  const stripped = stripHtml(html, 80000);
  const prompt = `You are a senior accessibility engineer conducting a WCAG 2.1 audit.
Analyze this HTML and generate 10-12 test cases for accessibility compliance.
Check ONLY things visible in HTML source (not dynamic JS behavior).

Focus on:
- Images: alt attributes present and non-empty → html_contains 'alt="'
- Forms: inputs have labels (for/id linkage or aria-label)
- Page structure: <h1> heading exists
- Language: <html lang=""> attribute is present
- Page title: <title> is non-empty
- Viewport: meta viewport is correct
- Skip navigation: skip-to-content link
- ARIA: aria-label on icon buttons
- Links: no empty href="#" without aria
- Required fields: use required attribute

Map each test to a WCAG criterion ID (e.g. "1.1.1") and level (A or AA).

Return ONLY valid JSON — no markdown:
{
  "testCases": [
    {
      "id": "AC-01",
      "area": "Accessibility",
      "wcag": "1.1.1",
      "level": "A",
      "name": "Images have alt text",
      "expected": "All img elements should have a non-empty alt attribute",
      "check": "html_contains",
      "value": "alt="
    }
  ]
}

HTML:
${stripped}`;

  for (const { model, name: modelName } of geminiModels) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        console.log(`   🔵 AI: ${modelName}\n`);
        const raw = result.response.text().trim().replace(/^```json\s*/i,"").replace(/```\s*$/i,"").trim();
        const parsed = JSON.parse(raw);
        return parsed.testCases ?? parsed;
      } catch(err) {
        const isQuota = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        const is404   = err.message?.includes("404");
        if (isQuota || is404) { console.log(`   ⚠️  ${modelName} ${is404?"not available":"quota exhausted"} — switching…`); break; }
        const retryable = err.message?.includes("429") || err.message?.includes("503");
        if (!retryable || attempt === 3) { console.log(`   ⚠️  ${modelName} failed — switching…`); break; }
        await new Promise(r => setTimeout(r, 15000));
      }
    }
  }
  throw new Error("All AI models unavailable. Please try again later.");
}

async function main() {
  const domain = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";
  console.log("═".repeat(58));
  console.log(`   ♿ WCAG 2.1 Accessibility Audit`);
  console.log(`   Site   : ${domain}`);
  console.log(`   Sprint : ${SPRINT_NAME}`);
  console.log("═".repeat(58) + "\n");

  const html = await getHtml(TARGET_URL);
  console.log(`\n🤖 Generating WCAG 2.1 test cases…\n`);
  const testCases = await generateA11yTests(html);
  saveTestCases(domain, SPRINT_NAME, testCases, { source:"accessibility", url: TARGET_URL });

  const failures = [];
  let passed = 0, levelA = 0, levelAA = 0;

  for (const tc of testCases) {
    const wcagTag = tc.wcag ? `[WCAG ${tc.wcag} Level ${tc.level||"A"}]` : "";
    process.stdout.write(`  ${tc.id} ${wcagTag} ${tc.name}… `);
    await postResult({ id:tc.id, name:tc.name, area:"Accessibility", status:"running" });
    try {
      const result = runCheck(html, tc);
      if (result.passed) {
        console.log("✅ PASS");
        passed++;
        await postResult({ id:tc.id, name:tc.name, area:"Accessibility", status:"pass" });
      } else {
        console.log(`❌ FAIL — ${result.actual}`);
        await postResult({ id:tc.id, name:tc.name, area:"Accessibility", status:"fail", actual:result.actual });
        failures.push({ id:tc.id, title:`[ACCESSIBILITY] ${tc.id} — ${tc.name}`, errorValue:result.actual,
          culprit:`WCAG ${tc.wcag||"N/A"} Level ${tc.level||"A"}`, testCase:tc.id, expected:tc.expected, area:"Accessibility" });
        if ((tc.level||"A") === "A") levelA++;
        else levelAA++;
      }
    } catch(err) { console.log(`💥 ERROR — ${err.message}`); }
  }

  let jiraCount = 0, duplicateCount = 0;
  if (failures.length > 0) {
    for (const f of failures) await postResult({ id:f.id, name:f.title, status:"classifying" });
    try {
      const results = await runBatchAutomation(failures, async (r) => {
        const failure = failures.find(f => f.id === r.id);
        await postResult({ id:r.id, name:failure?.title||r.id, area:"Accessibility",
          status:"fail", actual:failure?.errorValue, category:r.category, reason:r.reason, jiraUrl:r.jiraUrl });
      });
      jiraCount      = results.filter(r => r.logged).length;
      duplicateCount = results.filter(r => r.duplicate).length;
    } catch(err) { console.log(`\n💥 Error — ${err.message}\n`); }
  }

  await postResult({ id:"__done__", runFinished:true });
  saveRunResult(domain, SPRINT_NAME, RUN_ID, [], { passed, failed:testCases.length-passed, total:testCases.length, sprint:SPRINT_NAME });

  const score = Math.round((passed/testCases.length)*100);
  console.log("\n" + "═".repeat(58));
  console.log(`   ♿ Accessibility Score : ${score}%  (${passed}/${testCases.length} passed)`);
  console.log(`   🔴 Critical (Level A) : ${levelA} violation(s)`);
  console.log(`   🟡 Major   (Level AA) : ${levelAA} violation(s)`);
  console.log(`   🎫 Jira tickets       : ${jiraCount} created`);
  if (duplicateCount > 0) console.log(`   🔁 Duplicates        : ${duplicateCount} already in Jira`);
  console.log("═".repeat(58) + "\n");
}

main().catch(err => { console.error("[Accessibility Error]", err.message); process.exit(1); });
