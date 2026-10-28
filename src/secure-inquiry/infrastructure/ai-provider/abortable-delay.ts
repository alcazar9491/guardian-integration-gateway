import { setTimeout as sleep } from 'node:timers/promises';

/** Resolves after `ms`; rejects early (and clears its timer) when `signal` aborts. Never blocks the event loop. */
export type Delay = (ms: number, signal?: AbortSignal) => Promise<void>;

export const abortableDelay: Delay = async (ms, signal) => {
  await sleep(ms, undefined, signal ? { signal } : {});
};
