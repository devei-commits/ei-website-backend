const { User, DoctorProfile, RefreshToken } = require("../users/models");
const Address = require("./Addresses");
const Role = require("./Role");
const Permission = require("./Permission");
const RolePermission = require("./RolePermission");
const ModuleDefinition = require("./ModuleDefinition");

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

Role.belongsToMany(Permission, { through: RolePermission, foreignKey: "role_id", otherKey: "permission_id" });
Permission.belongsToMany(Role, { through: RolePermission, foreignKey: "permission_id", otherKey: "role_id" });

module.exports = {
  User,
  Address,
  DoctorProfile,
  RefreshToken,
  Role,
  Permission,
  RolePermission,
  ModuleDefinition,
};
