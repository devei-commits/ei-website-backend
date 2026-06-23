const {
  evaluatePrFacilityLicenceForMuZone,
  flattenPrFacilityLicencesForStorage,
  hydratePrFacilityLicencesFromBom,
} = require('../../src/products/prFacilityLicenceStorage');

describe('prFacilityLicenceStorage', () => {
  const activeMl1 = {
    facilityCode: 'ML1',
    facilityLabel: 'Hyderabad ML1 · Plot 24',
    applicable: 'yes',
    licenceStatus: 'active',
    licenceType: 'Cosmetics Mfg Licence (Form COS-1)',
    licenceNumber: 'TS-COS-2023-00214',
    issuedOn: '2023-04-10',
    validTill: '2028-04-09',
    remarks: 'Notes',
  };

  it('hydrates from BOM plain object', () => {
    const rows = hydratePrFacilityLicencesFromBom({ pr_facility_licences: [activeMl1] });
    expect(rows[0].licenceNumber).toBe('TS-COS-2023-00214');
    expect(rows[1].facilityCode).toBe('ML2');
  });

  it('evaluates MU zone gate for ML2', () => {
    const ok = evaluatePrFacilityLicenceForMuZone(
      [
        { ...activeMl1, applicable: 'no' },
        { ...activeMl1, facilityCode: 'ML2', applicable: 'yes' },
      ],
      'LOC-ML2'
    );
    expect(ok.ok).toBe(true);
  });

  it('serializes non-empty records only', () => {
    const stored = flattenPrFacilityLicencesForStorage([
      activeMl1,
      { facilityCode: 'ML2', facilityLabel: 'ML2', applicable: '', licenceStatus: '', licenceType: '', licenceNumber: '', issuedOn: '', validTill: '', remarks: '' },
    ]);
    expect(stored).toHaveLength(1);
  });
});
