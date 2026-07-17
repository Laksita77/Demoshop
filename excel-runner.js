// excel-runner.js
// Usage: node excel-runner.js --url https://site.com --excel-file data.xlsx --scenario-file scenario.json --count 8
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { runBatchAutomation } = require("./automation");
const { getPageAndHtml, stripHtml, executeCheck, captureFailureScreenshot } = require("./utils");
const { saveTestCases, saveRunResult } = require("./storage");
const { generateJsonWithFallback } = require("./ai-provider");

const RUN_ID = `excel-run-${Date.now()}`;
const arg = (flag) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : null; };

let TARGET_URL = arg("--url");
const EXCEL_FILE = arg("--excel-file");
const SCENARIO_FILE = arg("--scenario-file");
const SPRINT_NAME = arg("--sprint") || `run-${new Date().toISOString().split("T")[0]}`;
const REQUESTED_TEST_COUNT = arg("--count") ? parseInt(arg("--count"), 10) : null;
let TEST_COUNT = REQUESTED_TEST_COUNT || 8;

function readScenario() {
  if (!SCENARIO_FILE) return "";
  try {
    const data = JSON.parse(fs.readFileSync(SCENARIO_FILE, "utf8"));
    return data.scenario || data.message || "";
  } catch (err) {
    throw new Error(`Failed to read scenario file: ${err.message}`);
  }
}

function firstUrlFromText(value) {
  const match = String(value || "").match(/https?:\/\/[^\s,;)"']+/i);
  return match ? match[0].replace(/[.)\]]+$/, "") : null;
}

async function readWorkbook(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Uploaded file was not found");
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") {
    const csv = fs.readFileSync(filePath, "utf8");
    return {
      text: `Sheet: CSV\n${csv.slice(0, 25000)}`,
      rows: [],
      detectedUrl: firstUrlFromText(csv)
    };
  }

  // PDF — extract raw text and treat it as free-form scenario/test-data input.
  if (ext === ".pdf") {
    let PDFParse;
    try { ({ PDFParse } = require("pdf-parse")); }
    catch (_) { throw new Error("Missing dependency: run 'npm install pdf-parse' to read PDF files"); }
    if (typeof PDFParse !== "function") {
      throw new Error("Incompatible pdf-parse version. Run 'npm install pdf-parse@^2' to read PDF files.");
    }
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    let text;
    try {
      const parsed = await parser.getText();
      text = String(parsed.text || "").replace(/\n{3,}/g, "\n\n").trim();
    } finally {
      if (typeof parser.destroy === "function") { try { await parser.destroy(); } catch (_) {} }
    }
    if (!text) throw new Error("Could not extract any text from the PDF (it may be a scanned image without selectable text).");
    return {
      text: `Document: PDF\n${text.slice(0, 45000)}`,
      rows: [],
      detectedUrl: firstUrlFromText(text)
    };
  }

  // Word — mammoth reads .docx (Office Open XML). Legacy binary .doc is not supported.
  if (ext === ".docx" || ext === ".doc") {
    if (ext === ".doc") {
      throw new Error("Legacy .doc files are not supported. Please save the document as .docx and upload again.");
    }
    let mammoth;
    try { mammoth = require("mammoth"); }
    catch (_) { throw new Error("Missing dependency: run 'npm install mammoth' to read Word files"); }
    const buffer = fs.readFileSync(filePath);
    const { value } = await mammoth.extractRawText({ buffer });
    const text = String(value || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) throw new Error("Could not extract any text from the Word document.");
    return {
      text: `Document: Word\n${text.slice(0, 45000)}`,
      rows: [],
      detectedUrl: firstUrlFromText(text)
    };
  }

  let XLSX;
  try {
    XLSX = require("xlsx");
  } catch (_) {
    throw new Error("Missing dependency: run npm install so the xlsx package is available");
  }

  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const chunks = [];
  const allRows = [];
  let detectedUrl = null;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
    for (const row of rows) {
      allRows.push({ sheetName, ...row });
      for (const value of Object.values(row)) {
        detectedUrl = detectedUrl || firstUrlFromText(value);
      }
    }
    const previewRows = rows.slice(0, 60);
    chunks.push([
      `Sheet: ${sheetName}`,
      `Rows: ${rows.length}`,
      JSON.stringify(previewRows, null, 2)
    ].join("\n"));
  }

  return {
    text: chunks.join("\n\n").slice(0, 45000),
    rows: allRows,
    detectedUrl
  };
}

function pickValue(rows, keys) {
  const lowered = keys.map(k => k.toLowerCase());
  for (const row of rows) {
    const value = rowValue(row, lowered);
    if (value) return value;
  }
  return "";
}

function rowValue(row, keys) {
  const lowered = keys.map(k => k.toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (const [key, value] of Object.entries(row)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (lowered.includes(normalized) && String(value || "").trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function rowText(row) {
  return Object.values(row).map(v => String(v || "")).join(" ").toLowerCase();
}

function isPositiveIntent(row) {
  const expected = rowValue(row, ["expectedresult", "expected", "expectedoutcome"]).toLowerCase();
  if (/(successful|success|inventory|next page|added|cart badge|appears in cart)/i.test(expected)) return true;
  return /\b(pos|positive|valid)\b/i.test(rowText(row));
}

function isNegativeIntent(row) {
  const expected = rowValue(row, ["expectedresult", "expected", "expectedoutcome"]).toLowerCase();
  if (/(reject|rejected|error|invalid|not login|should not)/i.test(expected)) return true;
  return /\b(neg|negative|invalid|reject|rejected)\b/i.test(rowText(row));
}

function hasCartIntent(row) {
  const text = rowText(row);
  const productName = rowValue(row, ["productname", "product", "itemname", "item"]);
  const action = rowValue(row, ["action"]).toLowerCase();
  return !!productName || action.includes("cart") || action.includes("remove") || action.includes("re-add") ||
    text.includes("add to cart") || text.includes("remove from cart") || text.includes("re-add") || text.includes("appears in cart");
}

function hasLoginIntent(row) {
  const text = rowText(row);
  return text.includes("login") || !!rowValue(row, ["username", "userid", "user"]);
}

function compactScenarioName(value, fallback) {
  const raw = String(value || "").trim();
  const base = raw || fallback || "General scenario";
  const lower = base.toLowerCase();
  const fallbackLower = String(fallback || "").toLowerCase();

  if (fallbackLower.includes("cart") && /\b(cart|product|add|remove|inventory|checkout)\b/i.test(lower)) return "Cart scenario";
  if (fallbackLower.includes("login") && /\b(login|credential|username|password|auth)\b/i.test(lower)) return "Login scenario";
  if (/\b(cart|product|add to cart|remove|inventory|checkout)\b/i.test(lower)) return "Cart scenario";
  if (/\b(login|credential|username|password|auth)\b/i.test(lower)) return "Login scenario";
  if (/\b(search|filter|sort)\b/i.test(lower)) return "Search scenario";
  return base.length > 64 ? `${base.slice(0, 61)}...` : base;
}

function scenarioIdFromName(name) {
  return String(name || "scenario")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "scenario";
}

function scenarioMeta(row, fallbackName) {
  const explicit =
    rowValue(row || {}, ["scenariogroup", "scenarioheading", "scenarioname", "feature", "module", "flow"]) ||
    rowValue(row || {}, ["scenario"]);
  const scenarioName = compactScenarioName(explicit, fallbackName || "General scenario");
  return {
    scenarioId: scenarioIdFromName(scenarioName),
    scenarioName
  };
}

function scenarioCountFromInputs(rows, scenarioText) {
  const names = new Set();
  for (const row of rows || []) {
    if (hasLoginIntent(row)) names.add("login");
    if (hasCartIntent(row)) names.add("cart");
    const explicit = rowValue(row, ["scenariogroup", "scenarioheading", "scenarioname", "feature", "module", "flow", "scenario"]);
    if (explicit) names.add(scenarioIdFromName(compactScenarioName(explicit, "General scenario")));
  }

  const text = String(scenarioText || "").toLowerCase();
  if (/\b(login|credential|username|password|auth)\b/.test(text)) names.add("login");
  if (/\b(cart|product|add to cart|remove|inventory|checkout)\b/.test(text)) names.add("cart");
  if (/\b(search|filter|sort)\b/.test(text)) names.add("search");

  return Math.max(names.size, 1);
}

function suggestedTestCount(rows, scenarioText) {
  return Math.min(40, Math.max(8, scenarioCountFromInputs(rows, scenarioText) * 6));
}

function inferScenarioForTest(tc, fallbackName) {
  const text = `${tc?.scenarioName || ""} ${tc?.name || ""} ${tc?.expected || ""}`;
  const scenarioName = compactScenarioName(text, fallbackName || "General scenario");
  return { scenarioId: scenarioIdFromName(scenarioName), scenarioName };
}

function ensureScenarioFields(testCases, rows, scenarioText) {
  const cases = Array.isArray(testCases) ? testCases : [];
  const fallback = scenarioCountFromInputs(rows, scenarioText) > 1 ? "General scenario" : compactScenarioName(scenarioText, "General scenario");
  return cases.map((tc, index) => {
    const explicitName = tc.scenarioName || tc.scenario || tc.group || tc.feature || "";
    const meta = explicitName
      ? { scenarioName: compactScenarioName(explicitName, fallback), scenarioId: scenarioIdFromName(compactScenarioName(explicitName, fallback)) }
      : inferScenarioForTest(tc, fallback);
    return {
      id: tc.id || `XL-${String(index + 1).padStart(2, "0")}`,
      ...tc,
      scenarioId: tc.scenarioId || meta.scenarioId,
      scenarioName: tc.scenarioName || meta.scenarioName,
      steps: Array.isArray(tc.steps) && tc.steps.length
        ? tc.steps.map(s => String(s)).filter(Boolean)
        : buildSteps(tc)
    };
  });
}

function humanFieldSteps(fields) {
  return (fields || []).map(f => {
    const label = String(f.selector || "field").replace(/[#.\[\]'"=\^,]/g, " ").replace(/\s+/g, " ").trim() || "field";
    return `Enter "${f.value}" into the ${label} field`;
  });
}

// Build human-readable, ordered test steps for a generated test case.
// Used for the deterministic SauceDemo suite and as a fallback when the AI
// output omits steps. The steps drive the per-test-case dropdown in the dashboard.
function buildSteps(tc, targetUrl) {
  const site = tc.navigateUrl || tc.url || targetUrl || "the target website";
  const open = `Open ${site}`;
  const login = (u, p) => `Log in with username "${u || ""}" and password "${p || ""}"`;
  const sel = tc.selector || "";

  switch (tc.check) {
    case "visible":
      return [open, `Locate the element "${sel}"`, `Confirm "${sel}" is visible on the page`];
    case "not_visible":
      return [open, `Locate the element "${sel}"`, `Confirm "${sel}" is hidden or absent`];
    case "text_contains":
      return [open, `Read the text of "${sel}"`, `Confirm the text contains "${tc.value || ""}"`];
    case "count_gte":
      return [open, `Count the elements matching "${sel}"`, `Confirm at least ${tc.expectedCount ?? 1} are present`];
    case "attr_equals":
      return [open, `Inspect the "${tc.attribute}" attribute of "${sel}"`, `Confirm it equals "${tc.expectedValue || ""}"`];
    case "attr_contains":
      return [open, `Inspect the "${tc.attribute}" attribute of "${sel}"`, `Confirm it contains "${tc.value || ""}"`];
    case "url_contains":
      return [open, `Read the current page URL`, `Confirm the URL contains "${tc.value || ""}"`];
    case "title_contains":
      return [open, `Read the page title`, `Confirm the title contains "${tc.value || ""}"`];
    case "click_then_visible":
      return [open, `Click "${tc.clickSelector || ""}"`, `Confirm "${tc.resultSelector || ""}" becomes visible`];
    case "fill_and_submit":
      return [open, ...humanFieldSteps(tc.fields), `Click the submit control "${tc.submitSelector || ""}"`, `Confirm "${tc.successSelector || ""}" appears`];
    case "api_request":
      return [`Send a ${tc.method || "GET"} request to ${tc.url || site}`, `Wait for the response`, `Confirm the status is ${tc.expectedStatus ?? 200}${tc.maxResponseTime ? ` within ${tc.maxResponseTime} ms` : ""}`];
    case "html_contains":
      return [open, `Read the page source`, `Confirm it contains "${tc.value || ""}"`];
    case "html_not_contains":
      return [open, `Read the page source`, `Confirm it does not contain "${tc.value || ""}"`];

    // SauceDemo custom checks
    case "saucedemo_login_success":
      return [open, `Enter username "${tc.username || ""}"`, `Enter password "${tc.password || ""}"`, `Click the Login button`, `Confirm the inventory (Products) page is shown`];
    case "saucedemo_login_error":
      return [open, `Enter username "${tc.username || ""}"`, `Enter password "${tc.password || ""}"`, `Click the Login button`, `Confirm an error message is displayed and login is rejected`];
    case "saucedemo_product_visible":
      return [open, login(tc.username, tc.password), `Confirm "${tc.productName || "the product"}" is visible on the inventory page`];
    case "saucedemo_add_to_cart":
      return [open, login(tc.username, tc.password), `Click "Add to cart" for "${tc.productName || "the product"}"`, tc.verify === "item" ? `Open the cart and confirm "${tc.productName || "the product"}" is listed` : `Confirm the cart badge shows ${tc.expectedCount ?? 1}`];
    case "saucedemo_add_button_changes":
      return [open, login(tc.username, tc.password), `Click "Add to cart" for "${tc.productName || "the product"}"`, `Confirm the button label changes to "Remove"`];
    case "saucedemo_remove_from_cart":
      return [open, login(tc.username, tc.password), `Add "${tc.productName || "the product"}" to the cart`, `Click "Remove" for "${tc.productName || "the product"}"`, `Confirm the cart badge clears`];
    case "saucedemo_readd_to_cart":
      return [open, login(tc.username, tc.password), `Add "${tc.productName || "the product"}" to the cart`, `Remove "${tc.productName || "the product"}" from the cart`, `Add it again and confirm it returns to the cart`];

    default:
      return [open, tc.name ? `Perform: ${tc.name}` : "Perform the test action", tc.expected ? `Confirm: ${tc.expected}` : "Confirm the expected result"];
  }
}

function sauceDemoLoginTests(rows, targetUrl) {
  const username = pickValue(rows, ["username", "userid", "user"]);
  const password = pickValue(rows, ["password", "pass"]);
  if (!targetUrl || !/saucedemo\.com/i.test(targetUrl) || !username || !password) return null;

  const loginRows = rows.filter(row => rowValue(row, ["username", "userid", "user"]) && rowValue(row, ["password", "pass"]) && hasLoginIntent(row));
  const positiveLoginRows = loginRows.filter(isPositiveIntent);
  const negativeLoginRows = loginRows.filter(row => isNegativeIntent(row) && !isPositiveIntent(row));
  const cartRows = rows.filter(row => hasCartIntent(row) && rowValue(row, ["username", "userid", "user"]) && rowValue(row, ["password", "pass"]));

  const LOGIN_SCENARIO = { scenarioId: "login-scenario", scenarioName: "Login scenario" };
  const CART_SCENARIO = { scenarioId: "cart-scenario", scenarioName: "Cart scenario" };
  const tests = [
    {
      id: "XL-01",
      ...LOGIN_SCENARIO,
      area: "Frontend",
      name: "SauceDemo username field is visible",
      expected: "The login page shows the username input.",
      check: "visible",
      selector: "#user-name"
    },
    {
      id: "XL-02",
      ...LOGIN_SCENARIO,
      area: "Security",
      name: "SauceDemo password field is masked",
      expected: "The password input type is password.",
      check: "attr_equals",
      selector: "#password",
      attribute: "type",
      expectedValue: "password"
    },
    {
      id: "XL-03",
      ...LOGIN_SCENARIO,
      area: "Frontend",
      name: "SauceDemo login button is visible",
      expected: "The login button is available on the login page.",
      check: "visible",
      selector: "#login-button"
    }
  ];

  let next = 4;
  const addId = (tc, scenario = LOGIN_SCENARIO) => tests.push({ id: `XL-${String(next++).padStart(2, "0")}`, ...scenario, ...tc });

  const positiveRow = positiveLoginRows[0] || loginRows.find(row => !isNegativeIntent(row)) || loginRows[0];
  if (positiveRow) {
    addId({
      area: "Security",
      name: "SauceDemo login succeeds with Excel credentials",
      expected: "Valid Excel credentials should open the inventory page.",
      check: "saucedemo_login_success",
      navigateUrl: targetUrl,
      username: rowValue(positiveRow, ["username", "userid", "user"]) || username,
      password: rowValue(positiveRow, ["password", "pass"]) || password
    }, LOGIN_SCENARIO);
  }

  for (const row of negativeLoginRows.slice(0, 2)) {
    addId({
      area: "Security",
      name: "SauceDemo invalid login shows an error",
      expected: "Invalid Excel credentials should be rejected with an error.",
      check: "saucedemo_login_error",
      navigateUrl: targetUrl,
      username: rowValue(row, ["username", "userid", "user"]) || username,
      password: rowValue(row, ["password", "pass"]) || password
    }, LOGIN_SCENARIO);
  }

  const seenProducts = new Set();
  for (const row of cartRows) {
    const productName = rowValue(row, ["productname", "product", "itemname", "item"]) || "Sauce Labs Bolt T-Shirt";
    const productKey = productName.toLowerCase();
    if (seenProducts.has(productKey)) continue;
    seenProducts.add(productKey);
    if (seenProducts.size > 3) break;

    const rowUsername = rowValue(row, ["username", "userid", "user"]) || username;
    const rowPassword = rowValue(row, ["password", "pass"]) || password;
    const cartScenario = scenarioMeta(row, CART_SCENARIO.scenarioName);
    addId({
      area: "Frontend",
      name: `${productName} is visible after login`,
      expected: `${productName} should be visible on the inventory page after login.`,
      check: "saucedemo_product_visible",
      navigateUrl: targetUrl,
      username: rowUsername,
      password: rowPassword,
      productName
    }, cartScenario);
    addId({
      area: "Frontend",
      name: `Add ${productName} to cart`,
      expected: `${productName} should be added and the cart badge should show 1.`,
      check: "saucedemo_add_to_cart",
      navigateUrl: targetUrl,
      username: rowUsername,
      password: rowPassword,
      productName,
      verify: "badge",
      expectedCount: 1
    }, cartScenario);
    addId({
      area: "Frontend",
      name: `Add button changes to Remove for ${productName}`,
      expected: `After adding ${productName}, its button should change to Remove.`,
      check: "saucedemo_add_button_changes",
      navigateUrl: targetUrl,
      username: rowUsername,
      password: rowPassword,
      productName
    }, cartScenario);
    addId({
      area: "Frontend",
      name: `Cart contains ${productName}`,
      expected: `${productName} should appear in the cart page.`,
      check: "saucedemo_add_to_cart",
      navigateUrl: targetUrl,
      username: rowUsername,
      password: rowPassword,
      productName,
      verify: "item",
      expectedCount: 1
    }, cartScenario);
    addId({
      area: "Frontend",
      name: `Remove ${productName} from cart`,
      expected: `${productName} should be removable from the cart and the badge should clear.`,
      check: "saucedemo_remove_from_cart",
      navigateUrl: targetUrl,
      username: rowUsername,
      password: rowPassword,
      productName
    }, cartScenario);
    addId({
      area: "Frontend",
      name: `Remove and re-add ${productName}`,
      expected: `${productName} should be removable and then addable again.`,
      check: "saucedemo_readd_to_cart",
      navigateUrl: targetUrl,
      username: rowUsername,
      password: rowPassword,
      productName
    }, cartScenario);
  }

  return tests.map(t => ({
    ...t,
    steps: Array.isArray(t.steps) && t.steps.length ? t.steps : buildSteps(t, targetUrl)
  }));
}

async function postResult(data) {
  try {
    await fetch(`${process.env.SERVER_URL || "http://localhost:3000"}/test-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, runId: RUN_ID }),
      signal: AbortSignal.timeout(3000)
    });
  } catch (_) {}
}

async function generateFromExcel(html, scenario, workbookText, workbookRows) {
  const fixedSauceTests = sauceDemoLoginTests(workbookRows, TARGET_URL);
  if (fixedSauceTests) {
    console.log("   Provider: deterministic SauceDemo login suite");
    console.log(`   Generated ${fixedSauceTests.length} mixed Excel-driven test cases\n`);
    return fixedSauceTests;
  }

  const stripped = stripHtml(html, 70000);
  const baseUrl = TARGET_URL ? TARGET_URL.replace(/\/$/, "") : "";

  const isSauce = /saucedemo\.com/i.test(TARGET_URL || "");
  const sauceChecks = isSauce ? `
SAUCE DEMO STATEFUL CHECKS — the target site is saucedemo.com, so YOU MUST USE THESE for anything that happens AFTER login.
The generic checks above only inspect a SINGLE page load and do NOT log in. NEVER use visible / text_contains / attr_equals / not_visible / count_gte to assert anything on the inventory, cart, or any post-login page — they will FALSELY FAIL because no login is performed. Use these stateful checks instead; each one performs the login and navigation for you. Always include "navigateUrl": "${baseUrl}/" plus the username/password from the test data:
S1. saucedemo_login_success -> { "check": "saucedemo_login_success", "navigateUrl": "${baseUrl}/", "username": "standard_user", "password": "secret_sauce" }  (passes when login reaches the Products/inventory page)
S2. saucedemo_login_error -> { "check": "saucedemo_login_error", "navigateUrl": "${baseUrl}/", "username": "wrong_user", "password": "wrong_pass" }  (passes when login is REJECTED with an error — use for invalid AND locked_out_user rows)
S3. saucedemo_product_visible -> { "check": "saucedemo_product_visible", "navigateUrl": "${baseUrl}/", "username": "...", "password": "...", "productName": "Sauce Labs Backpack" }
S4. saucedemo_add_to_cart -> { "check": "saucedemo_add_to_cart", "navigateUrl": "${baseUrl}/", "username": "...", "password": "...", "productName": "...", "verify": "badge", "expectedCount": 1 }  (verify "badge" checks the cart badge; verify "item" opens the cart and checks the item is listed)
S5. saucedemo_add_button_changes -> { "check": "saucedemo_add_button_changes", "navigateUrl": "${baseUrl}/", "username": "...", "password": "...", "productName": "..." }
S6. saucedemo_remove_from_cart -> { "check": "saucedemo_remove_from_cart", "navigateUrl": "${baseUrl}/", "username": "...", "password": "...", "productName": "..." }
S7. saucedemo_readd_to_cart -> { "check": "saucedemo_readd_to_cart", "navigateUrl": "${baseUrl}/", "username": "...", "password": "...", "productName": "..." }

SAUCE DEMO MAPPING RULES:
- A valid / positive login row -> saucedemo_login_success.
- An invalid / wrong / "locked out" login row -> saucedemo_login_error (a locked-out login is a REJECTED login, so this check should PASS when the lock-out error appears).
- Any add-to-cart / product / checkout data row -> one or more of S3-S7 using that ProductName.
- Only use the generic checks for assertions on the LOGIN page itself that need NO login (e.g. attr_equals type=password on the password field, visible on #login-button).
` : "";

  const prompt = `
You are a senior QA engineer. Generate EXACTLY ${TEST_COUNT} executable test cases from:
1. The user's scenario
2. The uploaded Excel/CSV test data
3. The target website HTML

Treat each Excel row as scenario input/test data, not as a fully written test case.
Generate multiple executable test cases for each scenario when possible.
Every test case MUST include:
- scenarioId: stable lowercase id for the scenario group, for example "login-scenario" or "cart-scenario"
- scenarioName: short heading shown in the Live Run UI, for example "Login scenario" or "Cart scenario"
- steps: an ordered array of 3-6 short, human-readable manual test steps (strings). Start with opening the site, then the actions performed (with the exact Excel data used), and end with the verification step. Example: ["Open https://www.saucedemo.com/", "Enter username \\"standard_user\\"", "Enter password \\"secret_sauce\\"", "Click the Login button", "Confirm the Products page is shown"].

SCENARIO:
${scenario || "(No scenario text was provided. Infer likely test scenarios from the uploaded data.)"}

TEST DATA FROM EXCEL/CSV:
${workbookText}

IMPORTANT PASS/FAIL MIXING RULE:
- Prefer a realistic MIX of tests that are likely to pass and tests that may expose defects.
- Include positive checks using valid rows/data and negative checks using invalid, boundary, missing, duplicate, or malformed data when the sheet contains them or they are naturally implied.
- Do NOT invent impossible failures just to force red results.
- If the website and test data clearly support only passing tests or only failing tests, then same-kind results are allowed.
- Do NOT add generic page title, homepage load, or basic response-time checks unless the Excel scenario explicitly asks for them.

CHECK TYPES:
1. visible -> { "check": "visible", "selector": "CSS" }
2. not_visible -> { "check": "not_visible", "selector": "CSS" }
3. text_contains -> { "check": "text_contains", "selector": "CSS", "value": "text" }
4. count_gte -> { "check": "count_gte", "selector": "CSS", "expectedCount": 1 }
5. attr_equals -> { "check": "attr_equals", "selector": "CSS", "attribute": "type", "expectedValue": "password" }
6. click_then_visible -> { "check": "click_then_visible", "clickSelector": "CSS", "resultSelector": "CSS" }
7. fill_and_submit -> {
  "check": "fill_and_submit",
  "fields": [{"selector": "input[name='email'], input[type='email']", "value": "value from Excel"}],
  "submitSelector": "button[type='submit'], input[type='submit']",
  "successSelector": ".success, .error, [role='alert']"
}
8. api_request -> { "check": "api_request", "method": "GET", "url": "${baseUrl}/", "expectedStatus": 200, "maxResponseTime": 3000 }
9. html_contains -> { "check": "html_contains", "value": "string" }
10. html_not_contains -> { "check": "html_not_contains", "value": "string" }
${sauceChecks}
Rules:
- Use selectors that actually appear likely from the HTML.
- Use Excel values directly in form/API tests where relevant.
- Assign area as Security, Backend, Frontend, Performance, or Trivial.
- Keep names under 70 characters.
- Return ONLY valid JSON, no markdown.

JSON shape:
{
  "testCases": [
      {
        "id": "XL-01",
        "scenarioId": "login-scenario",
        "scenarioName": "Login scenario",
        "area": "Frontend",
        "name": "Short test name",
      "expected": "Expected correct behavior",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "check": "visible",
      "selector": "..."
    }
  ]
}

HTML SOURCE:
${stripped}`;

  const { data: testCases } = await generateJsonWithFallback(prompt, {
    maxTokens: 8192,
    successMessage: `AI generated ${TEST_COUNT} Excel-driven test cases`
  });
  return ensureScenarioFields(testCases, workbookRows, scenario);
}

async function main() {
  if (!EXCEL_FILE) {
    console.error("No Excel file provided. Use --excel-file path/to/file.xlsx");
    process.exit(1);
  }

  const scenario = readScenario();
  const workbookData = await readWorkbook(EXCEL_FILE);
  if (!REQUESTED_TEST_COUNT) {
    TEST_COUNT = suggestedTestCount(workbookData.rows, scenario);
  }
  TARGET_URL = TARGET_URL || workbookData.detectedUrl;
  const domain = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";

  console.log("=".repeat(60));
  console.log("   Document-Driven Test Runner (Excel / CSV / PDF / Word)");
  console.log("=".repeat(60));
  console.log(`   Site     : ${domain}`);
  console.log(`   Sprint   : ${SPRINT_NAME}`);
  console.log(`   Tests    : ${TEST_COUNT}`);
  console.log(`   Data     : ${path.basename(EXCEL_FILE)}`);
  console.log(`   Scenario : ${(scenario || "(none)").slice(0, 90)}`);
  console.log("=".repeat(60) + "\n");

  const { html, page, browser } = await getPageAndHtml(TARGET_URL);
  let testCases;
  try {
    testCases = await generateFromExcel(html, scenario, workbookData.text, workbookData.rows);
  } catch (err) {
    if (browser) await browser.close();
    throw err;
  }

  saveTestCases(domain, SPRINT_NAME, testCases, {
    source: "excel",
    url: TARGET_URL,
    scenario,
    dataFile: path.basename(EXCEL_FILE)
  });

  console.log(`   Running ${testCases.length} Excel-driven checks\n`);

  const failures = [];
  let passed = 0;

  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}  ${tc.name}... `);
    const liveMeta = {
      id: tc.id,
      name: tc.name,
      area: tc.area,
      scenarioId: tc.scenarioId,
      scenarioName: tc.scenarioName,
      expected: tc.expected,
      steps: tc.steps
    };
    await postResult({ ...liveMeta, status: "running" });

    try {
      const result = await executeCheck(page, html, tc);
      if (result.passed) {
        passed++;
        console.log("PASS");
        await postResult({ ...liveMeta, status: "pass" });
      } else {
        console.log(`FAIL - ${result.actual}`);
        const screenshot = await captureFailureScreenshot(page, RUN_ID, tc.id);
        await postResult({ ...liveMeta, status: "fail", actual: result.actual, screenshot });
        failures.push({
          id: tc.id,
          title: `${tc.id} - ${tc.name}`,
          scenarioId: tc.scenarioId,
          scenarioName: tc.scenarioName,
          errorType: tc.name,
          errorValue: result.actual,
          culprit: tc.id,
          testCase: tc.id,
          expected: tc.expected,
          area: tc.area || "",
          expectedToFail: !!tc.expectedToFail,
          screenshot
        });
      }
    } catch (err) {
      console.log(`ERROR - ${err.message}`);
      const screenshot = await captureFailureScreenshot(page, RUN_ID, tc.id);
      await postResult({ ...liveMeta, status: "error", actual: err.message, screenshot });
    }
  }

  let jiraCount = 0;
  let duplicateCount = 0;
  if (failures.length > 0) {
    for (const f of failures) {
      await postResult({
        id: f.id,
        name: f.title,
        status: "classifying",
        scenarioId: f.scenarioId,
        scenarioName: f.scenarioName
      });
    }
    const results = await runBatchAutomation(failures, async (r) => {
      const failure = failures.find(f => f.id === r.id);
      await postResult({
        id: r.id,
        name: failure?.title || r.id,
        area: failure?.area,
        scenarioId: failure?.scenarioId,
        scenarioName: failure?.scenarioName,
        status: "fail",
        actual: failure?.errorValue,
        category: r.category,
        reason: r.reason,
        jiraUrl: r.jiraUrl,
        screenshot: failure?.screenshot,
        pendingApproval: r.pendingApproval || false,
        duplicate: r.duplicate || false,
        duplicateKey: r.duplicateKey,
        repeatCount: r.repeatCount
      });
    });
    jiraCount = results.filter(r => r.logged).length;
    duplicateCount = results.filter(r => r.duplicate).length;
  }

  if (browser) await browser.close();
  await postResult({ id: "__done__", runFinished: true });
  saveRunResult(domain, SPRINT_NAME, RUN_ID, [], {
    passed,
    failed: testCases.length - passed,
    total: testCases.length,
    sprint: SPRINT_NAME
  });

  console.log("\n" + "=".repeat(60));
  console.log(`   Complete: ${passed}/${testCases.length} passed`);
  console.log(`   Jira tickets: ${jiraCount} created`);
  if (duplicateCount) console.log(`   Duplicates: ${duplicateCount}`);
  console.log("=".repeat(60) + "\n");
}

main().catch(err => { console.error("[Excel Runner Error]", err.message); process.exit(1); });
