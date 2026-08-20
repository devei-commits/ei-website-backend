/**
 * A material is usually covered by several POs, each with its own connecting (expected arrival)
 * date — "Aqua: PO-1 on 10 Aug, PO-3 on 14 Aug". Both dates have to survive to Items Involved, so
 * they are kept per PO rather than collapsed into one.
 */
const {
  buildConnectingDatesByMaterialKey,
  connectingDatesOnPo,
} = require('../../src/lib/poConnectingDates');

const po = (order_id, connectingDateByItem, items, extra = {}) => ({
  order_id, items, form_data: { connectingDateByItem }, ...extra,
});

describe('connectingDatesOnPo', () => {
  it('reads and normalises the stored map', () => {
    expect(connectingDatesOnPo(po('PO-1', { ' AQUA ': '2026-08-10' }, [])))
      .toEqual([{ key: 'aqua', date: '2026-08-10' }]);
  });

  it('returns nothing for a PO that declares none', () => {
    expect(connectingDatesOnPo({ form_data: {} })).toEqual([]);
    expect(connectingDatesOnPo({ form_data: { connectingDateByItem: [] } })).toEqual([]);
    expect(connectingDatesOnPo(null)).toEqual([]);
  });

  it('skips blank dates instead of emitting empty entries', () => {
    expect(connectingDatesOnPo(po('PO-1', { aqua: '  ' }, []))).toEqual([]);
  });
});

describe('buildConnectingDatesByMaterialKey', () => {
  const line = (raw_material_id, itemCode) => ({ raw_material_id, itemCode });

  it('keeps one date per PO for the same material, in date order', () => {
    const map = buildConnectingDatesByMaterialKey([
      po('PO-3', { aqua: '2026-08-14' }, [line(12, 'AQUA')]),
      po('PO-1', { aqua: '2026-08-10' }, [line(12, 'AQUA')]),
    ]);
    expect(map.get('rm-12')).toEqual([
      { poNo: 'PO-1', date: '2026-08-10' },
      { poNo: 'PO-3', date: '2026-08-14' },
    ]);
  });

  it('keys pack materials separately from raw materials', () => {
    const map = buildConnectingDatesByMaterialKey([
      { order_id: 'PO-9', items: [{ pack_material_id: 7, itemCode: 'BOT' }], form_data: { connectingDateByItem: { bot: '2026-09-01' } } },
    ]);
    expect(map.get('pm-7')).toEqual([{ poNo: 'PO-9', date: '2026-09-01' }]);
    expect(map.get('rm-7')).toBeUndefined();
  });

  it('matches the item code case-insensitively', () => {
    const map = buildConnectingDatesByMaterialKey([po('PO-1', { '1001183': '2026-08-10' }, [line(5, '1001183')])]);
    expect(map.get('rm-5')).toHaveLength(1);
  });

  it('ignores a line whose code has no declared date', () => {
    const map = buildConnectingDatesByMaterialKey([po('PO-1', { aqua: '2026-08-10' }, [line(12, 'AQUA'), line(13, 'CAPB')])]);
    expect(map.get('rm-12')).toHaveLength(1);
    expect(map.get('rm-13')).toBeUndefined();
  });

  it('does not double-count a material listed on two lines of one PO', () => {
    const map = buildConnectingDatesByMaterialKey([po('PO-1', { aqua: '2026-08-10' }, [line(12, 'AQUA'), line(12, 'AQUA')])]);
    expect(map.get('rm-12')).toHaveLength(1);
  });

  it('honours the committed filter so cancelled POs contribute no dates', () => {
    const pos = [po('PO-DEAD', { aqua: '2026-08-10' }, [line(12, 'AQUA')], { status: 'Cancelled' })];
    const map = buildConnectingDatesByMaterialKey(pos, { isCommitted: (p) => p.status !== 'Cancelled' });
    expect(map.size).toBe(0);
  });

  it('handles an empty or missing PO list', () => {
    expect(buildConnectingDatesByMaterialKey([]).size).toBe(0);
    expect(buildConnectingDatesByMaterialKey(undefined).size).toBe(0);
  });
});
