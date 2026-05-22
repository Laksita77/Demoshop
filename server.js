require("dotenv").config();
const http              = require("http");
const fs                = require("fs");
const path              = require("path");
const { runAutomation } = require("./automation");

const PORT = 3000;

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

  // ── 2. Serve shop.html ──────────────────────────────────────────────────────
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
  console.log(`   Browser : http://localhost:${PORT}`);
  console.log(`   Gemini  : ${process.env.GEMINI_API_KEY ? "connected" : "not configured"}`);
  console.log(`   Jira    : ${process.env.JIRA_BASE_URL  ? "connected" : "not configured"}`);
  console.log("========================================\n");

  const { exec } = require("child_process");
  exec(`start http://localhost:${PORT}`);
});
