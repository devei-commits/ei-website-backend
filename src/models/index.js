const {User, DoctorProfile, RefreshToken} = require("../users/models");
const Address = require("./Addresses");

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

module.exports = {
  User,
  Address,
  DoctorProfile,
  RefreshToken,
};
