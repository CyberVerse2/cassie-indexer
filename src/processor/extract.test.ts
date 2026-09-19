import { describe, expect, test } from 'bun:test';
import { coerceExtraction } from './extract';

describe('coerceExtraction', () => {
  test('lifts string strategy legs into suggested components', () => {
    const raw = {
      is_idea: true,
      ideas: [{
        strategy: {
          exit: 'fade the bounce',
          hold: 'session',
          stop_loss: 'above 50',
          take_profit: 'prior lows',
        },
      }],
    };
    expect(coerceExtraction(raw)).toEqual({
      is_idea: true,
      ideas: [{
        strategy: {
          exit: { text: 'fade the bounce', basis: 'suggested' },
          hold: { text: 'session', basis: 'suggested' },
          stop_loss: { text: 'above 50', basis: 'suggested' },
          take_profit: { text: 'prior lows', basis: 'suggested' },
        },
      }],
    });
  });

  test('maps commodity subject kind to asset', () => {
    const raw = { ideas: [{ subjects: [{ label: 'Gold', kind: 'commodity' }, { label: 'GLD', kind: 'asset' }] }] };
    expect(coerceExtraction(raw)).toEqual({
      ideas: [{ subjects: [{ label: 'Gold', kind: 'asset' }, { label: 'GLD', kind: 'asset' }] }],
    });
  });
});
