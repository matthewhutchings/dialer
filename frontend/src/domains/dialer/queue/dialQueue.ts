import { useSyncExternalStore } from "react";

const KEY = "dialer-call-queue";
const listeners = new Set<() => void>();
let cache: string[] | null = null;

function read(): string[] {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(ids: string[]) {
  cache = ids;
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Storage full or blocked: the queue still works for this session.
  }
  listeners.forEach((l) => l());
}

/** Appends ids (skipping ones already queued) and returns how many were new. */
export function addToQueue(ids: string[]): number {
  const have = new Set(read());
  const fresh = [...new Set(ids)].filter((id) => !have.has(id));
  if (fresh.length) write([...read(), ...fresh]);
  return fresh.length;
}

export const removeFromQueue = (id: string) => write(read().filter((x) => x !== id));
export const clearQueue = () => write([]);

export function useDialQueue(): string[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
  );
}
