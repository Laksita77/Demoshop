require("dotenv").config();
const { chromium }      = require("playwright");
const { runAutomation } = require("./automation");

const RUN_ID = `run-${Date.now()}`;

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

const BASE_URL = "https://demoshop-p5aw.onrender.com";
const TIMEOUT  = 60000;

// ═══════════════════════════════════════════════════════════════════════════
//  TEST CASES  — each one runs real browser actions via Playwright
// ═══════════════════════════════════════════════════════════════════════════
const TESTS = [
  {
    id: "TC-01", area: "Security",
    name: "Registration password field must be masked",
    expected: "Password input type must be 'password'",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.click("#authBtn");
      await page.click("#tab-register");
      await page.waitForSelector("#regPassword");
      const type = await page.getAttribute("#regPassword", "type");
      return {
        passed: type === "password",
        actual: `Password field type="${type}" — ${type === "text" ? "visible in plain text" : "masked correctly"}`
      };
    }
  },
  {
    id: "TC-02", area: "Checkout",
    name: "Phone number field must reject non-numeric input",
    expected: "Phone field must have type='tel' or a numeric pattern",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.click(".prod-add-btn >> nth=0");
      await page.waitForTimeout(500);
      await page.click(".cart-btn");
      await page.click(".checkout-cta");
      await page.waitForSelector("#chkPhone");
      const type    = await page.getAttribute("#chkPhone", "type");
      const pattern = await page.getAttribute("#chkPhone", "pattern");
      const passed  = type === "tel" || !!pattern;
      return {
        passed,
        actual: passed
          ? "Phone field has numeric validation"
          : `Phone field is type="${type}" with no pattern — accepts letters`
      };
    }
  },
  {
    id: "TC-03", area: "Checkout",
    name: "ZIP code field must reject non-numeric characters",
    expected: "ZIP field must have type='number' or pattern='[0-9]*'",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.click(".prod-add-btn >> nth=0");
      await page.waitForTimeout(500);
      await page.click(".cart-btn");
      await page.click(".checkout-cta");
      await page.waitForSelector("#chkZip");
      const type    = await page.getAttribute("#chkZip", "type");
      const pattern = await page.getAttribute("#chkZip", "pattern");
      const passed  = type === "number" || !!pattern;
      return {
        passed,
        actual: passed
          ? "ZIP field restricts to numeric input"
          : `ZIP field is type="${type}" with no pattern — accepts letters and symbols`
      };
    }
  },
  {
    id: "TC-04", area: "Security",
    name: "Credit card must require exactly 16 digits",
    expected: "Order must not proceed with a 4-digit card number",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.click(".prod-add-btn >> nth=0");
      await page.waitForTimeout(500);
      await page.click(".cart-btn");
      await page.click(".checkout-cta");
      await page.waitForSelector("#cardNumber");
      await page.fill("#chkEmail",   "test@test.com");
      await page.fill("#cardNumber", "1234");
      await page.click(".place-order-btn");
      await page.waitForTimeout(1000);
      const onConfirm = await page.$("#page-confirm.active");
      return {
        passed: !onConfirm,
        actual: !onConfirm
          ? "Order blocked — 4-digit card rejected"
          : "Order placed with only 4 digits — no 16-digit validation"
      };
    }
  },
  {
    id: "TC-05", area: "Backend",
    name: "Order total must include $5.00 shipping fee",
    expected: "Total displayed = subtotal + $5.00",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      const usbHub = page.locator(".product-card", { hasText: "USB-C Hub" });
      await usbHub.locator(".prod-add-btn").click();
      await page.waitForTimeout(500);
      await page.click(".cart-btn");
      await page.waitForSelector(".sum-row");
      const rows     = await page.$$eval(".sum-row span:last-child", els => els.map(e => e.textContent.trim()));
      const subtotal = parseFloat((rows[0] || "$0").replace("$", "")) || 0;
      await page.click(".checkout-cta");
      await page.waitForSelector("#ordTotal");
      const displayed = parseFloat((await page.textContent("#ordTotal")).replace("$", ""));
      const correct   = subtotal + 5.00;
      const passed    = Math.abs(displayed - correct) < 0.01;
      return {
        passed,
        actual: passed
          ? `Total $${displayed.toFixed(2)} correctly includes shipping`
          : `Total shows $${displayed.toFixed(2)} — missing $5.00 shipping (should be $${correct.toFixed(2)})`
      };
    }
  },
  {
    id: "TC-06", area: "Frontend",
    name: "Search must require a non-empty query",
    expected: "Empty search must show error — not all products",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.fill("#searchInput", "");
      await page.click(".search-wrap button");
      await page.waitForTimeout(800);
      const count = await page.$$eval(".product-card", c => c.length);
      return {
        passed: count === 0,
        actual: count === 0
          ? "Empty search correctly blocked"
          : `Empty search returned ${count} products — should require a search term`
      };
    }
  },
  {
    id: "TC-07", area: "Frontend",
    name: "Product search must be case-insensitive",
    expected: "Searching 'laptop' must find '14.1-inch Laptop Pro'",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.fill("#searchInput", "laptop");
      await page.click(".search-wrap button");
      await page.waitForTimeout(800);
      const count = await page.$$eval(".product-card", c => c.length);
      return {
        passed: count > 0,
        actual: count > 0
          ? `Found ${count} result(s) for "laptop"`
          : `0 results for "laptop" — case-sensitive bug (product name is "Laptop Pro")`
      };
    }
  },
  {
    id: "TC-08", area: "Performance",
    name: "Price sort must order products numerically not as strings",
    expected: "$22.99 must appear before $1350 when sorted Low to High",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.selectOption("#sortSelect", "price-asc");
      await page.waitForTimeout(800);
      const prices = await page.$$eval(".prod-price", els =>
        els.map(el => parseFloat(el.textContent.replace("$", "").trim()))
      );
      const isNumeric = prices.every((p, i) => i === 0 || prices[i - 1] <= p);
      return {
        passed: isNumeric,
        actual: isNumeric
          ? `Prices in correct numeric order: ${prices.slice(0,4).map(p=>"$"+p).join(" → ")}`
          : `Prices in wrong string order: ${prices.slice(0,4).map(p=>"$"+p).join(" → ")} (alphabetical sort bug)`
      };
    }
  },
  {
    id: "TC-09", area: "Frontend",
    name: "Product rating must not show NaN for zero-review products",
    expected: "Gift Card (0 reviews) must show valid rating — not NaN",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      const giftCard = page.locator(".product-card", { hasText: "Gift Card" });
      await giftCard.click();
      await page.waitForSelector("#detailRating");
      const rating = await page.textContent("#detailRating");
      const hasNaN = rating.includes("NaN");
      return {
        passed: !hasNaN,
        actual: hasNaN
          ? `Rating shows "${rating}" — NaN caused by division by zero on 0 reviews`
          : `Rating displays correctly: "${rating}"`
      };
    }
  },
  {
    id: "TC-10", area: "Frontend",
    name: "Cart badge must show the exact item count",
    expected: "After adding 1 item, badge shows '1' not '2'",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.click(".prod-add-btn >> nth=0");
      await page.waitForTimeout(500);
      const badge = (await page.textContent("#cartBadge")).trim();
      return {
        passed: badge === "1",
        actual: badge === "1"
          ? "Badge correctly shows 1"
          : `Badge shows "${badge}" after adding 1 item — off-by-one error`
      };
    }
  },
  {
    id: "TC-11", area: "Backend",
    name: "Cart item quantity must not go below 1",
    expected: "Minus button on qty=1 must stop at 1 or remove item",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.click(".prod-add-btn >> nth=0");
      await page.waitForTimeout(300);
      await page.click(".cart-btn");
      await page.waitForSelector(".cart-qty-ctrl");
      await page.click(".cart-qty-ctrl button:first-child");
      await page.waitForTimeout(400);
      const qtyEl  = await page.$(".cart-qty-val");
      const qty    = qtyEl ? parseInt(await qtyEl.textContent()) : -1;
      const passed = !qtyEl || qty >= 1;
      return {
        passed,
        actual: passed
          ? "Quantity stays at minimum 1 or item removed"
          : `Quantity went to ${qty} — no minimum guard`
      };
    }
  },
  {
    id: "TC-12", area: "Security",
    name: "Email must require a valid top-level domain",
    expected: "'user@domain' (no .com) must be rejected on registration",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.click("#authBtn");
      await page.click("#tab-register");
      await page.fill("#regName",     "Test User");
      await page.fill("#regEmail",    "test@nodomain");
      await page.fill("#regPassword", "pass1234");
      await page.fill("#regConfirm",  "pass1234");
      await page.click("#panel-register .submit-btn");
      await page.waitForTimeout(1000);
      const onHome = await page.$("#page-home.active");
      return {
        passed: !onHome,
        actual: !onHome
          ? "'test@nodomain' correctly rejected"
          : "'test@nodomain' accepted — missing TLD validation"
      };
    }
  },
  {
    id: "TC-13", area: "Security",
    name: "Password confirmation must match the original password",
    expected: "Registration must fail when passwords do not match",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.click("#authBtn");
      await page.click("#tab-register");
      await page.fill("#regName",     "Test User");
      await page.fill("#regEmail",    "test@test.com");
      await page.fill("#regPassword", "password123");
      await page.fill("#regConfirm",  "different999");
      await page.click("#panel-register .submit-btn");
      await page.waitForTimeout(1000);
      const onHome = await page.$("#page-home.active");
      return {
        passed: !onHome,
        actual: !onHome
          ? "Mismatched passwords correctly blocked"
          : "Registration succeeded despite passwords not matching"
      };
    }
  },
  {
    id: "TC-14", area: "Backend",
    name: "Coupon code must only accept approved codes",
    expected: "Random code 'XXXX' must not apply a discount",
    run: async (page) => {
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      await page.click(".prod-add-btn >> nth=0");
      await page.waitForTimeout(400);
      await page.click(".cart-btn");
      await page.click(".checkout-cta");
      await page.waitForSelector("#couponInput");
      await page.fill("#couponInput", "XXXX");
      await page.click(".coupon-apply-btn");
      await page.waitForTimeout(600);
      const msg    = await page.textContent("#couponMsg");
      const passed = !msg.toLowerCase().includes("applied") && !msg.includes("off");
      return {
        passed,
        actual: passed
          ? "Invalid coupon 'XXXX' correctly rejected"
          : `Invalid coupon 'XXXX' accepted — "${msg}"`
      };
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════════
//  RUNNER
// ═══════════════════════════════════════════════════════════════════════════
async function run() {
  console.log("\n══════════════════════════════════════════════");
  console.log("   DemoShop — Running automated tests...");
  console.log(`   URL : ${BASE_URL}`);
  console.log("══════════════════════════════════════════════\n");

  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });

  let passed = 0;
  let logged = 0;

  for (const tc of TESTS) {
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    process.stdout.write(`  Running ${tc.id}... `);
    await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "running" });

    try {
      const result = await tc.run(page);

      if (result.passed) {
        console.log(`✅ PASS`);
        passed++;
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "pass" });
      } else {
        console.log(`❌ FAIL → classifying & uploading to Jira...`);
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "classifying", actual: result.actual });

        const aiResult = await runAutomation({
          data: {
            issue: {
              title:     `${tc.id} — ${tc.name}`,
              level:     "error",
              culprit:   `${tc.id} [${tc.area}]`,
              firstSeen: new Date().toISOString(),
              metadata:  {
                type:     tc.name,
                value:    result.actual,
                expected: tc.expected,
                testCase: tc.id,
                area:     tc.area
              },
              project: { name: "DemoShop" }
            }
          }
        });

        if (aiResult?.logged) logged++;
        await postResult({
          id: tc.id, name: tc.name, area: tc.area,
          status: "fail", actual: result.actual,
          category: aiResult?.category, reason: aiResult?.reason, jiraUrl: aiResult?.jiraUrl
        });
      }
    } catch (err) {
      console.log(`💥 ERROR — ${err.message}`);
      await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "error", actual: err.message });
    }

    await page.close();
  }

  await browser.close();
  await postResult({ id: "__done__", runFinished: true });

  console.log("\n══════════════════════════════════════════════");
  console.log(`   ✅ Passed       : ${passed}`);
  console.log(`   ❌ Failed       : ${TESTS.length - passed}`);
  console.log(`   🎫 Jira tickets : ${logged} created`);
  console.log("══════════════════════════════════════════════\n");
}

run().catch(err => {
  console.error("[Runner Error]", err.message);
  process.exit(1);
});
