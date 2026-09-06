import { AsyncLocalStorage } from 'node:async_hooks';
import type { Priority } from './scheduler.js';

export interface GmgnContext {
  priority?: Priority;
  deadlineMs?: number;
  correlationId?: string;
}
const context = new AsyncLocalStorage<GmgnContext>();
export const gmgnContext = (): GmgnContext => context.getStore() ?? {};
export function withGmgnContext<T>(value: GmgnContext, run: () => T): T {
  const parent = gmgnContext();
  const deadline = Math.min(parent.deadlineMs ?? Infinity, value.deadlineMs ?? Infinity);
  return context.run(
    { ...parent, ...value, ...(Number.isFinite(deadline) ? { deadlineMs: deadline } : {}) },
    run
  );
}
