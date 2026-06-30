require("dotenv").config();
const { spawn } = require("child_process");
const path      = require("path");
const fs        = require("fs");
const os        = require("os");

// ── Known site shortcuts ──────────────────────────────────────────────────────
const KNOWN_SITES = {
  flipkart:    "https://www.flipkart.com",
  amazon:      "https://www.amazon.in",
  myntra:      "https://www.myntra.com",
  meesho:      "https://www.meesho.com",
  nykaa:       "https://www.nykaa.com",
  snapdeal:    "https://www.snapdeal.com",
  ajio:        "https://www.ajio.com",
  swiggy:      "https://www.swiggy.com",
  zomato:      "https://www.zomato.com",
  bigbasket:   "https://www.bigbasket.com",
  saucedemo:   "https://www.saucedemo.com",
  automation:  "https://automationexercise.com",
  demoblaze:   "https://www.demoblaze.com",
  demoqa:      "https://demoqa.com"
};

// ── Parse user intent locally (no API quota needed) ───────────────────────────
function parseIntent(message) {
  const msg = message.toLowerCase().trim();

  // 1. Extract URL — strip trailing punctuation that gets accidentally included
  const urlMatch = message.match(/https?:\/\/[^\s]+/i);
  let url = urlMatch ? urlMatch[0].replace(/[,.)>\]'"}\s]+$/, "") : null;

  // 2. Detect domain names like "flipkart.com"
  if (!url) {
    const domainMatch = message.match(/\b([a-zA-Z0-9-]+\.(com|in|org|net|io|co\.in|edu))\b/i);
    if (domainMatch) url = `https://${domainMatch[1]}`;
  }

  // 3. Detect well-known site names
  if (!url) {
    for (const [name, siteUrl] of Object.entries(KNOWN_SITES)) {
      if (msg.includes(name)) { url = siteUrl; break; }
    }
  }

  // 4. Extract test count — "4 test cases", "6 tests"
  const countMatch = msg.match(/\b(\d+)\s*(test cases?|tests?|cases?)\b/);
  const count = countMatch ? parseInt(countMatch[1]) : null;

  // 5. Extract sprint name — "Sprint 23", "sprint-5", "Sprint QA"
  const sprintMatch = msg.match(/\bsprint[-\s]?(\w+)\b/i);
  const sprint = sprintMatch ? `Sprint-${sprintMatch[1]}` : null;

  // ── HELP ────────────────────────────────────────────────────────────────────
  const helpWords = ["help", "what can", "what do", "how do", "commands", "options"];
  if (helpWords.some(w => msg.includes(w))) {
    return { intent: "HELP", url: null, count: null, sprint: null, story: null, tests: [], reply: "Here is what I can do for you:" };
  }

  // ── VIEW_HISTORY — show saved test suites ───────────────────────────────────
  const historyWords = ["history", "past run", "previous result", "what was tested", "saved test", "test suite", "show suite", "show history"];
  if (historyWords.some(w => msg.includes(w))) {
    return { intent: "VIEW_HISTORY", url: null, count: null, sprint: null, story: null, tests: [], reply: "📚 Loading your test history…" };
  }

  // ── USER_STORY — user provides a user story or sprint test description ───────
  // Detect: "user story:", "as a user", "given that", "sprint 23 test", "acceptance criteria"
  const storyWords = ["user story", "story:", "as a user", "as an", "given that", "acceptance criteria", "i want to be able", "should be able", "gherkin"];
  const hasStory   = storyWords.some(w => msg.includes(w));

  // Also detect when user says "test sprint 23 for flipkart" without a story body
  const sprintTest = sprint && (msg.includes("test") || msg.includes("generate") || msg.includes("create"));

  if (hasStory || sprintTest) {
    const label   = url ? new URL(url).hostname : "the website";
    const spLabel = sprint || `run-${new Date().toISOString().split("T")[0]}`;
    return {
      intent: "USER_STORY",
      url,
      count:  count || 6,
      sprint: spLabel,
      story:  message,
      tests:  [],
      reply:  `📋 Generating ${count || 6} test cases from your story for ${label} [${spLabel}]…`
    };
  }

  // ── MANUAL_TESTS — user provides their own test descriptions ─────────────────
  const manualWords    = ["manual", "my test", "i want to check", "i want to verify", "custom test", "manually"];
  const generateWords2 = ["generate", "analyse", "analyze", "create test", "scan", "check website", "test website", "find bugs in"];
  // Strip URLs before checking for colons so "https://..." doesn't trigger manual mode
  const hasColon   = msg.replace(/https?:\/\/[^\s]*/g, "").includes(":");
  const hasManual  = manualWords.some(w => msg.includes(w));
  const isGenerate = generateWords2.some(w => msg.includes(w));

  // Detect pasted test cases: TC-01, TC01, lines with "Action:" / "Expected:" patterns
  const hasTcPattern  = /\bTC[-\s]?\d+\b/i.test(message);
  const hasActionExp  = /\b(action|expected|steps?|verify|check)\s*:/i.test(message);
  const isMultiLine   = message.split("\n").filter(l => l.trim().length > 4).length >= 2;
  const isPastedTests = (hasTcPattern || (hasActionExp && isMultiLine));

  if (!isGenerate && (hasManual || isPastedTests || (hasColon && (url || msg.includes("shop"))))) {
    let tests = [];

    if (isPastedTests) {
      // Parse pasted TC blocks — split by TC-XX or numbered lines
      tests = message
        .split(/\n(?=TC[-\s]?\d+|\d+[\.\)])/i)
        .map(block => {
          // Use the first non-empty line of each block as the test name
          const firstLine = block.split("\n").map(l => l.trim()).find(l => l.length > 3);
          return firstLine || "";
        })
        .filter(t => t.length > 3);

      // Fallback: just use every non-empty line
      if (tests.length === 0) {
        tests = message.split("\n").map(t => t.trim()).filter(t => t.length > 3);
      }
    } else {
      const colonIdx = message.indexOf(":");
      const rawTests = colonIdx !== -1 ? message.slice(colonIdx + 1) : message;
      tests = rawTests
        .split(/[,\n]|\d+\.\s+/)
        .map(t => t.trim())
        .filter(t => t.length > 3);
    }

    if (tests.length > 0) {
      const label = url ? new URL(url).hostname : "shop.html";
      return { intent: "MANUAL_TESTS", url, count: null, sprint: sprint || null, story: null, tests, reply: `📝 Running ${tests.length} custom test(s) on ${label}…` };
    }
  }

  // ── GENERATE_TESTS — AI generates tests from URL ─────────────────────────────
  const generateWords = ["generate", "analyse", "analyze", "create test", "test case", "scan", "check website", "test website", "find bugs in"];
  if (url || generateWords.some(w => msg.includes(w))) {
    const label      = url || "the website";
    const countLabel = count ? ` (${count} test cases)` : "";
    const spLabel    = sprint || null;
    return { intent: "GENERATE_TESTS", url, count, sprint: spLabel, story: null, tests: [], reply: `🌐 Fetching and analysing ${label}${countLabel}…` };
  }

  // ── RUN_TESTS — run existing shop.html tests ──────────────────────────────────
  const runWords = ["run", "start", "execute", "find bug", "detect bug", "test shop", "test the shop", "check shop", "go", "begin"];
  if (runWords.some(w => msg.includes(w))) {
    return { intent: "RUN_TESTS", url: null, count: null, sprint: null, story: null, tests: [], reply: "▶ Starting test runner on shop.html…" };
  }

  return {
    intent: "UNKNOWN", url: null, count: null, sprint: null, story: null, tests: [],
    reply: "I can run tests, generate tests for any website, or test from a user story.\n\nTry:\n• 'generate 5 test cases for flipkart.com'\n• 'User story: As a user I want to search for products on https://myntra.com'\n• 'Sprint-23 tests for https://snapdeal.com'\n• 'manual: check login, verify cart on amazon.in'"
  };
}

// ── Main chat handler ─────────────────────────────────────────────────────────
async function handleChat(message, send) {
  send({ type: "thinking", text: "Analysing your request…" });

  const intent = parseIntent(message);
  send({ type: "reply", text: intent.reply });

  // ── HELP ──────────────────────────────────────────────────────────────────
  if (intent.intent === "HELP") {
    send({ type: "info", text: [
      "Here is what I can do:",
      "",
      "🔹 **Run tests** on shop.html",
      "   → 'run tests' / 'find bugs'",
      "",
      "🔹 **Generate & run AI tests** for any website",
      "   → 'generate 6 test cases for https://flipkart.com'",
      "   → 'analyse myntra for bugs'",
      "",
      "🔹 **User story / Sprint tests** (QA workflow)",
      "   → 'User story: As a user I want to log in on https://site.com'",
      "   → 'Sprint-23 tests for https://snapdeal.com'",
      "",
      "🔹 **Manual test cases** you define",
      "   → 'manual: check login, verify search bar on amazon.in'",
      "",
      "🔹 **View history**",
      "   → 'show test history' / 'what was tested'"
    ].join("\n") });
    send({ type: "done" });
    return;
  }

  // ── UNKNOWN ───────────────────────────────────────────────────────────────
  if (intent.intent === "UNKNOWN") {
    send({ type: "info", text: intent.reply });
    send({ type: "done" });
    return;
  }

  // ── VIEW_HISTORY ──────────────────────────────────────────────────────────
  if (intent.intent === "VIEW_HISTORY") {
    try {
      const { listSites, listSprints } = require("./storage");
      const sites = listSites();
      if (sites.length === 0) {
        send({ type: "info", text: "📭 No test history yet. Generate some tests first!" });
      } else {
        const lines = ["📚 Saved Test Suites:\n"];
        for (const s of sites) {
          const ago = s.lastTested
            ? new Date(s.lastTested).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
            : "never";
          const last = s.lastSummary ? ` (last: ${s.lastSummary.passed}✅ ${s.lastSummary.failed}❌)` : "";
          lines.push(`🌐 ${s.domain}${last}`);
          lines.push(`   Runs: ${s.totalRuns}  ·  Last: ${ago}`);
          const sprints = listSprints(s.domain);
          if (sprints.length) {
            lines.push(`   Sprints: ${sprints.map(sp => sp.sprint).join(", ")}`);
          }
          lines.push("");
        }
        send({ type: "info", text: lines.join("\n") });
      }
    } catch (err) {
      send({ type: "error", text: `Could not load history: ${err.message}` });
    }
    send({ type: "done" });
    return;
  }

  // ── RUN_TESTS ─────────────────────────────────────────────────────────────
  if (intent.intent === "RUN_TESTS") {
    send({ type: "log", text: "▶  Starting test runner against shop.html…\n" });
    await runProcess("node", ["testrunner.js"], send);
    return;
  }

  // ── USER_STORY — story-runner.js ─────────────────────────────────────────
  if (intent.intent === "USER_STORY") {
    // Write story to temp file to avoid shell escaping issues
    const tmpFile = path.join(os.tmpdir(), `qa-story-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ story: intent.story }), "utf8");

    const args = ["story-runner.js", "--story-file", tmpFile, "--sprint", intent.sprint, "--count", String(intent.count)];
    if (intent.url) args.push("--url", intent.url);

    send({ type: "log", text: [
      `📋 Story-Based Test Run`,
      `   Sprint : ${intent.sprint}`,
      `   Site   : ${intent.url || "shop.html"}`,
      `   Tests  : ${intent.count}`,
      `   Story  : ${intent.story.slice(0, 100)}…`,
      ""
    ].join("\n") });
    await runProcess("node", args, send);
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    return;
  }

  // ── MANUAL_TESTS ──────────────────────────────────────────────────────────
  if (intent.intent === "MANUAL_TESTS") {
    // Write tests to temp file to avoid shell escaping issues with special chars
    const tmpFile = path.join(os.tmpdir(), `qa-tests-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ tests: intent.tests }), "utf8");

    const args = ["manual-runner.js", "--tests-file", tmpFile];
    if (intent.url)    args.push("--url",    intent.url);
    if (intent.sprint) args.push("--sprint", intent.sprint);

    send({ type: "log", text: `📝 Manual tests:\n${intent.tests.map((t, i) => `   ${i + 1}. ${t}`).join("\n")}\n\n` });
    await runProcess("node", args, send);
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    return;
  }

  // ── GENERATE_TESTS ────────────────────────────────────────────────────────
  if (intent.intent === "GENERATE_TESTS") {
    const args = ["generate-tests.js"];
    if (intent.url)    args.push("--url",    intent.url);
    if (intent.count)  args.push("--count",  String(intent.count));
    if (intent.sprint) args.push("--sprint", intent.sprint);

    const target     = intent.url || "shop.html";
    const countLabel = intent.count ? ` (${intent.count} test cases)` : "";
    send({ type: "log", text: `▶  Generating AI tests for ${target}${countLabel}…\n` });
    await runProcess("node", args, send);
    return;
  }

  send({ type: "done" });
}

// ── Spawn a child process and stream its output ───────────────────────────────
function runProcess(cmd, args, send) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd:   path.join(__dirname),
      shell: true,
      env:   { ...process.env }
    });

    child.stdout.on("data", (d) => send({ type: "log", text: d.toString() }));
    child.stderr.on("data", (d) => {
      const m = d.toString().trim();
      if (m) send({ type: "log", text: m + "\n" });
    });

    child.on("close", (code) => {
      if (code === 0) {
        send({ type: "success", text: "✅ Pipeline completed successfully!" });
      } else {
        send({ type: "error", text: `⚠️  Process exited with code ${code}` });
      }
      send({ type: "done" });
      resolve();
    });

    child.on("error", (err) => {
      send({ type: "error", text: `Failed to start: ${err.message}` });
      send({ type: "done" });
      resolve();
    });
  });
}

module.exports = { handleChat };
