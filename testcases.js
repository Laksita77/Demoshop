const fs   = require("fs");
const path = require("path");

const shopHtml = fs.readFileSync(path.join(__dirname, "shop.html"), "utf8");

const TESTCASES = [

  // ── PASSING TESTS (5) ─────────────────────────────────────────────────────

  {
    id:       "TC-01",
    area:     "Security",
    name:     "Registration password field must be masked",
    expected: "Password input must have type='password' to hide characters",
    run() {
      const field  = shopHtml.match(/id="regPassword"[^>]*/)?.[0] || "";
      const passed = !field.includes('type="text"');
      return {
        passed,
        actual: passed
          ? "Password field has type='password' — correctly masked"
          : "Password field has type='text' — password visible in plain text"
      };
    }
  },

  {
    id:       "TC-02",
    area:     "Backend",
    name:     "Order total must include $5.00 shipping fee",
    expected: "Total = subtotal - discount + 5.00",
    run() {
      const renderFn = shopHtml.match(/function renderCheckout\(\)([\s\S]*?)^  \}/m)?.[0] || "";
      const passed   = renderFn.includes("+ 5") || renderFn.includes("+ shipping") || renderFn.includes("+5");
      return {
        passed,
        actual: passed
          ? "Order total correctly includes $5.00 shipping fee"
          : "Order total excludes $5.00 shipping — customer is undercharged"
      };
    }
  },

  {
    id:       "TC-03",
    area:     "Frontend",
    name:     "Product search must be case-insensitive",
    expected: "Search applies .toLowerCase() on both term and product name",
    run() {
      const filterBlock = shopHtml.match(/\/\/ Search filter([\s\S]*?)if \(list\.length === 0/)?.[0] || "";
      const passed      = filterBlock.includes("toLowerCase");
      return {
        passed,
        actual: passed
          ? "Search is case-insensitive — toLowerCase applied correctly"
          : "Search is case-sensitive — 'laptop' returns 0 results for 'Laptop Pro'"
      };
    }
  },

  {
    id:       "TC-04",
    area:     "Security",
    name:     "Email validation must require a valid top-level domain",
    expected: "Email regex must reject addresses without a TLD like .com",
    run() {
      const passed = !shopHtml.includes("/^[^\\s@]+@[^\\s@]+$/");
      return {
        passed,
        actual: passed
          ? "Email validation correctly requires a valid TLD"
          : "Email regex missing TLD check — 'user@domain' passes validation"
      };
    }
  },

  {
    id:       "TC-05",
    area:     "Frontend",
    name:     "Login form must have email and password fields",
    expected: "Login form must contain loginEmail and loginPassword input fields",
    run() {
      const hasEmail    = shopHtml.includes('id="loginEmail"');
      const hasPassword = shopHtml.includes('id="loginPassword"');
      const passed      = hasEmail && hasPassword;
      return {
        passed,
        actual: passed
          ? "Login form has both email and password fields"
          : `Login form missing: ${!hasEmail ? "loginEmail " : ""}${!hasPassword ? "loginPassword" : ""}`
      };
    }
  },

  // ── FAILING TESTS (5) ─────────────────────────────────────────────────────

  {
    id:       "TC-06",
    area:     "Frontend",
    name:     "Phone number field must reject non-numeric input",
    expected: "Phone field must have type='tel' or a numeric pattern attribute",
    run() {
      const field  = shopHtml.match(/id="chkPhone"[^>]*/)?.[0] || "";
      const passed = field.includes('type="tel"') || field.includes("pattern=");
      return {
        passed,
        actual: passed
          ? "Phone field has proper numeric validation"
          : "Phone field is type='text' with no pattern — accepts alphabetical characters"
      };
    }
  },

  {
    id:       "TC-07",
    area:     "Security",
    name:     "Credit card number must require exactly 16 digits",
    expected: "Card validation must check card.length === 16 before placing order",
    run() {
      const passed = shopHtml.includes("card.length === 16") || shopHtml.includes("raw.length === 16");
      return {
        passed,
        actual: passed
          ? "Card validation correctly requires exactly 16 digits"
          : "Card validation allows fewer than 16 digits — incomplete card number accepted"
      };
    }
  },

  {
    id:       "TC-08",
    area:     "Performance",
    name:     "Price sort must use numeric comparison not string comparison",
    expected: "Sort must use (a.price - b.price) not localeCompare",
    run() {
      const passed = !shopHtml.includes("String(a.price).localeCompare") &&
                     !shopHtml.includes("String(b.price).localeCompare");
      return {
        passed,
        actual: passed
          ? "Price sort uses correct numeric comparison"
          : "Price sort uses string comparison — $1350 appears before $699 (alphabetical bug)"
      };
    }
  },

  {
    id:       "TC-09",
    area:     "Frontend",
    name:     "Product rating must not show NaN for zero-review products",
    expected: "Rating calculation must handle reviews === 0 without producing NaN",
    run() {
      const passed = !shopHtml.includes("(p.rating * p.reviews) / p.reviews");
      return {
        passed,
        actual: passed
          ? "Rating correctly handles zero-review products"
          : "Rating formula produces NaN when reviews = 0 (division by zero)"
      };
    }
  },

  {
    id:       "TC-10",
    area:     "Frontend",
    name:     "Cart badge must display the exact item count",
    expected: "Badge must show total quantity with no off-by-one addition",
    run() {
      const passed = !shopHtml.includes("total + 1");
      return {
        passed,
        actual: passed
          ? "Cart badge displays correct item count"
          : "Cart badge shows N+1 items — off-by-one error makes count always one too high"
      };
    }
  }

];

module.exports = TESTCASES;
