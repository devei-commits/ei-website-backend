const { MailtrapClient } = require("mailtrap");

const TOKEN = process.env.MAIL_TOKEN;
const SENDER = process.env.SENDER_MAIL;
const sendmail = (email,otp ) => {
    const client = new MailtrapClient({
      token: TOKEN,
    });
    
    const sender = {
      email: SENDER,
      name: "Esthetic Insights",
    };
    const recipients = [
      {
        email: email,
      }
    ];
    
    client
      .send({
        from: sender,
        to: recipients,
        subject: "You are awesome!",
        text: `Congrats for sending test email with Mailtrap! your otp is ${otp}`,
        category: "Integration Test",
      })
      .then(console.log, console.error).catch(err => console.log(err)); 
}

module.exports = sendmail;