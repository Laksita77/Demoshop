
require("dotenv").config();

const nodemailer = require("nodemailer");
 
// ── SMTP Transporter ──────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({

  host:   process.env.SMTP_HOST || "smtp.gmail.com",

  port:   parseInt(process.env.SMTP_PORT) || 587,

  secure: false,

  auth: {

    user: process.env.EMAIL_FROM,

    pass: process.env.EMAIL_APP_PASSWORD

  }

});
 
// ── Category colours ──────────────────────────────────────────────────────────

const CATEGORY_STYLE = {

  Security:    { color: "#d32f2f", bg: "#ffebee", emoji: "🔴" },

  Backend:     { color: "#e65100", bg: "#fff3e0", emoji: "🟠" },

  Frontend:    { color: "#f9a825", bg: "#fffde7", emoji: "🟡" },

  Performance: { color: "#1565c0", bg: "#e3f2fd", emoji: "🔵" },

  Trivial:     { color: "#616161", bg: "#f5f5f5", emoji: "⚪" }

};
 
// ── Post-approval notification email (Jira link included) ────────────────────

function buildEmailHtml({ title, category, expected, actual, reason, fixes, jiraUrl, testCase, qaLeadName }) {

  const style   = CATEGORY_STYLE[category] || CATEGORY_STYLE.Frontend;

  const name    = qaLeadName || process.env.QA_LEAD_NAME || "QA Lead";

  const fixList = (fixes || []).map(f => `<li style="margin:4px 0;">${f}</li>`).join("");
 
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:20px;margin:0;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1);">
<div style="background:#1A3C6E;padding:20px 28px;">
<h2 style="color:#fff;margin:0;font-size:18px;">🐛 New Bug Detected — QA Review Required</h2>
<p style="color:#90caf9;margin:6px 0 0;font-size:13px;">Hi ${name} · DemoShop AI QA Pipeline · ${new Date().toLocaleString()}</p>
</div>
<div style="padding:18px 28px 0;">
<span style="display:inline-block;background:${style.bg};color:${style.color};border:1px solid ${style.color};border-radius:4px;padding:4px 12px;font-size:13px;font-weight:bold;">${style.emoji} ${category}</span>
</div>
<div style="padding:12px 28px 0;">
<h3 style="margin:0;font-size:16px;color:#1a1a1a;">${title}</h3>

    ${testCase ? `<p style="margin:4px 0 0;font-size:12px;color:#888;">Test Case: ${testCase}</p>` : ""}
</div>
<div style="padding:16px 28px;">
<table style="width:100%;border-collapse:collapse;font-size:14px;">
<tr style="background:#f8f9fa;">
<td style="padding:8px 12px;font-weight:bold;color:#555;width:140px;border:1px solid #e0e0e0;">Expected</td>
<td style="padding:8px 12px;color:#1a1a1a;border:1px solid #e0e0e0;">${expected || "—"}</td>
</tr>
<tr>
<td style="padding:8px 12px;font-weight:bold;color:#d32f2f;border:1px solid #e0e0e0;">Actual</td>
<td style="padding:8px 12px;color:#d32f2f;border:1px solid #e0e0e0;">${actual || "—"}</td>
</tr>
<tr style="background:#f8f9fa;">
<td style="padding:8px 12px;font-weight:bold;color:#555;border:1px solid #e0e0e0;">AI Reason</td>
<td style="padding:8px 12px;color:#1a1a1a;border:1px solid #e0e0e0;">${reason || "—"}</td>
</tr>
</table>
</div>

  ${fixes && fixes.length ? `<div style="padding:0 28px 16px;"><p style="font-weight:bold;color:#555;margin:0 0 6px;font-size:14px;">✅ Suggested Fixes</p><ul style="margin:0;padding-left:20px;color:#333;font-size:14px;">${fixList}</ul></div>` : ""}

  ${jiraUrl ? `<div style="padding:0 28px 24px;"><a href="${jiraUrl}" style="display:inline-block;background:#1A3C6E;color:#fff;text-decoration:none;padding:10px 22px;border-radius:5px;font-size:14px;font-weight:bold;">🎫 View Jira Ticket</a></div>` : ""}
<div style="background:#f4f4f4;padding:12px 28px;border-top:1px solid #e0e0e0;">
<p style="margin:0;font-size:12px;color:#888;">Sent by DemoShop AI QA Pipeline · Auto-generated · Do not reply</p>
</div>
</div></body></html>`;

}
 
// ── Approval email (Accept / Decline buttons) ─────────────────────────────────

function buildApprovalEmailHtml({ title, category, expected, actual, reason, fixes, testCase, qaLeadName, approveUrl, declineUrl }) {

  const style   = CATEGORY_STYLE[category] || CATEGORY_STYLE.Frontend;

  const name    = qaLeadName || process.env.QA_LEAD_NAME || "QA Lead";

  const fixList = (fixes || []).map(f => `<li style="margin:4px 0;">${f}</li>`).join("");
 
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:20px;margin:0;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1);">
<div style="background:#1A3C6E;padding:20px 28px;">
<h2 style="color:#fff;margin:0;font-size:18px;">🐛 Bug Detected — Your Review Required</h2>
<p style="color:#90caf9;margin:6px 0 0;font-size:13px;">Hi ${name} · DemoShop AI QA Pipeline · ${new Date().toLocaleString()}</p>
</div>
<div style="padding:18px 28px 0;">
<span style="display:inline-block;background:${style.bg};color:${style.color};border:1px solid ${style.color};border-radius:4px;padding:4px 12px;font-size:13px;font-weight:bold;">${style.emoji} ${category}</span>
</div>
<div style="padding:12px 28px 0;">
<h3 style="margin:0;font-size:16px;color:#1a1a1a;">${title}</h3>

    ${testCase ? `<p style="margin:4px 0 0;font-size:12px;color:#888;">Test Case: ${testCase}</p>` : ""}
</div>
<div style="padding:16px 28px;">
<table style="width:100%;border-collapse:collapse;font-size:14px;">
<tr style="background:#f8f9fa;">
<td style="padding:8px 12px;font-weight:bold;color:#555;width:140px;border:1px solid #e0e0e0;">Expected</td>
<td style="padding:8px 12px;color:#1a1a1a;border:1px solid #e0e0e0;">${expected || "—"}</td>
</tr>
<tr>
<td style="padding:8px 12px;font-weight:bold;color:#d32f2f;border:1px solid #e0e0e0;">Actual</td>
<td style="padding:8px 12px;color:#d32f2f;border:1px solid #e0e0e0;">${actual || "—"}</td>
</tr>
<tr style="background:#f8f9fa;">
<td style="padding:8px 12px;font-weight:bold;color:#555;border:1px solid #e0e0e0;">AI Analysis</td>
<td style="padding:8px 12px;color:#1a1a1a;border:1px solid #e0e0e0;">${reason || "—"}</td>
</tr>
</table>
</div>

  ${fixes && fixes.length ? `<div style="padding:0 28px 16px;"><p style="font-weight:bold;color:#555;margin:0 0 6px;font-size:14px;">✅ Suggested Fixes</p><ul style="margin:0;padding-left:20px;color:#333;font-size:14px;">${fixList}</ul></div>` : ""}
<div style="padding:0 28px 12px;">
<p style="font-size:14px;color:#444;margin:0;font-weight:bold;">Should a Jira ticket be created for this bug?</p>
</div>
<div style="padding:0 28px 28px;">
<a href="${approveUrl}" style="display:inline-block;background:#2e7d32;color:#fff;text-decoration:none;padding:12px 28px;border-radius:5px;font-size:15px;font-weight:bold;margin-right:12px;">✅ Approve &amp; Create Jira Ticket</a>
<a href="${declineUrl}" style="display:inline-block;background:#c62828;color:#fff;text-decoration:none;padding:12px 28px;border-radius:5px;font-size:15px;font-weight:bold;">❌ Decline</a>
</div>
<div style="background:#f4f4f4;padding:12px 28px;border-top:1px solid #e0e0e0;">
<p style="margin:0;font-size:12px;color:#888;">Sent by DemoShop AI QA Pipeline · Approve to log in Jira, Decline to dismiss</p>
</div>
</div></body></html>`;

}
 
// ── Public functions ──────────────────────────────────────────────────────────

async function sendBugEmail({ title, category, expected, actual, reason, fixes, jiraUrl, testCase }) {

  const to         = process.env.QA_LEAD_EMAIL || process.env.EMAIL_TO || process.env.EMAIL_FROM;

  const qaLeadName = process.env.QA_LEAD_NAME  || "QA Lead";

  if (!to) { console.log("   ⚠️  No recipient — set QA_LEAD_EMAIL in .env"); return; }
 
  const style   = CATEGORY_STYLE[category] || CATEGORY_STYLE.Frontend;

  const subject = `${style.emoji} Bug Report — [${category}] ${title}`;

  const html    = buildEmailHtml({ title, category, expected, actual, reason, fixes, jiraUrl, testCase, qaLeadName });
 
  try {

    await transporter.sendMail({

      from:    process.env.EMAIL_FROM,

      to:      to,

      subject: subject,

      html:    html

    });

    console.log(`   📧 Bug email → ${to} ✅`);

  } catch (err) {

    console.log(`   ⚠️  Bug email failed: ${err.message}`);

  }

}
 
async function sendApprovalEmail({ title, category, expected, actual, reason, fixes, testCase, approveUrl, declineUrl }) {

  const to         = process.env.QA_LEAD_EMAIL || process.env.EMAIL_TO || process.env.EMAIL_FROM;

  const qaLeadName = process.env.QA_LEAD_NAME  || "QA Lead";

  if (!to) { console.log("   ⚠️  No recipient — set QA_LEAD_EMAIL in .env"); return; }
 
  const style   = CATEGORY_STYLE[category] || CATEGORY_STYLE.Frontend;

  const subject = `${style.emoji} [Action Required] Bug Review — [${category}] ${title}`;

  const html    = buildApprovalEmailHtml({ title, category, expected, actual, reason, fixes, testCase, qaLeadName, approveUrl, declineUrl });
 
  try {

    await transporter.sendMail({

      from:    process.env.EMAIL_FROM,

      to:      to,

      subject: subject,

      html:    html

    });

    console.log(`   📧 Approval email → ${to} ✅`);

  } catch (err) {

    console.error(`   ❌ Approval email FAILED: ${err.message}`);
    console.error(`      SMTP → host:${process.env.SMTP_HOST} port:${process.env.SMTP_PORT} from:${process.env.EMAIL_FROM} to:${to}`);

  }

}
 
async function sendTestEmail() {

  const to = process.env.QA_LEAD_EMAIL || process.env.EMAIL_TO || process.env.EMAIL_FROM;

  if (!to) return { ok: false, error: "No recipient — set QA_LEAD_EMAIL in .env" };
 
  const html = `<div style="font-family:Arial,sans-serif;padding:24px;">
<h2 style="color:#2e7d32;">✅ Email is working!</h2>
<p>DemoShop QA pipeline can send emails to <strong>${to}</strong>.</p>
<p style="color:#888;font-size:12px;">Sent at ${new Date().toLocaleString()}</p>
</div>`;
 
  try {

    await transporter.sendMail({

      from:    process.env.EMAIL_FROM,

      to:      to,

      subject: "✅ DemoShop Email Test — Working",

      html:    html

    });

    console.log(`   📧 Test email sent → ${to} ✅`);

    return { ok: true, to };

  } catch (err) {

    console.log(`   ❌ SMTP error: ${err.message}`);

    return { ok: false, error: err.message };

  }

}
 
module.exports = { sendBugEmail, sendApprovalEmail, sendTestEmail };
 