import { describe, expect, it } from 'vitest';

import { dataExportFile } from './dataExport';

describe('dataExportFile', () => {
  it('names the file by date and pretty-prints the export unchanged', () => {
    const data = { account: { email: 'a@b.co' }, scans: [{ id: 's1' }], orders: [] };
    const file = dataExportFile(data, new Date('2026-09-30T23:59:00Z'));
    expect(file.filename).toBe('forms-my-data-2026-09-30.json');
    expect(JSON.parse(file.text)).toEqual(data);
    expect(file.text).toContain('\n  "scans": [');
  });

  it('keeps unicode intact', () => {
    const file = dataExportFile({ profile: { name: 'Zoë' } }, new Date(0));
    expect(JSON.parse(file.text)).toEqual({ profile: { name: 'Zoë' } });
  });
});
