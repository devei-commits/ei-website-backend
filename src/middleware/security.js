require('dotenv').config()
const jwt = require('jsonwebtoken');
const bycrypt = require('bcrypt');
const { accessSigningSecret, refreshSigningSecret, useCompositeAccess, useCompositeRefresh } = require('../lib/jwtSecrets');
const { RefreshToken, User } = require('../users/models');
const { StaffProfile, Role, Permission, RolePermission } = require('../models/index');

/** Module IDs that match frontend sidebar. '*' = all modules. */
const ALL_MODULE_IDS = ['dashboard', 'user-management', 'role-management', 'order-management', 'coupon-management', 'discount-management', 'packaging-management', 'raw-materials-management', 'items-master', 'vendor-client', 'sales-purchase', 'universal-swap', 'item-groups'];
const ADMIN_MODULE_IDS = [...ALL_MODULE_IDS];

const USERTYPE_ALLOWED_MODULES = {
  super_admin: ['*'],
  admin: ADMIN_MODULE_IDS,
  bd_manager: ['dashboard', 'user-management', 'order-list', 'order-management', 'coupon-management', 'discount-management', 'packaging-management', 'raw-materials-management', 'items-master', 'sales-purchase', 'universal-swap', 'item-groups', 'enquiry-management'],
  accounts_team: ['dashboard', 'vendor-client'],
  doctor: ['dashboard'],
  customer: [],
};

function getAllowedModules(usertype) {
  return USERTYPE_ALLOWED_MODULES[usertype] || [];
}

/** JSON error body — avoids bare `sendStatus` "Forbidden" on the admin UI. */
function sendError(res, status, { code, message }) {
  return res.status(status).json({ error: message, message, code });
}

function sendSessionExpired(res) {
  return sendError(res, 401, {
    code: 'SESSION_EXPIRED',
    message: 'Session expired. Please log in again.',
  });
}

function sendUnauthorized(res) {
  return sendError(res, 401, {
    code: 'UNAUTHORIZED',
    message: 'Please log in to continue.',
  });
}

function sendForbidden(res) {
  return sendError(res, 403, {
    code: 'FORBIDDEN',
    message: 'You do not have permission to perform this action.',
  });
}

function isJwtExpiredError(err) {
  return err && (err.name === 'TokenExpiredError' || err.message === 'jwt expired');
}

/** Middleware: require one of the given module IDs. Use after isAuthenticated. req.user.allowedModules set in isAuthenticated. */
function requireModule(...moduleIds) {
  return (req, res, next) => {
    if (!req.user) return sendUnauthorized(res);
    const allowed = req.user.allowedModules || [];
    if (allowed.includes('*')) return next();
    const hasAccess = moduleIds.some(m => allowed.includes(m));
    if (!hasAccess) return sendForbidden(res);
    next();
  };
}

function generateToken(user) {
    const userId = user.userid ?? user.user_id;
    if (userId == null) {
        throw new Error('generateToken requires user.userid');
    }
    const email = user.email != null ? String(user.email).trim().toLowerCase() : undefined;
    return jwt.sign(
        {
            email,
            role: user.usertype || 'customer',
            sub: userId,
            id: userId,
        },
        accessSigningSecret(userId),
        { expiresIn: '7d' }
    );
}

async function generateRefreshToken(user) {
    let u = user;
    if (u.userid == null && u.email) {
        u = await User.findOne({
            where: { email: String(u.email).trim().toLowerCase() },
            attributes: ['userid', 'email'],
        });
        if (!u) throw new Error('User not found for refresh token');
    } else if (u.userid != null && (u.email == null || String(u.email).trim() === '')) {
        u = await User.findByPk(u.userid, { attributes: ['userid', 'email'] });
        if (!u) throw new Error('User not found for refresh token');
    }
    const userId = u.userid;
    const email = u.email != null ? String(u.email).trim().toLowerCase() : undefined;
    if (!email) throw new Error('generateRefreshToken requires user email');
    const refreshToken = jwt.sign(
        { email, sub: userId },
        refreshSigningSecret(userId),
        { expiresIn: '5m' }
    );
    const tokenRecord = await RefreshToken.findOne({ where: { email } });
    const encryptedRefreshToken = bycrypt.hashSync(refreshToken, 10);
    if (tokenRecord) {
        await RefreshToken.update({ refeshToken: encryptedRefreshToken }, { where: { email } });
    } else {
        await RefreshToken.create({ email, refreshToken: encryptedRefreshToken });
    }
    return refreshToken;
}

const isAuthenticated = async (req, res, next) => {
    try {
        const auth = req.headers['authorization'];
        if (!auth || auth.split(' ').length < 2) {
            return sendUnauthorized(res);
        }
        const token = auth.split(' ')[1];
        const unverified = jwt.decode(token, { complete: false });
        if (!unverified || typeof unverified !== 'object') {
            return sendUnauthorized(res);
        }
        const tokenUserId = unverified.sub != null ? unverified.sub : unverified.id;
        let decoded;
        try {
            if (useCompositeAccess()) {
                if (tokenUserId == null) return sendUnauthorized(res);
                decoded = jwt.verify(token, accessSigningSecret(tokenUserId));
            } else {
                decoded = jwt.verify(token, accessSigningSecret());
            }
        } catch (err) {
            if (isJwtExpiredError(err)) return sendSessionExpired(res);
            return sendUnauthorized(res);
        }

        // Attach user info to request for downstream authorization
        // Refresh role from DB to avoid relying solely on token
        let user = null;
        if (decoded.sub != null || decoded.id != null) {
            const uid = decoded.sub != null ? decoded.sub : decoded.id;
            user = await User.findByPk(uid);
        }
        if (!user && decoded.email) {
            user = await User.findOne({ where: { email: String(decoded.email).trim().toLowerCase() } });
        }
        if (!user) {
            return sendUnauthorized(res);
        }
        req.user = {
            id: user.userid,
            email: user.email,
            fullName: [user.fname, user.lname].filter(Boolean).join(' ') || user.display_name || user.email,
            role: user.usertype,
            doctorIdLegacy: user.doctor_id_legacy,
            allowedModules: getAllowedModules(user.usertype)
        };
        // For staff (admin dashboard RBAC): attach roleId, roleName, roleLevel.
        // Prefer role_code mapped from users.usertype (seed/source-of-truth),
        // then fall back to staff_profiles.role_id if needed.
        const roleByCode = user.usertype
            ? await Role.findOne({
                where: { role_code: String(user.usertype).trim().toLowerCase() },
                attributes: ['role_id', 'role_name', 'level'],
            }).catch(() => null)
            : null;
        const staffProfile = await StaffProfile.findOne({
            where: { user_id: user.userid },
            include: [{ model: Role, as: 'role', attributes: ['role_id', 'role_name', 'level'] }]
        });
        if (roleByCode) {
            req.user.roleId = roleByCode.role_id;
            req.user.roleName = roleByCode.role_name;
            req.user.roleLevel = roleByCode.level;
            req.user.department = staffProfile?.department;
        } else if (staffProfile && staffProfile.role) {
            req.user.roleId = staffProfile.role.role_id;
            req.user.roleName = staffProfile.role.role_name;
            req.user.roleLevel = staffProfile.role.level;
            req.user.department = staffProfile.department;
        }
        next();
    } catch (err) {
        if (isJwtExpiredError(err)) return sendSessionExpired(res);
        return sendUnauthorized(res);
    }
};

// Role-based authorization middleware
const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return sendForbidden(res);
        }
        next();
    };
};

function isPrivilegedRole(reqUser) {
    if (!reqUser) return false;
    return (
        reqUser.role === 'super_admin' ||
        reqUser.role === 'admin' ||
        reqUser.roleName === 'Super Admin' ||
        reqUser.roleName === 'Admin'
    );
}

function toGrantedKey(permission) {
    const resource = permission && permission.resource ? String(permission.resource).trim() : '';
    const action = permission && permission.action ? String(permission.action).trim().toLowerCase() : '';
    if (!resource || !action) return '';
    if (action === 'view' && resource.includes('.action.')) return resource;
    if (resource.includes('.column.')) return `${resource}.${action}`;
    return `${resource}.action.${action}`;
}

function normalizePermissionForStorage(resource, action) {
    const safeResource = String(resource || '').trim();
    const safeAction = String(action || '').trim().toLowerCase();
    if (!safeResource || !safeAction) return null;
    if (['view', 'create', 'edit', 'delete'].includes(safeAction)) {
        return { resource: safeResource, action: safeAction };
    }
    return { resource: `${safeResource}.action.${safeAction}`, action: 'view' };
}

async function ensurePermissionContext(req) {
    if (!req.user) return { granted: new Set(), byResource: new Map() };
    if (req.user._permissionContext) return req.user._permissionContext;
    const empty = { granted: new Set(), byResource: new Map() };
    if (!req.user.roleId) {
        req.user._permissionContext = empty;
        return empty;
    }
    try {
        const roleWithPerms = await Role.findByPk(req.user.roleId, {
            include: [{ model: Permission, attributes: ['resource', 'action'] }],
        });
        const rows = roleWithPerms && Array.isArray(roleWithPerms.Permissions) ? roleWithPerms.Permissions : [];
        const granted = new Set();
        const byResource = new Map();
        for (const perm of rows) {
            if (!perm) continue;
            const key = toGrantedKey(perm);
            if (!key) continue;
            granted.add(key);
            const resource = String(perm.resource || '').trim();
            const action = String(perm.action || '').trim().toLowerCase();
            if (!resource || !action) continue;
            if (!byResource.has(resource)) byResource.set(resource, new Set());
            byResource.get(resource).add(action);
        }
        const ctx = { granted, byResource };
        req.user._permissionContext = ctx;
        return ctx;
    } catch {
        req.user._permissionContext = empty;
        return empty;
    }
}

function getResourceCandidates(resource) {
    const base = String(resource || '').trim();
    if (!base) return [];
    const parts = base.split('.');
    const out = [];
    for (let i = parts.length; i >= 1; i -= 1) {
        out.push(parts.slice(0, i).join('.'));
    }
    return out;
}

async function hasGranularAccess(req, resource, action = 'view') {
    if (!req.user) return false;
    if (isPrivilegedRole(req.user)) return true;
    const wantedAction = String(action || 'view').trim().toLowerCase();
    const normalized = normalizePermissionForStorage(resource, wantedAction);
    if (!normalized) return false;
    const { granted, byResource } = await ensurePermissionContext(req);
    const candidates = getResourceCandidates(normalized.resource);
    for (const candidate of candidates) {
        const wanted = normalizePermissionForStorage(candidate, wantedAction);
        if (wanted) {
            const wantedKey = toGrantedKey(wanted);
            if (wantedKey && granted.has(wantedKey)) return true;
        }
        const actions = byResource.get(candidate);
        if (actions && actions.has(wantedAction)) return true;
    }
    return false;
}

const requireAnyGranularAccess = (requirements = []) => {
    const reqs = Array.isArray(requirements) ? requirements : [];
    return async (req, res, next) => {
        if (!req.user) return sendUnauthorized(res);
        if (isPrivilegedRole(req.user)) return next();
        if (reqs.length === 0) return sendForbidden(res);
        try {
            for (const rule of reqs) {
                const resource = rule && rule.resource ? String(rule.resource) : '';
                const action = rule && rule.action ? String(rule.action) : 'view';
                const ok = await hasGranularAccess(req, resource, action);
                if (ok) return next();
            }
            return sendForbidden(res);
        } catch {
            return res.sendStatus(500);
        }
    };
};

/**
 * Optional RBAC: require (resource, action) from role_permissions + permissions.
 * Call after isAuthenticated. Super_admin/admin (by usertype or roleName) bypass.
 * Otherwise checks Permission(resource, action) linked to user's role via RolePermission.
 */
const requirePermission = (resource, action) => {
    return async (req, res, next) => {
        if (!req.user) return sendUnauthorized(res);
        if (req.user.role === 'super_admin' || req.user.role === 'admin' || req.user.roleName === 'Super Admin' || req.user.roleName === 'Admin') {
            return next();
        }
        if (!req.user.roleId) return sendForbidden(res);
        try {
            const perm = await Permission.findOne({ where: { resource, action } });
            if (!perm) return sendForbidden(res);
            const has = await RolePermission.findOne({
                where: { role_id: req.user.roleId, permission_id: perm.permission_id }
            });
            if (!has) return sendForbidden(res);
            next();
        } catch (err) {
            return res.sendStatus(500);
        }
    };
};

// Verify refresh token
function verifyRefreshToken(token) {
    try {
        const payload = jwt.decode(token, { complete: false });
        if (!payload || typeof payload !== 'object') return null;
        const uid = payload.sub != null ? payload.sub : payload.id;
        if (useCompositeRefresh()) {
            if (uid == null) return null;
            return jwt.verify(token, refreshSigningSecret(uid));
        }
        return jwt.verify(token, refreshSigningSecret());
    } catch (error) {
        return null;
    }
}
const token = async (req, res) => {
    if (!req.cookies || !req.cookies.refreshToken || req.cookies.refeshToken === '{}') {
        return sendUnauthorized(res);
    }
    const decodedToken = verifyRefreshToken(req.cookies.refreshToken);
    if (!decodedToken) {
        return sendSessionExpired(res);
    }
    const refeshTokenObject = await RefreshToken.findOne({ where: { email: decodedToken.email } });

    if (!refeshTokenObject || !bycrypt.compare(req.cookies.refreshToken, refeshTokenObject.refreshToken)) {
        return sendSessionExpired(res);
    }
    const user = await User.findOne({
        where: { email: String(decodedToken.email).trim().toLowerCase() },
        attributes: ['userid', 'email', 'usertype'],
    });
    if (!user) return sendSessionExpired(res);
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
    hasGranularAccess,
    requireAnyGranularAccess,
    requirePermission,
}
