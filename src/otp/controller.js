const { generateRefreshToken, generateToken } = require('../middleware/security');
const Authentication = require('./models');
const {User} = require('../models/index');
const sendmail = require('../utils/mail');

const generateOtp = async (args) => {
  try {
    const { phone, email } = args;

    const user = email
      ? await User.findOne({ where: { email } })
      : await User.findOne({ where: { mobile: phone } });

    if (!user) {
      return { error: 'User not found' };
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const created = new Date();
    const expired = new Date(created.getTime() + 5 * 60 * 1000);

    await Authentication.create({
      user_id: user.userid,
      phone: user.mobile || '',
      otp,
      created,
      expired
    });

    // TODO: send SMS when phone present; email otherwise
    await sendmail(user.email, otp);

    return {
      status: 'OTP_SENT',
      otp // remove in production
    };
  } catch (err) {
    return { error: err.message };
  }
};


const verifyOtp = async (req, res) => {
  try {
    const { userid, otp } = req.body;

    const record = await Authentication.findOne({
      where: { user_id: userid},
      order: [['created', 'DESC']]
    });

    if (!record) {
      return res.status(404).json({ error: 'OTP not found' });
    }

    if (record.otp != otp) {
      return res.status(400).json({ error: 'Invalid OTP or expired' });
    }

    if (new Date() > record.expired) {
      return res.status(400).json({ error: 'Invalid OTP or expired' });
    }

    const user = await User.findByPk(record.user_id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // create JWT
    const refreshToken = await generateRefreshToken(user);
    res.cookie('refreshToken', refreshToken, { httpOnly: true });
    res.status(200).json({ token: generateToken(user) });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};


module.exports = { generateOtp, verifyOtp };