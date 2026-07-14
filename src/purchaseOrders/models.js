/**
 * Purchase Orders — schema aligned with Create New Purchase Order form.
 */
const { DataTypes, Model } = require('sequelize');
const db = require('../../db');

class PurchaseOrder extends Model { }

PurchaseOrder.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    order_id: { type: DataTypes.STRING(100), allowNull: false },
    vendor_name: { type: DataTypes.STRING(300), allowNull: true },
    branch: { type: DataTypes.STRING(100), allowNull: true },
    order_date: { type: DataTypes.DATEONLY, allowNull: true },
    expected_shipment_date: { type: DataTypes.DATEONLY, allowNull: true },
    reference: { type: DataTypes.STRING(200), allowNull: true },
    payment_terms: { type: DataTypes.STRING(100), allowNull: true },
    status: { type: DataTypes.STRING(50), allowNull: true },
    order_status: { type: DataTypes.JSON, allowNull: true },
    form_data: { type: DataTypes.JSON, allowNull: true },
    items: { type: DataTypes.JSON, allowNull: true },
    /** PO type (Flowchart §5 types): regular | blanket | spot | consignment | sample */
    po_type: { type: DataTypes.STRING(30), allowNull: true, defaultValue: 'regular' },
    /**
     * Approval workflow stage (Flowchart Sub-flow E). Distinct from `status`
     * (Draft/Released) so the existing release/GRN sync is untouched.
     * null | under_review | under_approval | approved | changes_requested | rejected
     */
    approval_status: { type: DataTypes.STRING(40), allowNull: true },
    /** Abstract role that must give final approval: proc_head | cfo (from matrix). */
    approval_required_role: { type: DataTypes.STRING(30), allowNull: true },
    /** GST-inclusive amount snapshot used to route approval. */
    approval_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    submitted_for_review_at: { type: DataTypes.DATE, allowNull: true },
    approved_at: { type: DataTypes.DATE, allowNull: true },
    /**
     * Lifecycle exception axis (Flowchart exception paths): null | on_hold | cancelled.
     * Separate from `status`/`approval_status` so hold/cancel don't clobber workflow state.
     */
    exception_status: { type: DataTypes.STRING(20), allowNull: true },
    exception_reason: { type: DataTypes.STRING(1000), allowNull: true },
    exception_at: { type: DataTypes.DATE, allowNull: true },
    exception_by: { type: DataTypes.STRING(200), allowNull: true },
    /** Incremented each time the PO is amended (ACK → Draft amendment → re-approve). */
    amendment_count: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    /** Short-supply: partial receipt accepted as final; balance reopened on the PR. */
    short_closed_at: { type: DataTypes.DATE, allowNull: true },
    short_close_note: { type: DataTypes.STRING(500), allowNull: true },
    /** QC-fail RTV (return to vendor): null | raised | resolved. Blocks payment/close while raised. */
    rtv_status: { type: DataTypes.STRING(20), allowNull: true },
    rtv_reason: { type: DataTypes.STRING(1000), allowNull: true },
    rtv_debit_note_ref: { type: DataTypes.STRING(120), allowNull: true },
    rtv_at: { type: DataTypes.DATE, allowNull: true },
    /** Zoho Books purchaseorder_id after POST /purchaseorders */
    zoho_purchase_order_id: { type: DataTypes.STRING(100), allowNull: true },
    /** Zoho Books bill_id after POST /bills (vendor purchase invoice) */
    zoho_bill_id: { type: DataTypes.STRING(100), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    lifecycle_status: { type: DataTypes.STRING(255), allowNull: true, defaultValue: 'active' },
  },
  {
    sequelize: db,
    modelName: 'PurchaseOrder',
    tableName: 'purchase_orders',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = PurchaseOrder;
