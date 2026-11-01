/** One computation per key for the memo's life, its promise shared by every caller. */
export class AsyncMemo<K, V> {
  readonly #entries = new Map<K, Promise<V>>()

  get(key: K, compute: () => Promise<V>): Promise<V> {
    let entry = this.#entries.get(key)
    if (entry === undefined) {
      entry = compute()
      this.#entries.set(key, entry)
    }
    return entry
  }

  prime(key: K, value: V): void {
    if (!this.#entries.has(key)) this.#entries.set(key, Promise.resolve(value))
  }
}
