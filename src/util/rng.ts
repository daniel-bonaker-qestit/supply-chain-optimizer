// mulberry32 — small, fast, deterministic 32-bit seeded PRNG.
// https://github.com/bryc/code/blob/master/jshash/PRNGs.md
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string into a 32-bit unsigned integer (cyrb53-like, simplified). */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Construct a deterministic Rng from a string seed plus optional salt. */
export function rngFromSeed(seed: string, salt = ''): Rng {
  return mulberry32(hashString(`${seed}::${salt}`));
}

export function rangeInt(rng: Rng, lo: number, hi: number): number {
  // Inclusive [lo, hi].
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function rangeFloat(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick from empty array');
  return items[Math.floor(rng() * items.length)]!;
}
