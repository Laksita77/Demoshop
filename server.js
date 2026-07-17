require("dotenv").config();
const http               = require("http");
const fs                 = require("fs");
const path               = require("path");
const os                 = require("os");
const { runAutomation, runBatchAutomation, processApproval, declineApproval, getPendingApproval } = require("./automation");
const { sendTestEmail } = require("./email");
const { handleChat, stopActive, resumeLastCommand } = require("./chat-agent");
const { listSites, listSprints, listRuns } = require("./storage");

const PORT = process.env.PORT || 3000;

// ── SSE state ─────────────────────────────────────────────────────────────────
const sseClients = [];
let   currentRun      = { id: null, tests: [], started: null, finished: false };
let   lastChatMessage = null;   // stored on every /chat call so Resume can replay it

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch (_) {} });
}

function parseMultipart(req, maxBytes = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const type = req.headers["content-type"] || "";
    const match = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!match) return reject(new Error("Missing multipart boundary"));

    const boundary = "--" + (match[1] || match[2]);
    const chunks = [];
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Upload is too large. Maximum size is 15 MB."));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("binary");
      const fields = {};
      const files = {};

      for (const rawPart of body.split(boundary)) {
        if (!rawPart || rawPart === "--\r\n" || rawPart === "--") continue;
        const part = rawPart.replace(/^\r\n/, "").replace(/\r\n--$/, "");
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;

        const header = part.slice(0, headerEnd);
        let content = part.slice(headerEnd + 4);
        if (content.endsWith("\r\n")) content = content.slice(0, -2);

        const nameMatch = header.match(/name="([^"]+)"/i);
        if (!nameMatch) continue;
        const name = nameMatch[1];
        const fileMatch = header.match(/filename="([^"]*)"/i);

        if (fileMatch && fileMatch[1]) {
          files[name] = {
            filename: path.basename(fileMatch[1]),
            buffer: Buffer.from(content, "binary")
          };
        } else {
          fields[name] = Buffer.from(content, "binary").toString("utf8");
        }
      }

      resolve({ fields, files });
    });

    req.on("error", reject);
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // ── 1. Bug log from frontend → Gemini classify → approval email → Jira ────────
  if (req.method === "POST" && req.url === "/log-bug") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        const { field, message, data } = JSON.parse(body);
        const timestamp = new Date().toLocaleTimeString();
        const bugId = `SH-${Date.now().toString(36).slice(-5).toUpperCase()}`;

        console.log(
          `\n[${timestamp}] SHOP BUG DETECTED\n` +
          `  ID      : ${bugId}\n` +
          `  Field   : ${field}\n` +
          `  Error   : ${message}\n` +
          `  Value   : ${data}\n`
        );

        // Route through approval flow — sends email before creating any Jira ticket
        runBatchAutomation([{
          id:         bugId,
          title:      `${field}: ${message}`,
          errorType:  field,
          errorValue: message,
          culprit:    field,
          testCase:   bugId,
          expected:   "No bug",
          area:       "Frontend"
        }]).catch(err => console.error("[Shop Bug Error]", err.message));

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
      lastChatMessage = message;   // save so Resume can replay

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

  if (req.method === "POST" && req.url === "/chat-excel") {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });

    parseMultipart(req)
      .then(({ fields, files }) => {
        const message = (fields.message || "").trim();
        const uploaded = files.excel || files.file;
        if (!uploaded) {
          res.write(`data: ${JSON.stringify({ type: "error", text: "Please upload an Excel, CSV, PDF, or Word file." })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          res.end();
          return;
        }

        const ext = path.extname(uploaded.filename).toLowerCase();
        if (![".xlsx", ".xls", ".csv", ".pdf", ".doc", ".docx"].includes(ext)) {
          res.write(`data: ${JSON.stringify({ type: "error", text: "Only .xlsx, .xls, .csv, .pdf, .doc, and .docx files are supported." })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          res.end();
          return;
        }

        const uploadDir = path.join(__dirname, "uploads");
        fs.mkdirSync(uploadDir, { recursive: true });
        const tmpFile = path.join(uploadDir, `qa-upload-${Date.now()}-${uploaded.filename}`);
        fs.writeFileSync(tmpFile, uploaded.buffer);
        lastChatMessage = message;

        const send = (chunk) => {
          try {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            if (chunk.type === "done") res.end();
          } catch (_) {}
        };

        handleChat(message, send, { excelFile: tmpFile, excelName: uploaded.filename })
          .catch(err => {
            try {
              res.write(`data: ${JSON.stringify({ type: "error", text: err.message })}\n\n`);
              res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
              res.end();
            } catch (_) {}
          })
          .finally(() => {});
      })
      .catch(err => {
        try {
          res.write(`data: ${JSON.stringify({ type: "error", text: err.message })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          res.end();
        } catch (_) {}
      });
    return;
  }
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
  if (req.method === "GET" && req.url.startsWith("/screenshots/")) {
    try {
      const root = path.resolve(__dirname, "screenshots");
      const requestPath = decodeURIComponent(req.url.split("?")[0].slice("/screenshots/".length));
      const filePath = path.resolve(root, requestPath);
      const rel = path.relative(root, filePath);

      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        res.writeHead(403); res.end("Forbidden"); return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Screenshot not found"); return; }
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        res.end(data);
      });
    } catch (_) {
      res.writeHead(400); res.end("Invalid screenshot path");
    }
    return;
  }

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

  // ── 6b. Stop the active test run ─────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/stop") {
    stopActive();
    currentRun.finished = true;
    broadcast(currentRun);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── 6c. Resume — re-run the exact last chat message ─────────────────────────
  if (req.method === "POST" && req.url === "/resume") {
    if (!lastChatMessage) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "No previous run to resume" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    // Re-run the exact child-process command. This preserves Excel upload files,
    // scenario files, counts, URLs, and manual/story temp-file arguments.
    resumeLastCommand(() => {}).catch(() => {});
    return;
  }

  // ── 6d. Public config — exposes non-secret env vars for the dashboard ─────────
  if (req.method === "GET" && req.url === "/config") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ qaLeadEmail: process.env.QA_LEAD_EMAIL || "" }));
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

  // ── 8a. Confirmation page for approve ────────────────────────────────────────
  if (req.method === "GET" && req.url.startsWith("/approve/confirm/")) {
    const token = req.url.slice("/approve/confirm/".length).split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html" });
    processApproval(token)
      .then(({ jiraUrl, jiraKey, category, title, testCase }) => {
        const idx = currentRun.tests.findIndex(t => t.id === testCase);
        if (idx >= 0) {
          Object.assign(currentRun.tests[idx], { jiraUrl, pendingApproval: false });
        } else {
          if (!currentRun.id) currentRun = { id: `approved-${Date.now()}`, tests: [], started: new Date().toISOString(), finished: true };
          currentRun.tests.push({ id: testCase, name: title, status: "fail", category, jiraUrl, pendingApproval: false });
        }
        broadcast(currentRun);
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bug Approved</title>
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
<div class="card"><div style="font-size:56px;">${alreadyDone ? "⚠️" : "❌"}</div>
<h1>${alreadyDone ? "Already Processed" : "Error"}</h1><p>${err.message}</p>
</div></body></html>`);
      });
    return;
  }

  // ── 8b. Confirmation page for decline ────────────────────────────────────────
  if (req.method === "GET" && req.url.startsWith("/decline/confirm/")) {
    const token = req.url.slice("/decline/confirm/".length).split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html" });
    try {
      const { category, title, testCase } = declineApproval(token);
      const idx = currentRun.tests.findIndex(t => t.id === testCase);
      if (idx >= 0) {
        Object.assign(currentRun.tests[idx], { status: "declined", pendingApproval: false });
      } else {
        if (!currentRun.id) currentRun = { id: `declined-${Date.now()}`, tests: [], started: new Date().toISOString(), finished: true };
        currentRun.tests.push({ id: testCase, name: title, status: "declined", category, pendingApproval: false });
      }
      broadcast(currentRun);
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bug Declined</title>
<style>body{font-family:Arial,sans-serif;background:#fef2f2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#c62828;margin:0 0 12px;}p{color:#444;font-size:15px;}</style></head><body>
<div class="card"><div style="font-size:56px;">🚫</div>
<h1>Bug Declined</h1><p><strong>${title}</strong></p>
<p>No Jira ticket was created. The bug report has been dismissed (<em>${category}</em>).</p>
</div></body></html>`);
    } catch (err) {
      const alreadyDone = err.message.startsWith("Already");
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${alreadyDone ? "Already Processed" : "Error"}</title>
<style>body{font-family:Arial,sans-serif;background:#fffbeb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#b45309;margin:0 0 12px;}p{color:#444;font-size:15px;}</style></head><body>
<div class="card"><div style="font-size:56px;">${alreadyDone ? "⚠️" : "❌"}</div>
<h1>${alreadyDone ? "Already Processed" : "Error"}</h1><p>${err.message}</p>
</div></body></html>`);
    }
    return;
  }

  // ── 8. Approve → show confirmation page first ────────────────────────────────
  if (req.method === "GET" && req.url.startsWith("/approve/")) {
    const token = req.url.slice("/approve/".length).split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html" });
    const approval = getPendingApproval(token);
    if (!approval) {
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invalid</title></head><body><p>Invalid or expired token.</p></body></html>`);
      return;
    }
    if (approval.status !== "pending") {
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Already Processed</title>
<style>body{font-family:Arial,sans-serif;background:#fffbeb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#b45309;margin:0 0 12px;}p{color:#444;font-size:15px;}</style></head><body>
<div class="card"><div style="font-size:56px;">⚠️</div><h1>Already Processed</h1>
<p>This bug report has already been ${approval.status}.</p></div></body></html>`);
      return;
    }
    const { title, category } = approval.bugData;
    const CATEGORY_STYLE = { Security:"#d32f2f", Backend:"#e65100", Frontend:"#f9a825", Performance:"#1565c0", Trivial:"#616161" };
    const colour = CATEGORY_STYLE[category] || "#444";
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Confirm Approval</title>
<style>
body{font-family:Arial,sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#1a3c6e;margin:0 0 8px;font-size:20px;}
.bug-title{font-size:15px;color:#1a1a1a;font-weight:bold;margin:12px 0 4px;}
.cat{display:inline-block;padding:3px 12px;border-radius:4px;font-size:13px;font-weight:bold;color:${colour};border:1px solid ${colour};margin-bottom:16px;}
.question{font-size:15px;color:#444;margin:16px 0 24px;}
.btn-yes{display:inline-block;background:#2e7d32;color:#fff;text-decoration:none;padding:12px 32px;border-radius:6px;font-size:15px;font-weight:bold;margin-right:12px;}
.btn-no{display:inline-block;background:#c62828;color:#fff;text-decoration:none;padding:12px 32px;border-radius:6px;font-size:15px;font-weight:bold;}
</style></head><body>
<div class="card">
  <div style="font-size:48px;">🎫</div>
  <h1>Confirm Bug Approval</h1>
  <p class="bug-title">${title}</p>
  <span class="cat">${category}</span>
  <p class="question">Do you really want to create a Jira ticket for this bug?</p>
  <a class="btn-yes" href="/approve/confirm/${token}">✅ Yes, Create Ticket</a>
  <a class="btn-no" href="/cancel">❌ No, Cancel</a>
</div></body></html>`);
    return;
  }

  // ── 9. Decline → show confirmation page first ─────────────────────────────────
  if (req.method === "GET" && req.url.startsWith("/decline/")) {
    const token = req.url.slice("/decline/".length).split("?")[0];
    res.writeHead(200, { "Content-Type": "text/html" });
    const approval = getPendingApproval(token);
    if (!approval) {
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invalid</title></head><body><p>Invalid or expired token.</p></body></html>`);
      return;
    }
    if (approval.status !== "pending") {
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Already Processed</title>
<style>body{font-family:Arial,sans-serif;background:#fffbeb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#b45309;margin:0 0 12px;}p{color:#444;font-size:15px;}</style></head><body>
<div class="card"><div style="font-size:56px;">⚠️</div><h1>Already Processed</h1>
<p>This bug report has already been ${approval.status}.</p></div></body></html>`);
      return;
    }
    const { title, category } = approval.bugData;
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Confirm Decline</title>
<style>
body{font-family:Arial,sans-serif;background:#fef2f2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#c62828;margin:0 0 8px;font-size:20px;}
.bug-title{font-size:15px;color:#1a1a1a;font-weight:bold;margin:12px 0 16px;}
.question{font-size:15px;color:#444;margin:0 0 24px;}
.btn-yes{display:inline-block;background:#c62828;color:#fff;text-decoration:none;padding:12px 32px;border-radius:6px;font-size:15px;font-weight:bold;margin-right:12px;}
.btn-no{display:inline-block;background:#2e7d32;color:#fff;text-decoration:none;padding:12px 32px;border-radius:6px;font-size:15px;font-weight:bold;}
</style></head><body>
<div class="card">
  <div style="font-size:48px;">🚫</div>
  <h1>Confirm Decline</h1>
  <p class="bug-title">${title}</p>
  <p class="question">Do you really want to decline this bug? No Jira ticket will be created.</p>
  <a class="btn-yes" href="/decline/confirm/${token}">✅ Yes, Decline</a>
  <a class="btn-no" href="/cancel">❌ No, Go Back</a>
</div></body></html>`);
    return;
  }

  // ── Cancel ────────────────────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/cancel") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Cancelled</title>
<style>body{font-family:Arial,sans-serif;background:#fffbeb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:40px 48px;max-width:480px;text-align:center;}
h1{color:#b45309;margin:0 0 12px;}p{color:#444;font-size:15px;}</style></head><body>
<div class="card"><div style="font-size:56px;">↩️</div><h1>Action Cancelled</h1>
<p>No changes were made. You can close this tab.</p></div></body></html>`);
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
