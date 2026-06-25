// alerts.js — Slack & Teams webhook notifications
require("dotenv").config();
const https   = require("https");
const { URL } = require("url");

const EMOJI = { Security:"🔴", Backend:"🟠", Frontend:"🟡", Performance:"🔵", Trivial:"⚪" };
const COLOR = { Security:"f85149", Backend:"e3b341", Frontend:"58a6ff", Performance:"bc8cff", Trivial:"8b949e" };

async function postWebhook(webhookUrl, payload) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(webhookUrl);
      const body   = JSON.stringify(payload);
      const req    = https.request({
        hostname: parsed.hostname, path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        rejectUnauthorized: false
      }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", () => resolve(0));
      req.write(body); req.end();
    } catch(_) { resolve(0); }
  });
}

async function sendSlackAlert({ title, category, jiraUrl, actual, fixes, reason }) {
  const webhook     = process.env.SLACK_WEBHOOK_URL;
  if (!webhook || webhook.length < 10) return;
  const emoji       = EMOJI[category] || "🐛";
  const jiraKey     = jiraUrl ? jiraUrl.split("/browse/")[1] : null;
  const qaLeadName  = process.env.QA_LEAD_NAME  || "QA Lead";
  const qaLeadEmail = process.env.QA_LEAD_EMAIL || "";
  const qaLeadStr   = qaLeadEmail ? `${qaLeadName} (${qaLeadEmail})` : qaLeadName;
  try {
    const status = await postWebhook(webhook, {
      blocks: [
        { type:"header", text:{ type:"plain_text", text:`${emoji} Bug Report — ${category}`, emoji:true } },
        { type:"section", fields:[
            { type:"mrkdwn", text:`*Test Case:*\n${title}` },
            { type:"mrkdwn", text:`*Category:*\n${emoji} ${category}` },
            { type:"mrkdwn", text:`*Actual Error:*\n${actual || "—"}` },
            { type:"mrkdwn", text:`*Jira Ticket:*\n${jiraKey ? `<${jiraUrl}|${jiraKey}>` : "—"}` }
        ]},
        { type:"section", fields:[
            { type:"mrkdwn", text:`*👤 QA Lead:*\n${qaLeadStr}` },
            { type:"mrkdwn", text:`*🤖 AI Analysis:*\n${reason || "—"}` }
        ]},
        fixes?.length ? { type:"section", text:{ type:"mrkdwn", text:`*✅ Suggested Fixes:*\n${fixes.map(f=>`• ${f}`).join("\n")}` } } : null,
        { type:"divider" }
      ].filter(Boolean)
    });
    console.log(`   📣 Slack → ${status === 200 ? "✅ sent" : `⚠️  failed (HTTP ${status})`}`);
  } catch(err) { console.log(`   ⚠️  Slack alert error: ${err.message}`); }
}

async function sendTeamsAlert({ title, category, jiraUrl, actual, fixes, reason }) {
  const webhook     = process.env.TEAMS_WEBHOOK_URL;
  if (!webhook || webhook.length < 10) return;
  const emoji       = EMOJI[category] || "🐛";
  const color       = COLOR[category]  || "8b949e";
  const jiraKey     = jiraUrl ? jiraUrl.split("/browse/")[1] : null;
  const qaLeadName  = process.env.QA_LEAD_NAME  || "QA Lead";
  const qaLeadEmail = process.env.QA_LEAD_EMAIL || "";
  try {
    const status = await postWebhook(webhook, {
      "@type":"MessageCard", "@context":"http://schema.org/extensions",
      themeColor: color,
      summary: `Bug Report for QA Lead (${qaLeadName}): ${title}`,
      sections: [
        {
          activityTitle: `${emoji} **${category} Bug — QA Review Required**`,
          activitySubtitle: title,
          facts: [
            { name:"👤 QA Lead",       value: qaLeadEmail ? `${qaLeadName} (${qaLeadEmail})` : qaLeadName },
            { name:"❌ Actual Error",  value: actual   || "—" },
            { name:"🤖 AI Analysis",  value: reason   || "—" },
            { name:"🎫 Jira Ticket",  value: jiraKey  || "—" }
          ], markdown: true
        },
        fixes?.length ? { title:"✅ Suggested Fixes", text: fixes.map(f=>`• ${f}`).join("<br>") } : null
      ].filter(Boolean),
      potentialAction: jiraUrl ? [{ "@type":"OpenUri", name:`Open ${jiraKey} in Jira`, targets:[{ os:"default", uri:jiraUrl }] }] : []
    });
    console.log(`   📣 Teams → QA Lead: ${qaLeadName} — ${status === 200 ? "✅ sent" : `⚠️  failed (HTTP ${status})`}`);
  } catch(err) { console.log(`   ⚠️  Teams alert error: ${err.message}`); }
}

async function sendAlerts(params) {
  await Promise.allSettled([sendSlackAlert(params), sendTeamsAlert(params)]);
}

module.exports = { sendAlerts, sendSlackAlert, sendTeamsAlert };
