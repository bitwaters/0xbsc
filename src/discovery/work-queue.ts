/** Bounded waiting work; each key coalesces to its latest snapshot. */
export class BoundedWorkQueue<T> {
  readonly pending = new Map<string, T>();
  private running = 0;
  private waiters: Array<() => void> = [];
  constructor(
    private readonly capacity: number,
    private readonly concurrency: number,
    private readonly run: (value: T) => Promise<void>,
    private readonly onError: (value: T, error: Error) => void
  ) {}
  enqueue(key: string, value: T): boolean {
    if (!this.pending.has(key) && this.pending.size >= this.capacity) return false;
    this.pending.set(key, value);
    this.pump();
    return true;
  }
  drain(): Promise<void> {
    return this.running === 0 && this.pending.size === 0
      ? Promise.resolve()
      : new Promise((resolve) => this.waiters.push(resolve));
  }
  private pump(): void {
    while (this.running < this.concurrency && this.pending.size) {
      const [key, value] = this.pending.entries().next().value!;
      this.pending.delete(key);
      this.running++;
      void this.run(value)
        .catch((e: unknown) =>
          this.onError(value, e instanceof Error ? e : new Error('candidate failed'))
        )
        .finally(() => {
          this.running--;
          this.pump();
          if (!this.running && !this.pending.size)
            for (const waiter of this.waiters.splice(0)) waiter();
        });
    }
  }
}
