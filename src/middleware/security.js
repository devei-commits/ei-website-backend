require('dotenv').config()
const jwt = require('jsonwebtoken');
const bycrypt = require('bcrypt');
const { RefreshToken, User } = require('../users/models');
const { where } = require('sequelize');

function generateToken(user) {
    // Include role in the token payload for authorization checks
    return jwt.sign(
        { email: user.email, role: user.role || 'customer' },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '15m' }
    );
}

async function generateRefreshToken(user) {
    const refreshToken = jwt.sign({ email: user.email }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '5m' });
    const tokenRecord = await RefreshToken.findOne({ where: { email: user.email } });
    const encryptedRefreshToken = bycrypt.hashSync(refreshToken, 10);
    if (tokenRecord) {
        await RefreshToken.update({ refeshToken: encryptedRefreshToken }, { where: { email: user.email } });
    } else {
        await RefreshToken.create({ email: user.email, refreshToken: encryptedRefreshToken });
    }
    return refreshToken;
}

const isAuthenticated = async (req, res, next) => {
    try {
        const auth = req.headers['authorization'];
        if (!auth || auth.split(' ').length < 2) {
            return res.sendStatus(401);
        }
        const token = auth.split(' ')[1];
        const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

        // Attach user info to request for downstream authorization
        // Refresh role from DB to avoid relying solely on token
        const user = await User.findOne({ where: { email: decoded.email } });
        if (!user) {
            return res.sendStatus(401);
        }
        req.user = {
            id: user.id,
            email: user.email,
            role: user.role
        };
        next();
    } catch (err) {
        return res.sendStatus(403);
    }
};

// Role-based authorization middleware
const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.sendStatus(403);
        }
        next();
    };
};

// Verify refresh token
function verifyRefreshToken(token) {
    try {
        return jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
    } catch (error) {
        return null;
    }
}
const token = async (req, res) => {
    if (!req.cookies || !req.cookies.refreshToken || req.cookies.refeshToken === '{}') {
        return res.sendStatus(401);
    }
    const decodedToken = verifyRefreshToken(req.cookies.refreshToken);
    if (!decodedToken) {
        return res.sendStatus(403);
    }
    const refeshTokenObject = await RefreshToken.findOne({ where: { email: decodedToken.email } });

    if (!refeshTokenObject || !bycrypt.compare(req.cookies.refreshToken, refeshTokenObject.refreshToken)) {
        return res.sendStatus(403);
    }
    const user = { email: refeshTokenObject.email };
    const refreshToken = await generateRefreshToken(user);
    res.cookie('refreshToken', refreshToken, { httpOnly: true });
    res.status(200).json({ token: generateToken(user) });
};

const deleteToken = async (req, res) => {
    if (req.cookies && req.cookies.refreshToken) {
        const decodedToken = verifyRefreshToken(req.cookies.refreshToken);
        if (decodedToken) {
            await RefreshToken.destroy({ where: { email: decodedToken.email } })
        }
    }
    res.clearCookie('refreshToken', { path: '/' });
    res.sendStatus(200);
}


module.exports = {
    isAuthenticated,
    generateToken,
    generateRefreshToken,
    token,
    deleteToken,
    authorizeRoles
}
