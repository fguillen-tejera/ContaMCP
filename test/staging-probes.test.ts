import { describe, expect, it, vi } from 'vitest';
import { observeMutationThrottling } from '../scripts/staging-probes';

describe('bounded hosted throttle observation', () => {
  it('allows temporary overshoot and requires rejection of both replay kinds', async () => {
    const attempts = { create: 0, update: 0 };
    const pause = vi.fn(async () => {});
    const observed = await observeMutationThrottling(async (kind) => {
      attempts[kind]++;
      return attempts[kind] >= (kind === 'create' ? 2 : 3);
    }, pause);
    expect(observed).toBe(true);
    expect(attempts).toEqual({ create: 2, update: 3 });
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it('returns inconclusive at its bound when only one request class is throttled', async () => {
    const replay = vi.fn(async (kind: 'create' | 'update') => kind === 'create');
    const pause = vi.fn(async () => {});
    expect(await observeMutationThrottling(replay, pause)).toBe(false);
    expect(replay.mock.calls.filter(([kind]) => kind === 'create')).toHaveLength(1);
    expect(replay.mock.calls.filter(([kind]) => kind === 'update')).toHaveLength(8);
    expect(pause).toHaveBeenCalledTimes(7);
  });

  it('does not turn transport or replay failures into a passed throttle check', async () => {
    const replay = vi.fn(async () => {
      throw new Error('synthetic transport failure');
    });
    await expect(observeMutationThrottling(replay, async () => {})).rejects.toThrow(
      'synthetic transport failure',
    );
    expect(replay).toHaveBeenCalledTimes(1);
  });
});
