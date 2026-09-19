import { describe, expect, test } from 'bun:test';
import { plannerPayload, researchExpiry, validatePlan } from './plan';

describe('plannerPayload', () => {
  const idea = {
    thesis: 'NVDA benefits from data-center demand',
    reasoning: ['Capex rising'],
    quotes: ['NVDA'],
    horizon: 'medium-term',
    target: '$200/share',
    invalidation: null,
  } as any;
  const expires = new Date('2026-10-01T00:00:00Z');

  test('tells the planner a share token can use the equity thesis', () => {
    const payload = plannerPayload(idea, { ticker: 'NVDA', symbol: 'NVDAc', kind: 'shares', chain: 'base', issuer: 'Coinbase', address: '0xabc' }, 220, expires);
    expect(payload.role).toMatch(/company thesis is sufficient/i);
    expect(payload.asset.kind).toBe('shares');
    expect(payload.entryPrice).toBe(220);
  });

  test('requires a spot thesis to support the token', () => {
    const payload = plannerPayload(idea, { ticker: 'ETH', symbol: 'WETH', kind: 'spot', chain: 'base', address: '0xdef' }, 3000, expires);
    expect(payload.role).toMatch(/must support this token/i);
  });
});

describe('researchExpiry', () => {
  test('uses the horizon window from the post time', () => {
    const posted = new Date('2026-09-01T00:00:00Z');
    expect(researchExpiry(posted, 'immediate').toISOString()).toBe('2026-09-04T00:00:00.000Z');
    expect(researchExpiry(posted, 'short-term').toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(researchExpiry(posted, 'unspecified').toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });
});

describe('validatePlan', () => {
  const plan = {
    stopPrice: 90,
    targets: [{ price: 110, percent: 40 }, { price: 125, percent: 60 }],
    trailingStopPct: 5,
    breakevenAtPct: 10,
  };

  test('accepts staged exits that total 100% above entry', () => {
    expect(validatePlan(plan, 100)).toEqual(plan);
  });

  test('rejects a stop at or above entry and incomplete exit weights', () => {
    expect(() => validatePlan({ ...plan, stopPrice: 100 }, 100)).toThrow(/stop/);
    expect(() => validatePlan({ ...plan, targets: [{ price: 110, percent: 40 }] }, 100)).toThrow(/100%/);
    expect(() => validatePlan({ ...plan, targets: [{ price: 90, percent: 100 }] }, 100)).toThrow(/staged exit/);
  });
});
