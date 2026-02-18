const { MailtrapClient } = require("mailtrap");

const TOKEN = process.env.MAIL_TOKEN;
const SENDER = process.env.SENDER_MAIL || "noreply@example.com";

const sendmail = async (email, otp) => {
  if (!TOKEN || !email) {
    console.warn("[mail] MAIL_TOKEN or recipient missing; skipping send. OTP (dev):", otp);
    return;
  }
  const client = new MailtrapClient({ token: TOKEN });
  const sender = { email: SENDER, name: "Esthetic Insights" };
  const recipients = [{ email }];
  try {
    await client.send({
      from: sender,
      to: recipients,
      subject: "You are awesome!",
      text: `Congrats for sending test email with Mailtrap! your otp is ${otp}`,
      category: "Integration Test",
    });
  } catch (err) {
    console.error("[mail] Mailtrap send failed (OTP still valid):", err.message || err);
  }
};

module.exports = sendmail;