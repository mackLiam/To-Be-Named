import { describe, expect, it } from 'vitest';

import { formatMoney, parseMoneyAmount } from './money';

describe('parseMoneyAmount', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12.50', 1250],
    [' 0.01 ', 1],
    ['0', 0],
    ['9999999.99', 999999999],
  ])('%s -> %i cents', (raw, cents) => {
    expect(parseMoneyAmount(raw)).toBe(cents);
  });

  it.each(['', '-1', '1.234', '1,50', '1e3', '.5', '12.', 'abc', '12345678', undefined])(
    'rejects %o',
    (raw) => {
      expect(parseMoneyAmount(raw)).toBeNull();
    },
  );

  it('round-trips with formatMoney', () => {
    expect(formatMoney(parseMoneyAmount('12.5'), 'usd')).toBe('$12.50');
  });
});
