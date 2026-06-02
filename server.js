require("dotenv").config();
const http               = require("http");
const fs                 = require("fs");
const path               = require("path");
const { runAutomation }  = require("./automation");
const { handleChat }     = require("./chat-agent");
const { listSites, listSprints, listRuns } = require("./storage");

const PORT = process.env.PORT || 3000;

// ── SSE state ─────────────────────────────────────────────────────────────────
const sseClients = [];
let   currentRun = { id: null, tests: [], started: null, finished: false };

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch (_) {} });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // ── 1. Bug log from frontend → Gemini classify → Jira ──────────────────────
  if (req.method === "POST" && req.url === "/log-bug") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        const { field, message, data } = JSON.parse(body);
        const timestamp = new Date().toLocaleTimeString();

        // Print to terminal
        console.log(
          `\n[${timestamp}] ISSUE DETECTED\n` +
          `  Field   : ${field}\n` +
          `  Error   : ${message}\n` +
          `  Value   : ${data}\n`
        );

        // Gemini classify → Jira
        runAutomation({
          data: {
            issue: {
              title:     `${field}: ${message}`,
              level:     "error",
              culprit:   field,
              firstSeen: new Date().toISOString(),
              metadata:  { type: field, value: data },
              project:   { name: "DemoShop" }
            }
          }
        }).catch(err => console.error("[Automation Error]", err.message));

      } catch (_) {}
      res.writeHead(200);
      res.end();
    });
    return;
  }

  // ── 2. AI Chat Agent ──────────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });

      let { message } = JSON.parse(body || "{}");
      if (!message) { res.end(); return; }

      handleChat(message, (chunk) => {
        try {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (chunk.type === "done") res.end();
        } catch (_) {}
      }).catch(() => { try { res.end(); } catch (_) {} });
    });
    return;
  }

  // ── 3. Receive test result from runners → broadcast to dashboard ───────────
  if (req.method === "POST" && req.url === "/test-result") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        const result = JSON.parse(body);
        if (!currentRun.id || result.runId !== currentRun.id) {
          currentRun = { id: result.runId, tests: [], started: new Date().toISOString(), finished: false };
        }
        if (result.runFinished) {
          currentRun.finished = true;
        } else {
          const idx = currentRun.tests.findIndex(t => t.id === result.id);
          if (idx >= 0) Object.assign(currentRun.tests[idx], result);
          else currentRun.tests.push(result);
        }
        broadcast(currentRun);
      } catch (_) {}
      res.writeHead(200); res.end();
    });
    return;
  }

  // ── 3b. Test Suite History API ───────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/history") {
    try {
      const sites = listSites();
      const payload = sites.map(s => ({
        ...s,
        sprints: listSprints(s.domain).map(sp => ({
          ...sp,
          runs: listRuns(s.domain, sp.sprint).slice(0, 5)  // last 5 runs per sprint
        }))
      }));
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── 3. SSE stream for live dashboard ────────────────────────────────────────
  if (req.method === "GET" && req.url === "/stream") {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive"
    });
    res.write(`data: ${JSON.stringify(currentRun)}\n\n`);
    sseClients.push(res);
    req.on("close", () => sseClients.splice(sseClients.indexOf(res), 1));
    return;
  }

  // ── 4. Serve dashboard ───────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/dashboard") {
    const filePath = path.join(__dirname, "dashboard.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end("Dashboard not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  // ── 5. Serve shop.html ──────────────────────────────────────────────────────
  if (req.method === "GET" && (req.url === "/" || req.url === "/shop" || req.url === "/shop.html")) {
    const filePath = path.join(__dirname, "shop.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end("Error loading page"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("\n========================================");
  console.log("         DemoShop — Running             ");
  console.log("========================================");
  console.log(`   Shop      : http://localhost:${PORT}`);
  console.log(`   Dashboard : http://localhost:${PORT}/dashboard`);
  console.log(`   Gemini  : ${process.env.GEMINI_API_KEY ? "connected" : "not configured"}`);
  console.log(`   Jira    : ${process.env.JIRA_BASE_URL  ? "connected" : "not configured"}`);
  console.log("========================================\n");

  // Auto-open only when running locally
  if (!process.env.RENDER) {
    const { exec } = require("child_process");
    exec(`start http://localhost:${PORT}`);
  }
});
