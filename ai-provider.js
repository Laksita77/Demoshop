const { GoogleGenerativeAI } = require("@google/generative-ai");

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

function cleanJsonText(text) {
  return String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function parseJsonResponse(rawText) {
  const parsed = JSON.parse(cleanJsonText(rawText));
  return parsed.testCases ?? parsed;
}

async function callClaude(prompt, maxTokens) {
  if (!CLAUDE_API_KEY) {
    throw new Error("Claude API key not configured");
  }

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }]
  });

  return msg.content
    .map(part => part.type === "text" ? part.text : "")
    .join("\n");
}

function buildGeminiModels() {
  if (!process.env.GEMINI_API_KEY) return [];

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const genAI2 = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY);

  return [
    { model: genAI.getGenerativeModel({ model: "gemini-2.5-flash" }),         name: "Gemini 2.5 Flash [K1]" },
    { model: genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" }),    name: "Gemini 2.5 Flash Lite [K1]" },
    { model: genAI.getGenerativeModel({ model: "gemini-flash-lite-latest" }), name: "Gemini Flash Lite [K1]" },
    { model: genAI.getGenerativeModel({ model: "gemini-2.0-flash" }),         name: "Gemini 2.0 Flash [K1]" },
    { model: genAI2.getGenerativeModel({ model: "gemini-2.5-flash" }),        name: "Gemini 2.5 Flash [K2]" },
    { model: genAI2.getGenerativeModel({ model: "gemini-2.5-flash-lite" }),   name: "Gemini 2.5 Flash Lite [K2]" },
    { model: genAI2.getGenerativeModel({ model: "gemini-flash-lite-latest" }),name: "Gemini Flash Lite [K2]" },
    { model: genAI2.getGenerativeModel({ model: "gemini-2.0-flash" }),        name: "Gemini 2.0 Flash [K2]" }
  ];
}

async function generateJsonWithFallback(prompt, options = {}) {
  const maxTokens = options.maxTokens || 8192;
  const successMessage = options.successMessage || "AI generated JSON";

  if (CLAUDE_API_KEY) {
    try {
      const raw = await callClaude(prompt, maxTokens);
      const data = parseJsonResponse(raw);
      console.log(`   Provider: Claude (${CLAUDE_MODEL})`);
      console.log(`   ${successMessage}\n`);
      return { data, provider: "Claude" };
    } catch (err) {
      console.log(`   Claude failed: ${err.message.slice(0, 140)} - switching to Gemini...`);
    }
  } else {
    console.log("   Claude not configured - using Gemini...");
  }

  for (const { model, name: modelName } of buildGeminiModels()) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        const data = parseJsonResponse(result.response.text());
        console.log(`   Provider: ${modelName}`);
        console.log(`   ${successMessage}\n`);
        return { data, provider: modelName };
      } catch (err) {
        const isQuota = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        const is404 = err.message?.includes("404");
        if (isQuota || is404) {
          console.log(`   ${modelName} ${is404 ? "not available" : "quota exhausted"} - switching...`);
          break;
        }

        const retryable = err.message?.includes("429") || err.message?.includes("503");
        if (!retryable || attempt === 4) {
          console.log(`   ${modelName} failed - switching...`);
          break;
        }

        const wait = err.message?.includes("503") ? 10000 : 20000;
        console.log(`   ${modelName} busy - retrying in ${wait / 1000}s... (${attempt}/4)`);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }

  throw new Error("Claude and Gemini are unavailable or returned invalid JSON. Please check API keys/quota and try again.");
}

module.exports = { generateJsonWithFallback };
