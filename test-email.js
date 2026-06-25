// test-email.js — Run once to verify email is working
// Usage: node test-email.js
require("dotenv").config();
const nodemailer = require("nodemailer");

const user = process.env.SMTP_USER || process.env.EMAIL_FROM;
const pass = process.env.SMTP_PASS || process.env.EMAIL_APP_PASSWORD;
const to   = process.env.QA_LEAD_EMAIL || process.env.EMAIL_TO || process.env.EMAIL_FROM;

console.log("\n📧 Email Test");
console.log("─".repeat(40));
console.log(`   From    : ${user}`);
console.log(`   To      : ${to}`);
console.log(`   Password: ${pass ? pass.slice(0,4) + "****" + pass.slice(-2) : "❌ NOT SET"}`);
console.log("─".repeat(40));

if (!pass || pass === "your_gmail_app_password_here") {
  console.log("❌ EMAIL_APP_PASSWORD not set in .env");
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { user, pass },
  tls: { rejectUnauthorized: false },
  connectionTimeout: 15000,
  greetingTimeout:   10000,
  socketTimeout:     15000,
  family: 4           // force IPv4 — prevents ENETUNREACH on IPv6-disabled networks
});

transporter.sendMail({
  from: `"DemoShop QA Bot" <${user}>`,
  to,
  subject: "✅ DemoShop QA Pipeline — Email Test",
  html: `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
      <div style="background:#1A3C6E;padding:20px 28px">
        <h2 style="color:#fff;margin:0;font-size:18px">✅ Email is Working!</h2>
        <p style="color:#90caf9;margin:6px 0 0;font-size:13px">DemoShop AI QA Pipeline · ${new Date().toLocaleString()}</p>
      </div>
      <div style="padding:24px 28px">
        <p style="color:#333;font-size:15px">Your email notifications are configured correctly.</p>
        <p style="color:#555;font-size:13px;margin-top:12px">
          From now on, every new Jira bug ticket will also send an email to <strong>${to}</strong>
          with the bug details, AI analysis, and suggested fixes.
        </p>
      </div>
      <div style="background:#f4f4f4;padding:12px 28px;border-top:1px solid #e0e0e0">
        <p style="margin:0;font-size:12px;color:#888">Sent by DemoShop AI QA Pipeline · Auto-generated</p>
      </div>
    </div>`
}, (err, info) => {
  if (err) {
    console.log(`\n❌ Email FAILED: ${err.message}`);
    if (err.message.includes("535") || err.message.includes("Username and Password")) {
      console.log("\n💡 Fix: Your Gmail App Password might be wrong.");
      console.log("   Go to: https://myaccount.google.com/apppasswords");
      console.log("   Generate a new password and update EMAIL_APP_PASSWORD in .env");
    }
    if (err.message.includes("ECONNREFUSED") || err.message.includes("ETIMEDOUT")) {
      console.log("\n💡 Fix: Corporate proxy might be blocking SMTP port 587.");
      console.log("   Try port 465 by adding SMTP_PORT=465 to .env");
    }
  } else {
    console.log(`\n✅ Email sent successfully!`);
    console.log(`   Message ID : ${info.messageId}`);
    console.log(`   Check inbox: ${to}`);
  }
  console.log("");
});
