import { describe, expect, test } from 'bun:test';
import { discoverAssets, identityMatch, knownShares } from './asset-directory.js';

const PLTR = '0x1111111111111111111111111111111111111111';
const FAKE = '0x2222222222222222222222222222222222222222';
const ETH = '0x3333333333333333333333333333333333333333';
const listed = {
  ticker: 'PLTR',
  address: PLTR,
  chain: 'base',
  issuer: 'xStocks',
  kind: 'shares',
  symbol: 'PLTRx',
};
const directory = new Map([[`base:${PLTR}`, listed]]);

function hit(address: string, extra: Record<string, unknown> = {}) {
  return { chain: 'base', address, price: 42, decimals: 8, riskFlagged: false, symbol: 'PLTRx', liquidity: 1000, volume24h: 10, ...extra };
}

describe('knownShares', () => {
  test('returns every listed contract for the ticker', () => {
    const arb = { ticker: 'PLTR', address: ETH, chain: 'arbitrum', issuer: 'xStocks' };
    const rows = knownShares('pltr', new Map([
      [`arbitrum:${ETH}`, arb],
      [`base:${PLTR}`, listed],
    ]));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row: { chain: string }) => row.chain))).toEqual(new Set(['arbitrum', 'base']));
  });
});

describe('identityMatch', () => {
  test('requires a listed identity whose ticker matches the query', () => {
    expect(identityMatch(hit(PLTR), listed, 'PLTR')).toBe(true);
    expect(identityMatch(hit(PLTR), listed, 'HON')).toBe(false);
    expect(identityMatch(hit(PLTR), null, 'PLTR')).toBe(false);
    expect(identityMatch(hit(PLTR, { decimals: 1.5 }), listed, 'PLTR')).toBe(false);
  });
});

describe('discoverAssets', () => {
  test('asks Definitive for the listed contract when ticker search misses', async () => {
    const queries: string[] = [];
    const flash = async (path: string) => {
      queries.push(path);
      if (path.includes('query=PLTR')) return { assets: [hit(FAKE)] };
      if (path.includes('query=' + encodeURIComponent(PLTR))) return { assets: [hit(PLTR)] };
      return { assets: [] };
    };
    const found = await discoverAssets('PLTR', 'shares', flash, undefined, directory);
    expect(found.map((row: { address: string }) => row.address)).toEqual([PLTR]);
    expect(queries.some((path) => path.includes(encodeURIComponent(PLTR)) && path.includes('chain=base'))).toBe(true);
  });

  test('keeps a ticker-search hit and does not duplicate the listed contract', async () => {
    const queries: string[] = [];
    const flash = async (path: string) => {
      queries.push(path);
      return { assets: [hit(PLTR)] };
    };
    const found = await discoverAssets('PLTR', 'shares', flash, undefined, directory);
    expect(found).toHaveLength(1);
    expect(found[0].address).toBe(PLTR);
    expect(queries).toEqual(['/search?query=PLTR&limit=25']);
  });

  test('drops a listed contract with no price or a risk flag', async () => {
    const flash = async (path: string) => {
      if (path.includes('query=PLTR')) return { assets: [] };
      return { assets: [hit(PLTR, { price: 0, riskFlagged: true })] };
    };
    expect(await discoverAssets('PLTR', 'shares', flash, undefined, directory)).toEqual([]);
  });

  test('ranks the same ticker by liquidity across chains', async () => {
    const ink = { ...listed, address: ETH, chain: 'ink' };
    const stocks = new Map([
      [`base:${PLTR}`, listed],
      [`ink:${ETH}`, ink],
    ]);
    const flash = async (path: string) => {
      if (path.includes('query=PLTR')) return { assets: [] };
      if (path.includes(PLTR)) return { assets: [hit(PLTR, { liquidity: 100 })] };
      if (path.includes(ETH)) return { assets: [hit(ETH, { chain: 'ink', liquidity: 5000 })] };
      return { assets: [] };
    };
    const found = await discoverAssets('PLTR', 'shares', flash, undefined, stocks);
    expect(found.map((row: { chain: string; liquidity: number }) => row.chain + ':' + row.liquidity)).toEqual(['ink:5000', 'base:100']);
  });

  test('keeps looking after a listed contract miss', async () => {
    const later = { ...listed, address: ETH, chain: 'ink' };
    const stocks = new Map([
      [`base:${PLTR}`, listed],
      [`ink:${ETH}`, later],
    ]);
    const flash = async (path: string) => {
      if (path.includes('query=PLTR')) return { assets: [] };
      if (path.includes(PLTR)) return { assets: [] };
      if (path.includes(ETH)) return { assets: [hit(ETH, { chain: 'ink' })] };
      return { assets: [] };
    };
    const found = await discoverAssets('PLTR', 'shares', flash, undefined, stocks);
    expect(found.map((row: { chain: string; address: string }) => row.chain + ':' + row.address)).toEqual(['ink:' + ETH]);
  });
});
