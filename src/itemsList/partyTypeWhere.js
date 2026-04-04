const { Op } = require('sequelize');

/** RM/PM price-list rows: vendor procurement rates (legacy rows may have null party_type). */
function vendorRatesPartyWhere() {
  return { [Op.or]: [{ party_type: 'vendor' }, { party_type: null }] };
}

/** PR product price lists: customer-specific rates (vendor_id = vendor_clients.id where type=client). */
function clientRatesPartyWhere() {
  return { party_type: 'client' };
}

function partyWhereForItemsListRowType(listType) {
  if (listType === 'PR') return clientRatesPartyWhere();
  return vendorRatesPartyWhere();
}

module.exports = {
  vendorRatesPartyWhere,
  clientRatesPartyWhere,
  partyWhereForItemsListRowType,
};
