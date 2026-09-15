// Deterministic PRNG. Every result in this lab must be reproducible from a
// seed, on any machine, with no network and no wall clock.
//
// mulberry32: small, fast, well-distributed enough for arrival and service
// sampling. Not cryptographic and never used for anything that needs to be.

export class Rng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Exponential inter-arrival gap for a Poisson process of the given rate.
   * Real checkout traffic is burstier than Poisson; the article says so rather
   * than pretending this is a traffic model of anything real.
   */
  exponential(ratePerMs: number): number {
    if (ratePerMs <= 0) return Number.POSITIVE_INFINITY;
    return -Math.log(1 - this.next()) / ratePerMs;
  }
}
