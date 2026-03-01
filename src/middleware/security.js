require('dotenv').config()
const jwt = require('jsonwebtoken');
const bycrypt = require('bcrypt');
const { RefreshToken, User } = require('../users/models');
const { StaffProfile, Role, Permission, RolePermission } = require('../models/index');

/** Module IDs that match frontend sidebar. '*' = all modules. */
const USERTYPE_ALLOWED_MODULES = {
  super_admin: ['*'],
  admin: ['*'],
  bd_manager: ['dashboard', 'user-management', 'order-list', 'order-management', 'coupon-management', 'discount-management', 'packaging-management'],
  doctor: ['dashboard'],
  customer: [],
};

function getAllowedModules(usertype) {
  return USERTYPE_ALLOWED_MODULES[usertype] || [];
}

/** Middleware: require one of the given module IDs. Use after isAuthenticated. req.user.allowedModules set in isAuthenticated. */
function requireModule(...moduleIds) {
  return (req, res, next) => {
    if (!req.user) return res.sendStatus(401);
    const allowed = req.user.allowedModules || [];
    if (allowed.includes('*')) return next();
    const hasAccess = moduleIds.some(m => allowed.includes(m));
    if (!hasAccess) return res.sendStatus(403);
    next();
  };
}

function generateToken(user) {
    // Include role in the token payload for authorization checks
    return jwt.sign(
        { email: user.email, role: user.usertype || 'customer' },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '7d' }
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
            id: user.userid,
            email: user.email,
            role: user.usertype,
            allowedModules: getAllowedModules(user.usertype)
        };
        // For staff (admin dashboard RBAC): attach roleId, roleName, roleLevel from staff_profiles + roles
        const staffProfile = await StaffProfile.findOne({
            where: { user_id: user.userid },
            include: [{ model: Role, as: 'role', attributes: ['role_id', 'role_name', 'level'] }]
        });
        if (staffProfile && staffProfile.role) {
            req.user.roleId = staffProfile.role.role_id;
            req.user.roleName = staffProfile.role.role_name;
            req.user.roleLevel = staffProfile.role.level;
            req.user.department = staffProfile.department;
        }
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

/**
 * Optional RBAC: require (resource, action) from role_permissions + permissions.
 * Call after isAuthenticated. Super_admin/admin (by usertype or roleName) bypass.
 * Otherwise checks Permission(resource, action) linked to user's role via RolePermission.
 */
const requirePermission = (resource, action) => {
    return async (req, res, next) => {
        if (!req.user) return res.sendStatus(403);
        if (req.user.role === 'super_admin' || req.user.role === 'admin' || req.user.roleName === 'Super Admin' || req.user.roleName === 'Admin') {
            return next();
        }
        if (!req.user.roleId) return res.sendStatus(403);
        try {
            const perm = await Permission.findOne({ where: { resource, action } });
            if (!perm) return res.sendStatus(403);
            const has = await RolePermission.findOne({
                where: { role_id: req.user.roleId, permission_id: perm.permission_id }
            });
            if (!has) return res.sendStatus(403);
            next();
        } catch (err) {
            return res.sendStatus(500);
        }
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
    authorizeRoles,
    requireModule,
    getAllowedModules,
}
