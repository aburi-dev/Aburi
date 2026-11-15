/** Holds the thread for `ms` milliseconds, the way a slow synchronous plugin call would. */
export function spend(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export interface CostGrowthOptions {
  /** Rounds to take the median of. */
  readonly rounds?: number
  /**
   * How long each side is timed for, in batches long enough that a call far below the clock's grain
   * still times.
   */
  readonly sampleMs?: number
  /** A round at or above this ratio is timed once more, in case a stall landed in it. */
  readonly retryAt?: number
}

export interface CostGrowth {
  readonly median: number
  readonly ratios: readonly number[]
}

/**
 * How many times longer a call of `large` takes than a call of `small`. Each round times both in
 * turn, alternating which goes first, so a slower runner slows both sides alike. A side costs what
 * its fastest batch did, since a stall only ever adds time: a runner that shares its cores, and so
 * takes them away for a while at a steady beat, would otherwise slow whichever side is timed first
 * in every round alike.
 */
export function costGrowth(
  small: () => void,
  large: () => void,
  { rounds = 5, sampleMs = 5, retryAt = Number.POSITIVE_INFINITY }: CostGrowthOptions = {},
): CostGrowth {
  leastCost(small, sampleMs)
  const measure = (largeFirst: boolean): number => {
    if (largeFirst) {
      const largeCost = leastCost(large, sampleMs)
      return largeCost / leastCost(small, sampleMs)
    }
    const smallCost = leastCost(small, sampleMs)
    return leastCost(large, sampleMs) / smallCost
  }
  const ratios: number[] = []
  for (let round = 0; round < rounds; round++) {
    const ratio = measure(round % 2 === 0)
    ratios.push(ratio < retryAt ? ratio : measure(round % 2 === 0))
  }
  return { median: median(ratios), ratios }
}

const BATCHES = 10
const MIN_BATCHES = 2

// A side runs for `sampleMs` and over at least `MIN_BATCHES` batches, so a stall that outlasts the
// sample spoils one batch of it rather than all.
function leastCost(run: () => void, sampleMs: number): number {
  const batchMs = sampleMs / BATCHES
  const started = performance.now()
  let least = Number.POSITIVE_INFINITY
  let batches = 0
  do {
    const batchStarted = performance.now()
    let calls = 0
    let elapsed = 0
    do {
      run()
      calls++
      elapsed = performance.now() - batchStarted
    } while (elapsed < batchMs)
    least = Math.min(least, elapsed / calls)
    batches++
  } while (batches < MIN_BATCHES || performance.now() - started < sampleMs)
  return least
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}
