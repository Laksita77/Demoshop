require("dotenv").config();
const { execSync } = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const JIRA_AUTH = Buffer.from(
  process.env.JIRA_EMAIL + ":" + process.env.JIRA_API_TOKEN
).toString("base64");

const BASE = process.env.JIRA_BASE_URL;
const KEY  = process.env.JIRA_PROJECT_KEY;

console.log("Testing Jira connection...");
console.log("  Base URL:", BASE);
console.log("  Project :", KEY);
console.log("  Email   :", process.env.JIRA_EMAIL);
console.log("");

// ── Step 1: Test /myself ───────────────────────────────────────────────────────
function runPS(script) {
  const ts  = Date.now();
  const ps1 = path.join(os.tmpdir(), `jtest_${ts}.ps1`);
  const out = path.join(os.tmpdir(), `jtest_out_${ts}.txt`);

  fs.writeFileSync(ps1, script.replace(/OUT_FILE/g, out.replace(/\\/g, "/")), "utf8");
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, {
      encoding: "utf8", timeout: 15000
    });
    return { ok: true, body: fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim() : "" };
  } catch (e) {
    return { ok: false, body: fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim() : e.message };
  } finally {
    [ps1, out].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  }
}

// Test 1: Auth check
const r1 = runPS(`
$ErrorActionPreference = 'SilentlyContinue'
$h = @{ Authorization='Basic ${JIRA_AUTH}'; Accept='application/json' }
$r = Invoke-RestMethod -Uri '${BASE}/rest/api/3/myself' -Headers $h
if ($r) { $r.emailAddress | Out-File 'OUT_FILE' -Encoding utf8 -NoNewline }
else { "FAILED-no response" | Out-File 'OUT_FILE' -Encoding utf8 -NoNewline }
`);

if (r1.ok && r1.body && !r1.body.startsWith("FAILED")) {
  console.log("✅ Auth OK — logged in as:", r1.body);
} else {
  console.log("❌ Auth FAILED:", r1.body || "no response (network/proxy blocked?)");
  process.exit(1);
}

// Test 2: Project access
const r2 = runPS(`
$ErrorActionPreference = 'SilentlyContinue'
$h = @{ Authorization='Basic ${JIRA_AUTH}'; Accept='application/json' }
$r = Invoke-RestMethod -Uri '${BASE}/rest/api/3/project/${KEY}' -Headers $h
if ($r) { $r.name | Out-File 'OUT_FILE' -Encoding utf8 -NoNewline }
else { "NOT FOUND" | Out-File 'OUT_FILE' -Encoding utf8 -NoNewline }
`);

if (r2.ok && r2.body && r2.body !== "NOT FOUND") {
  console.log("✅ Project OK — found:", r2.body);
} else {
  console.log("❌ Project FAILED:", r2.body || "project not found");
}

// Test 3: Create a test ticket
console.log("\nAttempting to create a test Jira ticket...");
const testBody = JSON.stringify({
  fields: {
    project:     { key: KEY },
    summary:     "TEST TICKET — automated connection check",
    issuetype:   { name: "Task" },
    description: {
      type: "doc", version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "This is a test ticket from DemoShop." }] }]
    }
  }
});

const ts2  = Date.now();
const body = path.join(os.tmpdir(), `jbody_${ts2}.json`);
fs.writeFileSync(body, testBody, "utf8");

const r3 = runPS(`
$ErrorActionPreference = 'SilentlyContinue'
$h = @{ Authorization='Basic ${JIRA_AUTH}'; Accept='application/json' }
try {
  $r = Invoke-RestMethod -Uri '${BASE}/rest/api/3/issue' -Method POST -Headers $h -InFile '${body.replace(/\\/g, "/")}' -ContentType 'application/json'
  $r.key | Out-File 'OUT_FILE' -Encoding utf8 -NoNewline
} catch {
  $code = [int]$_.Exception.Response.StatusCode
  $msg = $_.ErrorDetails.Message
  "ERROR:$code::$msg" | Out-File 'OUT_FILE' -Encoding utf8 -NoNewline
}
`);

try { fs.unlinkSync(body); } catch (_) {}

if (r3.ok && r3.body && !r3.body.startsWith("ERROR")) {
  console.log("✅ Ticket created:", r3.body);
  console.log("   Link:", BASE + "/browse/" + r3.body);
} else {
  console.log("❌ Ticket creation FAILED:", r3.body);
  if (r3.body.includes("401")) console.log("   → API token is wrong or expired");
  if (r3.body.includes("403")) console.log("   → No permission to create issues in project", KEY);
  if (r3.body.includes("404")) console.log("   → Project key '" + KEY + "' not found");
  if (!r3.body)                console.log("   → Network blocked (Zscaler?)");
}
