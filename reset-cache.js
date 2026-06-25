// reset-cache.js
// Run this after deleting Jira tickets so the pipeline can create fresh ones.
// Usage: node reset-cache.js

const fs   = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "jira-dedup-cache.json");

if (fs.existsSync(CACHE_FILE)) {
  const cache   = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  const count   = Object.keys(cache).length;
  fs.writeFileSync(CACHE_FILE, "{}", "utf8");
  console.log(`✅ Cache cleared — removed ${count} stored ticket(s).`);
  console.log(`   Next run will create fresh Jira tickets for any failing tests.`);
} else {
  console.log(`ℹ️  No cache file found — nothing to clear.`);
}
