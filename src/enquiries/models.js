const { DataTypes, Model } = require('sequelize');
const db = require('../../db');
const { User } = require('../users/models');

class Enquiry extends Model {}

Enquiry.init(
  {
    enquiry_id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    ticket_number: {
      type: DataTypes.STRING(32),
      allowNull: true,
      unique: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: User, key: 'userid' },
    },
    // Customer snapshot (required for ticket; from logged-in user or submitted for guest)
    customer: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '{ id?, name, email, phone?, company?, isRegistered }',
    },
    subject: { type: DataTypes.STRING(500), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    category: { type: DataTypes.STRING(80), allowNull: true },
    priority: { type: DataTypes.STRING(40), allowNull: true, defaultValue: 'medium' },
    status: { type: DataTypes.STRING(40), allowNull: true, defaultValue: 'new' },
    source: { type: DataTypes.STRING(40), allowNull: true },
    tags: { type: DataTypes.JSON, allowNull: true },
    current_assignee: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '{ staffId, staffName, staffEmail, department, assignedAt, assignedBy, isActive }',
    },
    assignment_history: { type: DataTypes.JSON, allowNull: true },
    linked_orders: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '[{ orderId, orderNumber, orderDate, orderStatus, orderTotal, productName, linkedAt, linkedBy, relevance }]',
    },
    messages: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '[{ id, ticketId, senderId, senderName, senderType, content, sentAt, isInternal }]',
    },
    activities: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: '[{ id, ticketId, type, description, performedBy, timestamp, previousValue?, newValue? }]',
    },
    first_response_at: { type: DataTypes.DATE, allowNull: true },
    sla_deadline: { type: DataTypes.DATE, allowNull: true },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    resolution_notes: { type: DataTypes.TEXT, allowNull: true },
    response_count: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    // Legacy compatibility
    enquiry_type: { type: DataTypes.STRING, allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
  },
  {
    sequelize: db,
    modelName: 'Enquiry',
    tableName: 'enquiries',
    timestamps: false,
  }
);

Enquiry.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(Enquiry, { foreignKey: 'user_id', as: 'enquiries' });

module.exports = Enquiry;
