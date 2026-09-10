/** Bound live frames independently of the number of persisted chat cards. */
export class ToolAppSlotPool {
  private slots = new Map<symbol, (active: boolean) => void>();
  private active = new Set<symbol>();

  constructor(private readonly limit = 4) {}

  acquire(notify: (active: boolean) => void): () => void {
    const id = Symbol();
    this.slots.set(id, notify);
    this.reconcile();
    return () => {
      this.slots.delete(id);
      this.active.delete(id);
      this.reconcile();
    };
  }

  private reconcile() {
    for (const [id, notify] of this.slots) {
      if (this.active.size >= this.limit) break;
      if (!this.active.has(id)) {
        this.active.add(id);
        notify(true);
      }
    }
  }
}
