// Reads a list that a `cached` loader keeps, for a render: what is known now, and a render when a load lands.

import type { Cached } from "wings-plugin-sdk/async";

import { failure } from "../lib/azure";
import { render } from "./page";

export type Loaded<T> = { value?: T; error?: string; loading: boolean };

/** What a load that hasn't produced a value is doing, by loader and key: still waiting, or why it failed. */
const open = new WeakMap<object, Map<string, { error?: string }>>();

/** What `list` has for `key` now. A load that isn't started starts, and the page renders when it lands. */
export function want<K, V>(list: Cached<K, V>, key: K): Loaded<V> {
  const value = list.peek(key);
  if (value !== undefined) return { value, loading: false };
  const known = open.get(list)?.get(JSON.stringify(key));
  if (known) return { error: known.error, loading: !known.error };
  void need(list, key).then(render, render);
  return { loading: true };
}

/** Waits for a list, for detection. A failure is kept for `want`, so the page shows it without asking again. */
export function need<K, V>(list: Cached<K, V>, key: K): Promise<V> {
  const slots = open.get(list) ?? open.set(list, new Map()).get(list)!;
  const id = JSON.stringify(key);
  const slot = slots.get(id) ?? slots.set(id, {}).get(id)!;
  return list.get(key).then(
    (value) => {
      slots.delete(id);
      return value;
    },
    (error: unknown) => {
      slot.error = failure(error);
      throw error;
    },
  );
}
