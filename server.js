require("dotenv").config();
const http               = require("http");
const fs                 = require("fs");
const path               = require("path");
const { runAutomation, processApproval, declineApproval } = require("./automation");
const { sendTestEmail } = require("./email");
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

  // ── Sprint Health — aggregated pass/fail per sprint across all sites ─────────
  if (req.method === "GET" && req.url === "/sprint-health") {
    try {
      const { BASE_DIR, sanitize } = require("./storage");
      const sites = listSites();
      const health = sites.map(site => {
        const sprints = listSprints(site.domain).map(sp => {
          const runs   = listRuns(site.domain, sp.sprint);
          const latest = runs[0] || {};
          // aggregate all runs for trend
          const trend  = runs.slice(0, 10).reverse().map(r => ({
            time:   r.timestamp || null,
            passed: r.passed  || 0,
            failed: r.failed  || 0,
            total:  r.total   || 0,
            pct:    r.total   ? Math.round((r.passed / r.total) * 100) : 0
          }));
          const cats = {};
          try {
            const tcFile = require("path").join(BASE_DIR, sanitize(site.domain), "sprints", sanitize(sp.sprint), "testcases.json");
            if (require("fs").existsSync(tcFile)) {
              const tc = JSON.parse(require("fs").readFileSync(tcFile, "utf8"));
              // count failures per category from run results
            }
          } catch(_) {}
          return { sprint: sp.sprint, runCount: runs.length, latest, trend };
        });
        return { domain: site.domain, sprints };
      });
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(health));
    } catch(err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
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

  // ── 6. Current run state — dashboard fallback when SSE initial message is missed
  if (req.method === "GET" && req.url === "/current-run") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(currentRun));
    return;
  }

  // ── 7. SMTP test — hit http://localhost:3000/test-email to verify email works ─
  if (req.method === "GET" && req.url === "/test-email") {
    sendTestEmail().then(result => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result, null, 2));
    }).catch(err => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    });
    return;
  }

  // ── 8. Tester approves bug → create Jira ticket ─────────────────────────────
  if (req.method === "GET" && req.url.startsWith("/approve/")) {
    const token = req.url.slice("/approve/".length).split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html" });

    processApproval(token)
      .then(({ jiraUrl, jiraKey, category, title, testCase }) => {
        // Update dashboard live
        const idx = currentRun.tests.findIndex(t => t.id === testCase);
        if (idx >= 0) {
          Object.assign(currentRun.tests[idx], { jiraUrl, pendingApproval: false });
          broadcast(currentRun);
        }
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Bug Approved</title>
<style>body{font-family:Arial,sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#2e7d32;margin:0 0 12px;}p{color:#444;font-size:15px;}
a{display:inline-block;margin-top:20px;background:#1A3C6E;color:#fff;text-decoration:none;padding:10px 24px;border-radius:5px;font-size:14px;font-weight:bold;}
</style></head><body>
<div class="card">
  <div style="font-size:56px;">✅</div>
  <h1>Bug Approved</h1>
  <p><strong>${title}</strong></p>
  <p>Jira ticket <strong>${jiraKey}</strong> has been created under <em>${category}</em>.</p>
  <a href="${jiraUrl}" target="_blank">🎫 View Jira Ticket</a>
</div></body></html>`);
      })
      .catch(err => {
        const alreadyDone = err.message.startsWith("Already");
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${alreadyDone ? "Already Processed" : "Error"}</title>
<style>body{font-family:Arial,sans-serif;background:#fffbeb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#b45309;margin:0 0 12px;}p{color:#444;font-size:15px;}</style></head><body>
<div class="card">
  <div style="font-size:56px;">${alreadyDone ? "⚠️" : "❌"}</div>
  <h1>${alreadyDone ? "Already Processed" : "Error"}</h1>
  <p>${err.message}</p>
</div></body></html>`);
      });
    return;
  }

  // ── 9. Tester declines bug → no Jira ticket ──────────────────────────────────
  if (req.method === "GET" && req.url.startsWith("/decline/")) {
    const token = req.url.slice("/decline/".length).split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html" });

    try {
      const { category, title, testCase } = declineApproval(token);
      // Update dashboard live
      const idx = currentRun.tests.findIndex(t => t.id === testCase);
      if (idx >= 0) {
        Object.assign(currentRun.tests[idx], { status: "declined", pendingApproval: false });
        broadcast(currentRun);
      }
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bug Declined</title>
<style>body{font-family:Arial,sans-serif;background:#fef2f2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#c62828;margin:0 0 12px;}p{color:#444;font-size:15px;}</style></head><body>
<div class="card">
  <div style="font-size:56px;">❌</div>
  <h1>Bug Declined</h1>
  <p><strong>${title}</strong></p>
  <p>No Jira ticket was created. The bug report has been dismissed (<em>${category}</em>).</p>
</div></body></html>`);
    } catch (err) {
      const alreadyDone = err.message.startsWith("Already");
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${alreadyDone ? "Already Processed" : "Error"}</title>
<style>body{font-family:Arial,sans-serif;background:#fffbeb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#b45309;margin:0 0 12px;}p{color:#444;font-size:15px;}</style></head><body>
<div class="card">
  <div style="font-size:56px;">${alreadyDone ? "⚠️" : "❌"}</div>
  <h1>${alreadyDone ? "Already Processed" : "Error"}</h1>
  <p>${err.message}</p>
</div></body></html>`);
    }
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
