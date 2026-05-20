require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const JIRA_AUTH = Buffer.from(
  `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
).toString("base64");

// ── Category config ───────────────────────────────────────────────────────────
const CATEGORY_CONFIG = {
  Security:    { priority: "Highest", emoji: "🔴", logToJira: true  },
  Backend:     { priority: "High",    emoji: "🟠", logToJira: true  },
  Frontend:    { priority: "Medium",  emoji: "🟡", logToJira: true  },
  Performance: { priority: "Medium",  emoji: "🔵", logToJira: true  },
  Trivial:     { priority: "Low",     emoji: "⚪", logToJira: false }
};

// ── Rule-based classifier (fallback when Gemini is unavailable) ───────────────
function classifyByRules(field, message) {
  const text = `${field} ${message}`.toLowerCase();

  // Security: password, card, auth, data exposure
  if (
    text.includes("password") || text.includes("plain text") ||
    text.includes("masked")   || text.includes("card") ||
    text.includes("security") || text.includes("auth") ||
    text.includes("exposed")  || text.includes("cvv")
  ) {
    return {
      category: "Security",
      classificationReason: "Rule match: contains password/card/auth keyword — potential data exposure"
    };
  }

  // Performance: sort, algorithm, string comparison
  if (
    text.includes("sort")        || text.includes("string instead") ||
    text.includes("performance") || text.includes("alphabetically") ||
    text.includes("algorithm")   || text.includes("recalculate")
  ) {
    return {
      category: "Performance",
      classificationReason: "Rule match: sorting or algorithmic inefficiency detected"
    };
  }

  // Backend: calculation, validation, logic, server
  if (
    text.includes("total")      || text.includes("calculation") ||
    text.includes("checkout")   || text.includes("coupon") ||
    text.includes("validation") || text.includes("empty cart") ||
    text.includes("shipping")   || text.includes("accepts")
  ) {
    return {
      category: "Backend",
      classificationReason: "Rule match: logic/calculation or missing validation error"
    };
  }

  // Trivial: cosmetic, badge, minor
  if (
    text.includes("badge")   || text.includes("cosmetic") ||
    text.includes("colour")  || text.includes("spacing") ||
    text.includes("typo")    || text.includes("label")
  ) {
    return {
      category: "Trivial",
      classificationReason: "Rule match: cosmetic or low-impact UI issue"
    };
  }

  // Default → Frontend
  return {
    category: "Frontend",
    classificationReason: "Rule match: defaulted to Frontend — UI or display issue"
  };
}

// ── Jira ticket creator ───────────────────────────────────────────────────────
async function createJiraTicket({ title, description, priority, labels }) {
  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issue`;

  const body = {
    fields: {
      project:     { key: process.env.JIRA_PROJECT_KEY },
      summary:     title,
      description: {
        type: "doc", version: 1,
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: description }]
        }]
      },
      issuetype: { name: "Bug" },
      priority:  { name: priority },
      labels,
      assignee:  { accountId: process.env.JIRA_ACCOUNT_ID }
    }
  };

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Authorization": `Basic ${JIRA_AUTH}`,
      "Content-Type":  "application/json",
      "Accept":        "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jira ${res.status}: ${err}`);
  }

  const data = await res.json();
  const ticketUrl = `${process.env.JIRA_BASE_URL}/browse/${data.key}`;
  console.log(`   🎫 Jira ticket created: ${data.key} → ${ticketUrl}`);
  return ticketUrl;
}

function buildSentryUrl(issueId) {
  return `https://${process.env.SENTRY_ORG_SLUG}.sentry.io/issues/${issueId}/`;
}

function getAgingInfo(firstSeen, level) {
  const daysOld = Math.floor((Date.now() - new Date(firstSeen)) / 86400000);
  const isUrgent = (level === "error" || level === "fatal") && daysOld >= 15;
  return { daysOld, isUrgent };
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
async function runAutomation(sentryPayload) {
  const issue      = sentryPayload.data?.issue || sentryPayload;
  const errorTitle = issue.title       || "Unknown Error";
  const errorLevel = issue.level       || "error";
  const culprit    = issue.culprit     || "Unknown location";
  const firstSeen  = issue.firstSeen   || new Date().toISOString();
  const issueId    = issue.id          || "";
  const sentryUrl  = issue.permalink   || buildSentryUrl(issueId);
  const errorType  = issue.metadata?.type  || errorTitle;
  const errorValue = issue.metadata?.value || "";
  const project    = issue.project?.name   || "DemoShop";

  const { daysOld, isUrgent } = getAgingInfo(firstSeen, errorLevel);

  // ── Step 1: Gemini — Classify + Analyse (single API call) ────────────────
  const prompt = `
You are a senior QA engineer reviewing a bug report from an e-commerce app.

Project : ${project}
Error   : ${errorType} — ${errorValue}
Location: ${culprit}
Severity: ${errorLevel}
Open for: ${daysOld} day(s)

Classify this bug into EXACTLY one of these categories:
- Security    → password exposure, card data issues, auth bypass, data leaks
- Backend     → wrong calculations, logic errors, missing validation on server
- Frontend    → UI display bugs, broken labels, wrong counts, case-sensitivity
- Performance → inefficient algorithms, wrong sort methods, unnecessary recalculations
- Trivial     → cosmetic issues, minor text errors, low-impact UI glitches

Reply ONLY with valid JSON (no markdown, no code fences):
{
  "category": "Security|Backend|Frontend|Performance|Trivial",
  "classificationReason": "One sentence explaining why this category was chosen",
  "brokenCode": "One sentence describing what code is broken and why",
  "fixes": ["Fix 1", "Fix 2", "Fix 3"],
  "emailBody": "Professional 2-sentence summary of this bug for the dev team"
}`;

  // Fallback values if Gemini is unavailable
  let ai = {
    category: "Frontend",
    classificationReason: "Could not classify — Gemini unavailable, defaulting to Frontend",
    brokenCode: `Error in ${culprit}: ${errorValue || errorTitle}`,
    fixes: [
      "Review and add input validation at the culprit location",
      "Add try/catch error handling around the failing operation",
      "Write a unit test to cover this edge case"
    ],
    emailBody: `A ${errorLevel}-level error "${errorTitle}" was detected in ${project}. Please review the Jira ticket for full context.`
  };

  try {
    // Try Gemini AI classification first
    const result  = await model.generateContent(prompt);
    const rawText = result.response.text().trim()
      .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed  = JSON.parse(rawText);

    // Ensure category is valid
    if (!CATEGORY_CONFIG[parsed.category]) parsed.category = "Frontend";
    ai = parsed;
    console.log(`   🤖 Classified by: Gemini AI`);
  } catch (_) {
    // Gemini unavailable — use rule-based classifier
    const ruled = classifyByRules(culprit, errorTitle);
    ai.category              = ruled.category;
    ai.classificationReason  = ruled.classificationReason;
    console.log(`   📏 Classified by: Rule-based system (Gemini unavailable)`);
  }

  const catConfig = CATEGORY_CONFIG[ai.category] || CATEGORY_CONFIG.Frontend;

  // ── Step 2: Classification decision ──────────────────────────────────────
  console.log(`   ${catConfig.emoji} Category : ${ai.category}`);
  console.log(`   📋 Reason   : ${ai.classificationReason}`);

  if (!catConfig.logToJira) {
    console.log(`   ⏭️  Skipping Jira — Trivial bug (captured in Sentry only)`);
    return;
  }

  console.log(`   ✅ Logging to Jira (category: ${ai.category})`);

  // ── Step 3: Create Jira ticket ────────────────────────────────────────────
  const priority = isUrgent ? "Highest" : catConfig.priority;
  const labels   = ["bug", "sentry", ai.category.toLowerCase(), ...(isUrgent ? ["URGENT"] : [])];

  const jiraDesc =
    `SENTRY ISSUE: ${errorTitle}\n\n` +
    `Error      : ${errorValue}\n` +
    `Location   : ${culprit}\n` +
    `Severity   : ${errorLevel.toUpperCase()}\n` +
    `Category   : ${ai.category}\n` +
    `First seen : ${firstSeen} (${daysOld} days ago)\n` +
    `Sentry URL : ${sentryUrl}\n\n` +
    `AI CLASSIFICATION:\n${ai.classificationReason}\n\n` +
    `BROKEN CODE:\n${ai.brokenCode}\n\n` +
    `SUGGESTED FIXES:\n${ai.fixes.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;

  try {
    await createJiraTicket({
      title:       `[${ai.category.toUpperCase()}] ${errorTitle}`,
      description: jiraDesc,
      priority,
      labels
    });
  } catch (_) {
    // Jira unavailable — skipped silently
  }
}

module.exports = { runAutomation };
