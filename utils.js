// utils.js — Shared utilities: HTML fetching, stripping, check execution
const fs   = require("fs");
const path = require("path");

// ── Corporate-SSL-safe HTTPS fetcher (follows redirects) ─────────────────────
function httpsGet(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 6) return reject(new Error("Too many redirects"));
    const https  = require("https");
    const urlObj = new URL(targetUrl);
    const opts   = {
      hostname: urlObj.hostname,
      port:     urlObj.port || 443,
      path:     (urlObj.pathname || "/") + (urlObj.search || ""),
      method:   "GET",
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,*/*;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity"
      },
      rejectUnauthorized: false   // bypass corporate SSL interception
    };
    const req = https.request(opts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, targetUrl).href;
        return resolve(httpsGet(next, redirectCount + 1));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => (body += c));
      res.on("end",  () => {
        console.log(`   ✅ Fetched ${Math.round(body.length / 1024)} KB via HTTPS (SSL-bypass)\n`);
        resolve(body);
      });
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout fetching " + targetUrl)); });
    req.on("error", reject);
    req.end();
  });
}

// ── Fetch HTML: local shop.html → Playwright → HTTPS fallback ────────────────
async function getHtml(targetUrl) {
  if (!targetUrl) {
    return fs.readFileSync(path.join(__dirname, "shop.html"), "utf8");
  }

  console.log(`\n🌐 Fetching HTML from: ${targetUrl}\n`);

  // Try Playwright (full JS rendering, handles SPAs & bot challenges)
  try {
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ headless: true });
    const page    = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    });
    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
      const html = await page.content();
      console.log(`   ✅ Fetched ${Math.round(html.length / 1024)} KB via Playwright\n`);
      return html;
    } finally { await browser.close(); }
  } catch (_) {
    console.log(`   ⚠️  Playwright unavailable — using HTTPS fetch (SSL-bypass)…\n`);
  }

  return httpsGet(targetUrl);
}

// ── Strip HTML noise for AI context ──────────────────────────────────────────
function stripHtml(html, maxLen = 80000) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/data:[^"']*/g, "data:...")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

// ── Execute a single HTML-based check ────────────────────────────────────────
function runCheck(html, tc) {
  switch (tc.check) {
    case "attribute_value": {
      const line = html.split("\n").find(l =>
        new RegExp(`id=["']${tc.elementId}["']`, "i").test(l)
      );
      if (!line) return { passed: false, actual: `Element #${tc.elementId} not found` };
      const m = line.match(new RegExp(`\\b${tc.attribute}=["']([^"']+)["']`, "i"));
      const actual = m ? m[1] : "(absent)";
      return {
        passed: actual === tc.expectedValue,
        actual: `${tc.attribute}="${actual}"` + (actual !== tc.expectedValue ? ` — expected "${tc.expectedValue}"` : "")
      };
    }
    case "html_contains": {
      const found = html.includes(tc.value);
      return { passed: found, actual: found ? `Found: "${tc.value}"` : `Missing: "${tc.value}"` };
    }
    case "html_not_contains": {
      const found = html.includes(tc.value);
      return { passed: !found, actual: !found ? "Correctly absent" : `Found (should not exist): "${tc.value}"` };
    }
    default:
      return { passed: false, actual: `Unknown check type: ${tc.check}` };
  }
}

module.exports = { httpsGet, getHtml, stripHtml, runCheck };
