import { describe, expect, test } from 'bun:test';
import { collectionWindowMinutes, FIRST_WINDOW_MINUTES, LIVE_WINDOW_MINUTES } from './collect';

describe('collectionWindowMinutes', () => {
  const now = new Date('2026-09-19T21:50:00Z');

  test('uses 24 hours when the index is empty', () => {
    expect(collectionWindowMinutes(null, now)).toBe(FIRST_WINDOW_MINUTES);
  });

  test('uses 24 hours until a post is older than 20 hours', () => {
    expect(collectionWindowMinutes(new Date('2026-09-19T10:00:00Z'), now)).toBe(FIRST_WINDOW_MINUTES);
    expect(collectionWindowMinutes(new Date('2026-09-18T21:00:00Z'), now)).toBe(LIVE_WINDOW_MINUTES);
  });
});
