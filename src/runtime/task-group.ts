/** Track work which outlives a timer or callback so shutdown can drain it before closing SQLite. */
export class TaskGroup {
  private readonly pending = new Set<Promise<unknown>>();

  track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    const settled = () => {
      this.pending.delete(task);
    };
    void task.then(settled, settled);
    return task;
  }

  async drain(): Promise<void> {
    // Completion hooks may register more work while the original task settles.
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
