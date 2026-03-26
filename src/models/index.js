const { User, DoctorProfile, RefreshToken } = require("../users/models");
const Address = require("./Addresses");
const Role = require("./Role");
const Permission = require("./Permission");
const RolePermission = require("./RolePermission");
const ModuleDefinition = require("./ModuleDefinition");
const { StaffProfile } = require("../roles/models");

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

// StaffProfile (from roles/models) used by isAuthenticated for /me and admin RBAC
StaffProfile.belongsTo(Role, { foreignKey: "role_id", as: "role" });

// VendorClient account_manager FK + Client Hub sub-entity associations
const VendorClient = require("../vendorClient/models");
VendorClient.belongsTo(User, { foreignKey: "account_manager_id", targetKey: "userid", as: "accountManager" });
VendorClient.belongsTo(User, { foreignKey: "user_id", targetKey: "userid", as: "linkedUser" });
User.hasOne(VendorClient, { foreignKey: "user_id", sourceKey: "userid", as: "linkedVendorClient" });
require("../clientHub/models");

module.exports = {
  User,
  Address,
  DoctorProfile,
  RefreshToken,
  Role,
  Permission,
  RolePermission,
  ModuleDefinition,
  StaffProfile,
  VendorClient,
};
