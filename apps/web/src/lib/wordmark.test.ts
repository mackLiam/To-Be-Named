import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BRAND_HEX,
  WORDMARK_LETTERS,
  WORDMARK_O,
  WORDMARK_O_OFFSET_X,
  WORDMARK_VIEWBOX,
  wordmarkColors,
  wordmarkHex,
} from './wordmark';

const svg = readFileSync(
  join(__dirname, '../../public/brand/wordmark-reverse-for-brown.svg'),
  'utf8',
);

describe('wordmark geometry', () => {
  it('matches the designer SVG asset exactly', () => {
    expect(svg).toContain(`viewBox="${WORDMARK_VIEWBOX}"`);
    expect(svg).toContain(`d="${WORDMARK_LETTERS}"`);
    expect(svg).toContain(`d="${WORDMARK_O}"`);
    expect(svg).toContain(`translate(${WORDMARK_O_OFFSET_X} 0)`);
  });

  it('matches the asset pairing on brown', () => {
    const { letters, o } = wordmarkHex('brown');
    expect(svg).toContain(`fill="${letters}"`);
    expect(svg).toContain(`stroke="${o}"`);
  });
});

describe('wordmarkColors', () => {
  it('uses brick letters and a brown O on yellow', () => {
    expect(wordmarkColors('yellow')).toEqual({
      letters: 'var(--brick-500)',
      o: 'var(--brown-900)',
    });
    expect(wordmarkHex('yellow')).toEqual({ letters: BRAND_HEX.brick, o: BRAND_HEX.brown });
  });

  it('uses yellow letters and a bright brick O on brown', () => {
    expect(wordmarkColors('brown')).toEqual({
      letters: 'var(--yellow)',
      o: 'var(--bright-brick)',
    });
  });

  it('never puts bright brick on yellow', () => {
    const onYellow = wordmarkColors('yellow');
    expect([onYellow.letters, onYellow.o]).not.toContain('var(--bright-brick)');
    const hex = wordmarkHex('yellow');
    expect([hex.letters, hex.o]).not.toContain(BRAND_HEX.brightBrick);
  });
});
