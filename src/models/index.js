const { User, DoctorProfile, RefreshToken } = require("../users/models");
const Address = require("./Addresses");
const { Role, StaffProfile, Permission, RolePermission } = require("../roles/models");

// associations
User.hasMany(Address, {
  foreignKey: "user_id",
  sourceKey: "userid",
  as: "addresses",
});

Address.belongsTo(User, {
  foreignKey: "user_id",
  targetKey: "userid",
  as: "user",
});

User.hasOne(DoctorProfile, {
  foreignKey: "user_id",
  sourceKey: "userid",
  as: "doctorProfile",
});

DoctorProfile.belongsTo(User, {
  foreignKey: "user_id",
  targetKey: "userid",
  as: "user",
});

User.hasOne(StaffProfile, {
  foreignKey: "user_id",
  sourceKey: "userid",
  as: "staffProfile",
});

StaffProfile.belongsTo(User, {
  foreignKey: "user_id",
  targetKey: "userid",
  as: "user",
});

StaffProfile.belongsTo(Role, {
  foreignKey: "role_id",
  as: "role",
});

Role.hasMany(StaffProfile, {
  foreignKey: "role_id",
  as: "staffProfiles",
});

Role.belongsToMany(Permission, {
  through: RolePermission,
  foreignKey: "role_id",
  otherKey: "permission_id",
  as: "permissions",
});

Permission.belongsToMany(Role, {
  through: RolePermission,
  foreignKey: "permission_id",
  otherKey: "role_id",
  as: "roles",
});

module.exports = {
  User,
  Address,
  DoctorProfile,
  RefreshToken,
  Role,
  StaffProfile,
  Permission,
  RolePermission,
};
