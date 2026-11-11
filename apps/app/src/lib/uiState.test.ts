import { describe, expect, it } from 'vitest';

import { AA_LARGE_TEXT, contrastRatio } from '../theme/contrast';
import { colors } from '../theme/tokens';
import { buttonA11y, listView, wordmarkColors } from './uiState';

describe('listView', () => {
  it('shows rows whenever there are any, even while reloading or after an error', () => {
    expect(listView({ loading: true, error: null, count: 2 })).toBe('content');
    expect(listView({ loading: false, error: new Error('x'), count: 1 })).toBe('content');
  });

  it('shows loading on the first load', () => {
    expect(listView({ loading: true, error: null, count: 0 })).toBe('loading');
  });

  it('shows loading during a retry, not the previous error', () => {
    expect(listView({ loading: true, error: new Error('offline'), count: 0 })).toBe('loading');
  });

  it('shows the error once loading stops with nothing to show', () => {
    expect(listView({ loading: false, error: new Error('offline'), count: 0 })).toBe('error');
  });

  it('shows empty only when the load finished cleanly with no rows', () => {
    expect(listView({ loading: false, error: null, count: 0 })).toBe('empty');
  });
});

describe('buttonA11y', () => {
  it('is a button with a plain enabled state by default', () => {
    expect(buttonA11y({})).toEqual({
      accessibilityRole: 'button',
      accessibilityState: { disabled: false, busy: false },
    });
  });

  it('marks a busy button as busy and disabled, so a second tap does nothing', () => {
    expect(buttonA11y({ busy: true }).accessibilityState).toEqual({ disabled: true, busy: true });
  });

  it('keeps a disabled button disabled but not busy', () => {
    expect(buttonA11y({ disabled: true }).accessibilityState).toEqual({
      disabled: true,
      busy: false,
    });
  });

  it('passes label and hint through only when given', () => {
    const props = buttonA11y({ label: 'Order Club guard', hint: 'Opens payment' });
    expect(props.accessibilityLabel).toBe('Order Club guard');
    expect(props.accessibilityHint).toBe('Opens payment');
    expect('accessibilityLabel' in buttonA11y({})).toBe(false);
    expect('accessibilityHint' in buttonA11y({ label: 'x' })).toBe(false);
  });
});

describe('wordmarkColors', () => {
  it('uses brick letters and a brown O on the yellow field', () => {
    expect(wordmarkColors('yellow')).toEqual({ letters: colors.brick[500], o: colors.brown[900] });
  });

  it('uses yellow letters and a bright brick O on stud brown', () => {
    expect(wordmarkColors('brown')).toEqual({ letters: colors.yellow, o: colors.brightBrick });
  });

  it('never puts bright brick on yellow', () => {
    expect(Object.values(wordmarkColors('yellow'))).not.toContain(colors.brightBrick);
  });

  it('keeps every wordmark color at large-text contrast or better on its surface', () => {
    const surfaces = { yellow: colors.yellow, brown: colors.brown[900] } as const;
    for (const surface of ['yellow', 'brown'] as const) {
      for (const fg of Object.values(wordmarkColors(surface))) {
        expect(contrastRatio(fg, surfaces[surface])).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
      }
    }
  });
});

describe('wordmark geometry', () => {
  it('sizes the drawing from its own viewBox, so it never stretches', async () => {
    const { WORDMARK_ASPECT, WORDMARK_VIEWBOX } = await import('../components/wordmarkPaths');
    const [, , w, h] = WORDMARK_VIEWBOX.split(' ').map(Number);
    expect(WORDMARK_ASPECT).toBeCloseTo((w ?? 0) / (h ?? 1), 3);
  });
});
