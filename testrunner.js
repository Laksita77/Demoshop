require("dotenv").config();
const TESTCASES                        = require("./testcases");
const { runBatchAutomation }           = require("./automation");

const RUN_ID = `run-${Date.now()}`;

async function postResult(data) {
  for (let i = 0; i < 3; i++) {
    try {
      await fetch(`${process.env.SERVER_URL || "http://localhost:3000"}/test-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, runId: RUN_ID }),
        signal: AbortSignal.timeout(3000)
      });
      return;
    } catch (_) {
      if (i < 2) await new Promise(r => setTimeout(r, 500));
    }
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────
function line(char = "═", len = 50) {
  return char.repeat(len);
}

// ── Main Runner ───────────────────────────────────────────────────────────────
async function runAllTests() {
  console.log("\n" + line());
  console.log("        DEMOSHOP — AUTOMATED TEST RUNNER");
  console.log(line());
  console.log(`  Running ${TESTCASES.length} test cases against shop.html`);
  console.log(`  Time   : ${new Date().toLocaleString()}`);
  console.log(line() + "\n");

  const results  = [];
  const failures = [];   // collect failures for batch AI call at the end

  // ── Phase 1: Run all tests ─────────────────────────────────────────────────
  for (const tc of TESTCASES) {
    console.log(`▶ ${tc.id} — ${tc.name}`);
    await postResult({ id: tc.id, name: tc.name, status: "running" });

    let result;
    try {
      result = tc.run();
    } catch (err) {
      console.log(`  💥 ERROR — ${err.message}\n`);
      results.push({ ...tc, passed: false, actual: `Test error: ${err.message}` });
      await postResult({ id: tc.id, name: tc.name, status: "error", actual: err.message });
      continue;
    }

    results.push({ ...tc, ...result });

    if (result.passed) {
      console.log(`  ✅ PASS\n`);
      await postResult({ id: tc.id, name: tc.name, status: "pass" });
    } else {
      console.log(`  ❌ FAIL`);
      console.log(`  Expected : ${tc.expected}`);
      console.log(`  Actual   : ${result.actual}\n`);
      await postResult({ id: tc.id, name: tc.name, status: "fail", actual: result.actual });

      // Queue for batch AI classification
      failures.push({
        id:         tc.id,
        title:      `${tc.id} — ${tc.name}`,
        errorType:  tc.name,
        errorValue: result.actual,
        culprit:    tc.id,
        testCase:   tc.id,
        expected:   tc.expected,
        area:       tc.area || ""
      });
    }
  }

  // ── Phase 2: ONE Gemini batch call for all failures ────────────────────────
  let jiraCount = 0;
  if (failures.length > 0) {
    // Mark all failed rows as "classifying" on dashboard
    for (const f of failures) {
      await postResult({ id: f.id, name: f.title, status: "classifying" });
    }

    try {
      const batchResults = await runBatchAutomation(failures, async (r) => {
        // Called immediately after each ticket is created — updates dashboard in real time
        const failure = failures.find(f => f.id === r.id);
        await postResult({
          id:       r.id,
          name:     failure?.title || r.id,
          status:   "fail",
          actual:   failure?.errorValue,
          category: r.category,
          reason:   r.reason,
          jiraUrl:  r.jiraUrl,
          pendingApproval: r.pendingApproval || false,
          duplicate: r.duplicate || false,
          duplicateKey: r.duplicateKey,
          repeatCount: r.repeatCount
        });
      });
      jiraCount = batchResults.filter(r => r.logged).length;
    } catch (err) {
      console.log(`\n💥 Batch AI Error — ${err.message}`);
      console.log(`   Full error: ${err.stack || err}\n`);
      for (const f of failures) {
        await postResult({ id: f.id, name: f.title, status: "fail", actual: f.errorValue });
      }
    }
  }

  await postResult({ id: "__done__", runFinished: true });

  // ── Final Report ────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log("\n" + line());
  console.log("                  TEST REPORT");
  console.log(line());
  console.log(`  Total Tests  : ${results.length}`);
  console.log(`  Passed       : ${passed} ✅`);
  console.log(`  Failed       : ${failed} ❌`);
  console.log(`  Jira Tickets : ${jiraCount} created (Trivial bugs skipped)`);
  console.log(line());

  console.log("\n  Detailed Results:");
  console.log("  " + line("─", 48));
  results.forEach(r => {
    const icon   = r.passed ? "✅" : "❌";
    const status = r.passed ? "PASS" : "FAIL";
    console.log(`  ${icon} ${r.id.padEnd(6)} ${status}  —  ${r.name}`);
  });

  console.log("\n" + line() + "\n");
}

// ── Run ───────────────────────────────────────────────────────────────────────
runAllTests().catch(err => {
  console.error("\n[TestRunner Error]", err.message);
  process.exit(1);
});
