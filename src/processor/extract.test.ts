import { describe, expect, test } from 'bun:test';
import { coerceExtraction, normalizeOpenAiExtraction } from './extract';

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

describe('normalizeOpenAiExtraction', () => {
  test('maps empty strings and unspecified conviction to null', () => {
    const raw = {
      is_idea: true,
      reject_reason: '',
      ideas: [{
        thesis: 'Long NVDA on data-center demand.',
        stated_by_author: true,
        reasoning: ['Setup is a demand shock.', 'Edge is supply lag.', 'Payoff is multiple expansion.'],
        subjects: [{ label: 'NVIDIA', kind: 'company' }],
        direction: 'long',
        horizon: 'medium-term',
        target: '',
        invalidation: '  ',
        conviction: 'unspecified',
        strategy: {
          exit: { text: 'scale out into strength', basis: 'suggested' },
          hold: { text: 'weeks', basis: 'suggested' },
          stop_loss: { text: 'below 200', basis: 'suggested' },
          take_profit: { text: 'prior highs', basis: 'suggested' },
        },
        quotes: ['data-center demand'],
        headline_quote: 'data-center demand',
        asset_class: 'equity',
        context: 'NVIDIA sells GPUs used to train and run AI models.',
        candidate_tickers: ['NVDA'],
      }],
    };
    const normalized = normalizeOpenAiExtraction(raw);
    expect(normalized.reject_reason).toBeNull();
    expect(normalized.ideas[0].target).toBeNull();
    expect(normalized.ideas[0].invalidation).toBeNull();
    expect(normalized.ideas[0].conviction).toBeNull();
  });
});
