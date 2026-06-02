// storage.js — Persistent test suite storage organised by domain → sprint → run
const fs   = require("fs");
const path = require("path");

const BASE_DIR = path.join(__dirname, "test-suites");

function sanitize(name) {
  // keep dots (for domain names), replace everything else unsafe
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// ── Save generated test cases for a domain + sprint ───────────────────────────
function saveTestCases(domain, sprint, testCases, extra = {}) {
  const dir = path.join(BASE_DIR, sanitize(domain), "sprints", sanitize(sprint));
  ensureDir(dir);
  const data = {
    domain, sprint,
    generatedAt: new Date().toISOString(),
    count: testCases.length,
    ...extra,
    testCases
  };
  fs.writeFileSync(path.join(dir, "testcases.json"), JSON.stringify(data, null, 2));
  _updateMeta(domain, sprint);
  console.log(`   💾 Saved → test-suites/${sanitize(domain)}/sprints/${sanitize(sprint)}/testcases.json\n`);
  return dir;
}

// ── Save a single run result ──────────────────────────────────────────────────
function saveRunResult(domain, sprint, runId, results, summary) {
  const dir = path.join(BASE_DIR, sanitize(domain), "sprints", sanitize(sprint), "runs", runId);
  ensureDir(dir);
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "results.json"),
    JSON.stringify({ runId, domain, sprint, timestamp: ts, results }, null, 2));
  fs.writeFileSync(path.join(dir, "summary.json"),
    JSON.stringify({ runId, domain, sprint, timestamp: ts, ...summary }, null, 2));
  _updateMeta(domain, sprint, summary);
  return dir;
}

// ── Load saved test cases ─────────────────────────────────────────────────────
function loadTestCases(domain, sprint) {
  const file = path.join(BASE_DIR, sanitize(domain), "sprints", sanitize(sprint), "testcases.json");
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return data.testCases;
}

// ── List all tested sites ─────────────────────────────────────────────────────
function listSites() {
  if (!fs.existsSync(BASE_DIR)) return [];
  return fs.readdirSync(BASE_DIR)
    .filter(d => fs.statSync(path.join(BASE_DIR, d)).isDirectory())
    .map(d => {
      const metaPath = path.join(BASE_DIR, d, "meta.json");
      return fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, "utf8"))
        : { domain: d, sprints: [], totalRuns: 0, lastTested: null };
    })
    .sort((a, b) => new Date(b.lastTested || 0) - new Date(a.lastTested || 0));
}

// ── List sprints for a site ───────────────────────────────────────────────────
function listSprints(domain) {
  const dir = path.join(BASE_DIR, sanitize(domain), "sprints");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(d => fs.statSync(path.join(dir, d)).isDirectory())
    .map(d => {
      const tcFile = path.join(dir, d, "testcases.json");
      const info   = fs.existsSync(tcFile) ? JSON.parse(fs.readFileSync(tcFile, "utf8")) : {};
      const runsDir = path.join(dir, d, "runs");
      const runCount = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0;
      return {
        sprint:      d,
        generatedAt: info.generatedAt || null,
        count:       info.count       || 0,
        source:      info.source      || "url",
        runCount
      };
    })
    .sort((a, b) => new Date(b.generatedAt || 0) - new Date(a.generatedAt || 0));
}

// ── List runs for a site + sprint ─────────────────────────────────────────────
function listRuns(domain, sprint) {
  const dir = path.join(BASE_DIR, sanitize(domain), "sprints", sanitize(sprint), "runs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(d => fs.statSync(path.join(dir, d)).isDirectory())
    .map(d => {
      const sumPath = path.join(dir, d, "summary.json");
      return fs.existsSync(sumPath)
        ? JSON.parse(fs.readFileSync(sumPath, "utf8"))
        : { runId: d };
    })
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}

// ── Internal: update site-level meta.json ────────────────────────────────────
function _updateMeta(domain, sprint, summary = null) {
  const siteDir  = path.join(BASE_DIR, sanitize(domain));
  ensureDir(siteDir);
  const metaPath = path.join(siteDir, "meta.json");
  let meta = fs.existsSync(metaPath)
    ? JSON.parse(fs.readFileSync(metaPath, "utf8"))
    : { domain, sprints: [], totalRuns: 0, lastTested: null, lastSummary: null };

  if (!meta.sprints.includes(sprint)) meta.sprints.push(sprint);
  meta.lastTested = new Date().toISOString();
  if (summary) { meta.totalRuns = (meta.totalRuns || 0) + 1; meta.lastSummary = summary; }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

module.exports = { saveTestCases, saveRunResult, loadTestCases, listSites, listSprints, listRuns, sanitize, BASE_DIR };
