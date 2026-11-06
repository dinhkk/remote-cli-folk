/** Deterministic PRNG (mulberry32) so fuzz and property tests reproduce from their seed. */

export type SeededRandom = {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  bytes(length: number): Buffer;
  pick<T>(items: readonly T[]): T;
};

export const createSeededRandom = (seed: number): SeededRandom => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    bytes(length) {
      const out = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) out[i] = int(0, 255);
      return out;
    },
    pick(items) {
      return items[int(0, items.length - 1)];
    },
  };
};
