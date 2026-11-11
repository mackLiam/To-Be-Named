import { describe, expect, it } from 'vitest';

import { sweepCaptureEnabled } from './sweepFlag';

describe('sweepCaptureEnabled', () => {
  it('is on only in a dev build with the exact value "true"', () => {
    expect(sweepCaptureEnabled(true, 'true')).toBe(true);
  });

  it('stays off in production builds whatever the env says', () => {
    expect(sweepCaptureEnabled(false, 'true')).toBe(false);
  });

  it('stays off for anything but the exact string', () => {
    for (const v of [undefined, '', 'TRUE', '1', 'yes', ' true']) {
      expect(sweepCaptureEnabled(true, v)).toBe(false);
    }
  });
});
