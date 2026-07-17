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

// ── Fetch HTML only — closes browser after (backward compat) ─────────────────
async function getHtml(targetUrl) {
  if (!targetUrl) {
    return fs.readFileSync(path.join(__dirname, "shop.html"), "utf8");
  }
  const { html, browser } = await getPageAndHtml(targetUrl);
  if (browser) await browser.close();
  return html;
}

// ── Open Playwright, keep browser alive for test execution ───────────────────
// Returns { html, page, browser }  — caller MUST call browser.close() when done
async function getPageAndHtml(targetUrl) {
  if (!targetUrl) {
    const html = fs.readFileSync(path.join(__dirname, "shop.html"), "utf8");
    return { html, page: null, browser: null };
  }

  console.log(`\n🌐 Launching Playwright for: ${targetUrl}\n`);

  try {
    const { chromium } = require("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    });
    // Give the page a reasonable viewport
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait for any JS-driven rendering to settle
    await page.waitForTimeout(3000);
    const html = await page.content();
    console.log(`   ✅ Page loaded — ${Math.round(html.length / 1024)} KB (browser stays open for live checks)\n`);
    return { html, page, browser };
  } catch (err) {
    console.log(`   ⚠️  Playwright failed (${err.message.slice(0, 80)}) — HTTPS fallback…\n`);
    const html = await httpsGet(targetUrl);
    return { html, page: null, browser: null };
  }
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

// ── Playwright check types (these require a live page object) ─────────────────
const PLAYWRIGHT_CHECKS = new Set([
  "visible", "not_visible", "text_contains", "count_gte",
  "attr_equals", "attr_contains", "url_contains", "title_contains",
  "click_then_visible", "fill_and_submit",
  "saucedemo_login_success", "saucedemo_login_error", "saucedemo_product_visible",
  "saucedemo_add_to_cart", "saucedemo_add_button_changes",
  "saucedemo_remove_from_cart", "saucedemo_readd_to_cart"
]);

// ── Case-insensitive CSS attribute selector helper ────────────────────────────
// Adds the CSS `i` flag to attribute value comparisons so [id='Password'] also
// matches [id='password'] in Playwright's locator engine.
function ciSelector(sel) {
  if (!sel) return sel;
  return sel.replace(/\[([^=\]]+)=['"]([^'"]+)['"]\]/g, "[$1='$2' i]");
}

async function openSauceDemoInventory(page, tc) {
  const targetUrl = tc.navigateUrl || tc.url || "https://www.saucedemo.com/";
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  }).catch(() => {});
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.fill("#user-name", tc.username || "");
  await page.fill("#password", tc.password || "");
  await page.click("#login-button");
  await page.waitForTimeout(1500);

  const inventoryVisible = await page.locator(".inventory_list").first().isVisible({ timeout: 5000 }).catch(() => false);
  if (!inventoryVisible) {
    return { ok: false, actual: `Login did not open inventory page. Current URL: ${page.url()}` };
  }
  return { ok: true, actual: "Inventory page is visible" };
}

function sauceDemoProduct(page, productName) {
  return page.locator(".inventory_item, [data-test='inventory-item']").filter({ hasText: productName }).first();
}

async function addSauceDemoProduct(page, productName) {
  const product = sauceDemoProduct(page, productName);
  const productVisible = await product.isVisible({ timeout: 5000 }).catch(() => false);
  if (!productVisible) return { ok: false, actual: `Product not found in inventory: "${productName}"` };

  const addButton = product.locator("button").filter({ hasText: /add to cart/i }).first();
  const removeButton = product.locator("button").filter({ hasText: /remove/i }).first();
  const addVisible = await addButton.isVisible({ timeout: 2000 }).catch(() => false);
  const removeVisible = await removeButton.isVisible({ timeout: 1000 }).catch(() => false);

  if (addVisible) {
    await addButton.click({ timeout: 5000 });
    await page.waitForTimeout(800);
    return { ok: true, alreadyAdded: false, actual: `"${productName}" was added to cart` };
  }
  if (removeVisible) return { ok: true, alreadyAdded: true, actual: `"${productName}" was already added to cart` };
  return { ok: false, actual: `Neither Add to cart nor Remove button was available for "${productName}"` };
}

async function cartBadgeText(page) {
  return String(await page.locator(".shopping_cart_badge, [data-test='shopping-cart-badge']").first().textContent({ timeout: 3000 }).catch(() => "") || "").trim();
}

// ── Execute a Playwright-based check against a live rendered page ─────────────
async function runPlaywrightCheck(page, tc) {
  // Navigate to a specific page before running this check
  // (used when a check is on a different page from the starting URL)
  if (tc.navigateUrl) {
    try {
      await page.goto(tc.navigateUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1500);
    } catch (navErr) {
      return { passed: false, actual: `Navigation to "${tc.navigateUrl}" failed: ${navErr.message.slice(0, 80)}` };
    }
  }

  const sel = tc.selector;
  try {
    switch (tc.check) {

      case "visible": {
        let vis = await page.locator(sel).first().isVisible({ timeout: 5000 }).catch(() => false);
        if (!vis) vis = await page.locator(ciSelector(sel)).first().isVisible({ timeout: 2000 }).catch(() => false);
        return {
          passed: vis,
          actual: vis
            ? `Visible: "${sel}"`
            : `Not visible or missing: "${sel}"`
        };
      }

      case "not_visible": {
        let vis = await page.locator(sel).first().isVisible({ timeout: 3000 }).catch(() => false);
        if (!vis) vis = await page.locator(ciSelector(sel)).first().isVisible({ timeout: 1000 }).catch(() => false);
        return {
          passed: !vis,
          actual: !vis
            ? `Correctly absent/hidden: "${sel}"`
            : `Should be hidden but is visible: "${sel}"`
        };
      }

      case "text_contains": {
        const loc  = page.locator(sel).first();
        const text = await loc.textContent({ timeout: 5000 }).catch(() => null);
        if (text === null) return { passed: false, actual: `Element not found: "${sel}"` };
        const found = text.toLowerCase().includes(tc.value.toLowerCase());
        return {
          passed: found,
          actual: found
            ? `Text found: "${tc.value}"`
            : `Text missing: "${tc.value}" — got: "${text.replace(/\s+/g, " ").slice(0, 100)}"`
        };
      }

      case "count_gte": {
        const count    = await page.locator(sel).count();
        const expected = parseInt(tc.expectedCount ?? 1, 10);
        return {
          passed: count >= expected,
          actual: count >= expected
            ? `Found ${count} element(s) (expected ≥${expected})`
            : `Expected ≥${expected}, found only ${count} for "${sel}"`
        };
      }

      case "attr_equals": {
        // Try original selector, then case-insensitive CSS variant as fallback
        let val = await page.locator(sel).first().getAttribute(tc.attribute, { timeout: 5000 }).catch(() => null);
        if (val === null) {
          val = await page.locator(ciSelector(sel)).first().getAttribute(tc.attribute, { timeout: 2000 }).catch(() => null);
        }
        // Case-insensitive value comparison
        const match = val !== null && val.toLowerCase() === (tc.expectedValue || "").toLowerCase();
        return {
          passed: match,
          actual: match
            ? `${tc.attribute}="${val}"`
            : `${tc.attribute}="${val ?? "(absent)"}" — expected "${tc.expectedValue}" on "${sel}"`
        };
      }

      case "attr_contains": {
        let val = await page.locator(sel).first().getAttribute(tc.attribute, { timeout: 5000 }).catch(() => null);
        if (val === null) {
          val = await page.locator(ciSelector(sel)).first().getAttribute(tc.attribute, { timeout: 2000 }).catch(() => null);
        }
        const match = val !== null && val.toLowerCase().includes((tc.value || "").toLowerCase());
        return {
          passed: match,
          actual: match
            ? `${tc.attribute} contains "${tc.value}"`
            : `${tc.attribute}="${val ?? "(absent)"}" missing "${tc.value}" on "${sel}"`
        };
      }

      case "url_contains": {
        const url   = page.url();
        const found = url.includes(tc.value);
        return {
          passed: found,
          actual: found
            ? `URL contains "${tc.value}"`
            : `URL "${url}" does not contain "${tc.value}"`
        };
      }

      case "title_contains": {
        const title = await page.title();
        const found = title.toLowerCase().includes(tc.value.toLowerCase());
        return {
          passed: found,
          actual: found
            ? `Page title contains "${tc.value}"`
            : `Page title "${title}" does not contain "${tc.value}"`
        };
      }

      case "saucedemo_login_success": {
        const targetUrl = tc.navigateUrl || tc.url || "https://www.saucedemo.com/";
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.fill("#user-name", tc.username || "");
        await page.fill("#password", tc.password || "");
        await page.click("#login-button");
        await page.waitForTimeout(1500);

        const onInventory = page.url().includes("/inventory.html");
        const inventoryVisible = await page.locator(".inventory_list").first().isVisible({ timeout: 3000 }).catch(() => false);
        return {
          passed: onInventory || inventoryVisible,
          actual: onInventory || inventoryVisible
            ? "Login succeeded and inventory page is visible"
            : `Login did not reach inventory page. Current URL: ${page.url()}`
        };
      }

      case "saucedemo_login_error": {
        const targetUrl = tc.navigateUrl || tc.url || "https://www.saucedemo.com/";
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.fill("#user-name", tc.username || "");
        await page.fill("#password", tc.password || "");
        await page.click("#login-button");
        await page.waitForTimeout(1200);

        const errorVisible = await page.locator("[data-test='error']").first().isVisible({ timeout: 3000 }).catch(() => false);
        const onInventory = page.url().includes("/inventory.html");
        return {
          passed: errorVisible && !onInventory,
          actual: errorVisible && !onInventory
            ? "Invalid login was rejected and an error message is visible"
            : `Expected login error, but current URL is ${page.url()}`
        };
      }

      case "saucedemo_add_to_cart": {
        const productName = tc.productName || tc.value || "Sauce Labs Bolt T-Shirt";
        const expectedCount = String(tc.expectedCount || 1);
        const opened = await openSauceDemoInventory(page, tc);
        if (!opened.ok) return { passed: false, actual: opened.actual };

        const added = await addSauceDemoProduct(page, productName);
        if (!added.ok) return { passed: false, actual: added.actual };

        const badgeText = await cartBadgeText(page);
        if (tc.verify === "badge") {
          const badgeOk = String(badgeText || "").trim() === expectedCount;
          return {
            passed: badgeOk,
            actual: badgeOk
              ? `Cart badge shows ${expectedCount} for "${productName}"${added.alreadyAdded ? " (already added)" : ""}`
              : `Cart badge shows "${String(badgeText || "").trim() || "(empty)"}"; expected ${expectedCount}`
          };
        }

        await page.locator(".shopping_cart_link, [data-test='shopping-cart-link']").first().click({ timeout: 5000 });
        await page.waitForTimeout(1000);
        const inCart = await page.locator(".cart_item, [data-test='inventory-item']").filter({ hasText: productName }).first().isVisible({ timeout: 5000 }).catch(() => false);
        return {
          passed: inCart,
          actual: inCart
            ? `"${productName}" is present in the cart`
            : `"${productName}" was not found in the cart`
        };
      }

      case "saucedemo_product_visible": {
        const productName = tc.productName || tc.value || "Sauce Labs Bolt T-Shirt";
        const opened = await openSauceDemoInventory(page, tc);
        if (!opened.ok) return { passed: false, actual: opened.actual };

        const visible = await sauceDemoProduct(page, productName).isVisible({ timeout: 5000 }).catch(() => false);
        return {
          passed: visible,
          actual: visible
            ? `"${productName}" is visible in inventory`
            : `"${productName}" is not visible in inventory`
        };
      }

      case "saucedemo_add_button_changes": {
        const productName = tc.productName || tc.value || "Sauce Labs Bolt T-Shirt";
        const opened = await openSauceDemoInventory(page, tc);
        if (!opened.ok) return { passed: false, actual: opened.actual };

        const added = await addSauceDemoProduct(page, productName);
        if (!added.ok) return { passed: false, actual: added.actual };

        const removeVisible = await sauceDemoProduct(page, productName).locator("button").filter({ hasText: /remove/i }).first().isVisible({ timeout: 3000 }).catch(() => false);
        return {
          passed: removeVisible,
          actual: removeVisible
            ? `Button changed to Remove after adding "${productName}"`
            : `Remove button did not appear after adding "${productName}"`
        };
      }

      case "saucedemo_remove_from_cart": {
        const productName = tc.productName || tc.value || "Sauce Labs Bolt T-Shirt";
        const opened = await openSauceDemoInventory(page, tc);
        if (!opened.ok) return { passed: false, actual: opened.actual };

        const added = await addSauceDemoProduct(page, productName);
        if (!added.ok) return { passed: false, actual: added.actual };

        await page.locator(".shopping_cart_link, [data-test='shopping-cart-link']").first().click({ timeout: 5000 });
        await page.waitForTimeout(800);
        const item = page.locator(".cart_item, [data-test='inventory-item']").filter({ hasText: productName }).first();
        const itemVisible = await item.isVisible({ timeout: 5000 }).catch(() => false);
        if (!itemVisible) return { passed: false, actual: `"${productName}" was not found in cart before remove` };

        await item.locator("button").filter({ hasText: /remove/i }).first().click({ timeout: 5000 });
        await page.waitForTimeout(800);
        const stillVisible = await page.locator(".cart_item, [data-test='inventory-item']").filter({ hasText: productName }).first().isVisible({ timeout: 1500 }).catch(() => false);
        const badge = await cartBadgeText(page);
        const removed = !stillVisible && !badge;
        return {
          passed: removed,
          actual: removed
            ? `"${productName}" was removed from cart and cart badge cleared`
            : `Remove failed: item visible=${stillVisible}, badge="${badge || "(empty)"}"`
        };
      }

      case "saucedemo_readd_to_cart": {
        const productName = tc.productName || tc.value || "Sauce Labs Bolt T-Shirt";
        const opened = await openSauceDemoInventory(page, tc);
        if (!opened.ok) return { passed: false, actual: opened.actual };

        const firstAdd = await addSauceDemoProduct(page, productName);
        if (!firstAdd.ok) return { passed: false, actual: firstAdd.actual };

        await page.locator(".shopping_cart_link, [data-test='shopping-cart-link']").first().click({ timeout: 5000 });
        await page.waitForTimeout(800);
        const cartItem = page.locator(".cart_item, [data-test='inventory-item']").filter({ hasText: productName }).first();
        await cartItem.locator("button").filter({ hasText: /remove/i }).first().click({ timeout: 5000 });
        await page.waitForTimeout(800);
        await page.locator("#continue-shopping, [data-test='continue-shopping']").first().click({ timeout: 5000 });
        await page.waitForTimeout(800);

        const secondAdd = await addSauceDemoProduct(page, productName);
        if (!secondAdd.ok) return { passed: false, actual: secondAdd.actual };

        const badge = await cartBadgeText(page);
        const readded = badge === "1";
        return {
          passed: readded,
          actual: readded
            ? `"${productName}" was removed and added again; cart badge is 1`
            : `Re-add failed: cart badge is "${badge || "(empty)"}"`
        };
      }

      case "click_then_visible": {
        const originalUrl = page.url();
        try {
          await page.locator(tc.clickSelector).first().click({ timeout: 5000 });
          await page.waitForTimeout(1500);
        } catch (clickErr) {
          return { passed: false, actual: `Could not click "${tc.clickSelector}": ${clickErr.message.slice(0, 80)}` };
        }
        const vis = await page.locator(tc.resultSelector).first().isVisible({ timeout: 5000 }).catch(() => false);
        // Navigate back if a click caused page navigation
        if (page.url() !== originalUrl) {
          await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
        return {
          passed: vis,
          actual: vis
            ? `After clicking "${tc.clickSelector}": "${tc.resultSelector}" appeared ✓`
            : `After clicking "${tc.clickSelector}": "${tc.resultSelector}" did not appear`
        };
      }

      case "fill_and_submit": {
        // Fill all specified fields — handle radio/checkbox/select differently from text inputs
        const runStamp = Date.now();
        for (const field of (tc.fields || [])) {
          try {
            // Replace {{timestamp}} placeholder so emails/usernames are unique per run
            const fieldValue = String(field.value).replace(/\{\{timestamp\}\}/g, runStamp);
            const loc      = page.locator(field.selector).first();
            const inputType = await loc.getAttribute("type", { timeout: 3000 }).catch(() => null);
            const tagName   = await loc.evaluate(el => el.tagName.toLowerCase()).catch(() => "input");

            if (inputType === "radio" || inputType === "checkbox") {
              // Radio/checkbox: click to select (fill() throws on these)
              await loc.click({ timeout: 5000 });
            } else if (tagName === "select") {
              // <select> dropdown: use selectOption
              await loc.selectOption(fieldValue, { timeout: 5000 });
            } else {
              await loc.fill(fieldValue, { timeout: 5000 });
            }
          } catch (e) {
            return { passed: false, actual: `Could not fill "${field.selector}": ${e.message.slice(0, 80)}` };
          }
        }
        // Click submit button — click first, then wait for navigation/settle
        const urlBefore = page.url();
        if (tc.submitSelector) {
          try {
            await page.locator(tc.submitSelector).first().click({ timeout: 5000 });
            // Wait for either a navigation or the page to settle (whichever comes first)
            await Promise.race([
              page.waitForURL(url => url !== urlBefore, { timeout: 8000 }).catch(() => {}),
              page.waitForLoadState("domcontentloaded",  { timeout: 8000 }).catch(() => {})
            ]);
          } catch (_) { /* ignore */ }
        }
        await page.waitForTimeout(2000);
        const urlAfter   = page.url();
        const urlChanged = urlAfter !== urlBefore;

        // Verify success by URL path (explicit)
        if (tc.successUrl) {
          const ok = urlAfter.includes(tc.successUrl);
          return {
            passed: ok,
            actual: ok
              ? `Redirected to ${urlAfter}`
              : `Expected URL to contain "${tc.successUrl}", got "${urlAfter}"`
          };
        }
        // Verify success by selector — if selector missing but URL changed, still pass
        if (tc.successSelector) {
          const vis = await page.locator(tc.successSelector).first().isVisible({ timeout: 6000 }).catch(() => false);
          if (!vis && urlChanged) {
            return { passed: true, actual: `Page navigated to "${urlAfter}" after submit (success confirmed by URL change)` };
          }
          return {
            passed: vis,
            actual: vis
              ? `Success — "${tc.successSelector}" appeared after submit`
              : `Failed — "${tc.successSelector}" not found and URL did not change (still at "${urlAfter}")`
          };
        }
        // No success criteria — pass if URL changed (navigation = form accepted)
        return {
          passed: urlChanged,
          actual: urlChanged
            ? `Page navigated to "${urlAfter}" after submit`
            : `Form submitted but page did not navigate — may indicate a validation error`
        };
      }

      default:
        return { passed: false, actual: `Unknown Playwright check type: "${tc.check}"` };
    }
  } catch (err) {
    return { passed: false, actual: `Check error: ${err.message.slice(0, 120)}` };
  }
}

// ── HTML-based check (legacy + fallback) ─────────────────────────────────────
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
      return { passed: false, actual: `Unknown check type: "${tc.check}"` };
  }
}

// ── API request check — no browser needed, hits endpoints directly ───────────
async function runApiCheck(tc) {
  const method          = (tc.method || "GET").toUpperCase();
  const url             = tc.url;
  const expectedStatus  = tc.expectedStatus  ?? 200;
  const maxResponseTime = tc.maxResponseTime ?? 5000;

  if (!url) return { passed: false, actual: "api_request check missing 'url' field" };

  const start      = Date.now();
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), maxResponseTime);

  try {
    const fetchOpts = {
      method,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "User-Agent": "QA-Pipeline/1.0", ...(tc.headers || {}) }
    };
    if (tc.body && method !== "GET") fetchOpts.body = JSON.stringify(tc.body);

    const response     = await fetch(url, fetchOpts);
    clearTimeout(timer);
    const responseTime = Date.now() - start;
    const statusCode   = response.status;
    let   responseText = "";
    try { responseText = await response.text(); } catch (_) {}

    // Response time check
    if (responseTime > maxResponseTime) {
      return { passed: false, actual: `Response took ${responseTime}ms — limit is ${maxResponseTime}ms` };
    }
    // Status code check
    if (statusCode !== expectedStatus) {
      return { passed: false, actual: `Expected status ${expectedStatus}, got ${statusCode} in ${responseTime}ms — body: ${responseText.slice(0, 120)}` };
    }
    // Body contains check
    if (tc.expectedBodyContains && !responseText.includes(tc.expectedBodyContains)) {
      return { passed: false, actual: `Status ${statusCode} OK but body missing "${tc.expectedBodyContains}" — got: ${responseText.slice(0, 150)}` };
    }
    // Body NOT contains check
    if (tc.expectedBodyNotContains && responseText.includes(tc.expectedBodyNotContains)) {
      return { passed: false, actual: `Body contains "${tc.expectedBodyNotContains}" when it should not` };
    }

    return { passed: true, actual: `${method} ${url} → ${statusCode} in ${responseTime}ms` };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { passed: false, actual: `Request timeout — no response within ${maxResponseTime}ms` };
    }
    return { passed: false, actual: `Request failed: ${err.message.slice(0, 120)}` };
  }
}

// ── Unified check runner ──────────────────────────────────────────────────────
// Uses Playwright when: (1) a live page is available AND (2) check is a Playwright type.
// Falls back to HTML string checks automatically.
async function executeCheck(page, html, tc) {
  // Normalize: AI sometimes nests the check spec inside the "check" field
  if (typeof tc.check === "object" && tc.check !== null) {
    tc = { ...tc, ...tc.check, check: tc.check.check || tc.check.type || "visible" };
  }

  // API check — runs independently, no browser or HTML needed
  if (tc.check === "api_request") {
    return runApiCheck(tc);
  }

  if (page && PLAYWRIGHT_CHECKS.has(tc.check)) {
    return runPlaywrightCheck(page, tc);
  }
  // Playwright check type but no live page — treat as a real UI failure, not an automation issue
  if (!page && PLAYWRIGHT_CHECKS.has(tc.check)) {
    const target = tc.selector || tc.value || tc.attribute || "";
    return { passed: false, actual: `UI check failed: "${target}" could not be verified on the live page` };
  }
  return runCheck(html, tc);
}

function safeFilePart(value) {
  return String(value || "test")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "test";
}

async function captureFailureScreenshot(page, runId, testId) {
  if (!page || typeof page.screenshot !== "function") return null;

  try {
    const safeRunId = safeFilePart(runId || "run");
    const safeTestId = safeFilePart(testId || "test");
    const outDir = path.join(__dirname, "screenshots", safeRunId);
    fs.mkdirSync(outDir, { recursive: true });

    const filePath = path.join(outDir, `${safeTestId}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return `/screenshots/${encodeURIComponent(safeRunId)}/${encodeURIComponent(safeTestId)}.png`;
  } catch (err) {
    console.log(`   Screenshot capture failed for ${testId}: ${err.message}`);
    return null;
  }
}

module.exports = {
  httpsGet,
  getHtml,
  getPageAndHtml,
  stripHtml,
  runCheck,
  runPlaywrightCheck,
  runApiCheck,
  executeCheck,
  captureFailureScreenshot,
  PLAYWRIGHT_CHECKS
};
