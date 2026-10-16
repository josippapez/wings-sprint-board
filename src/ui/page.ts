// The sidebar page's shared state and its render. Every change to the state calls render(), which draws the page
// at once: the sidebar component registers how to redraw itself, and this restores focus and scroll after it.

import { flushSync } from "react-dom";

import { setup } from "./setup";
import type { Published } from "../lib/types";

export const page = {
  /** What main served last. */
  main: null as Published | null,
  signingIn: false,
  localError: null as string | null,
};

let redraw: (() => void) | null = null;

/** Sets how render() redraws the sidebar, and returns how to stop. */
export function onRender(draw: () => void) {
  redraw = draw;
  return () => {
    if (redraw === draw) redraw = null;
  };
}

export function render() {
  const active = document.activeElement;
  const focused = active?.id;
  const caret = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null;
  // Keep where the page and each scrolling list were.
  const page = document.scrollingElement?.scrollTop ?? 0;
  const lists = [...document.querySelectorAll(".scroll[id]")].map((el) => [el.id, el.scrollTop] as const);
  if (redraw) flushSync(redraw);
  for (const [id, top] of lists) {
    const el = document.getElementById(id);
    if (el) el.scrollTop = top;
  }
  if (document.scrollingElement) document.scrollingElement.scrollTop = page;
  if (focused) {
    const el = document.getElementById(focused);
    el?.focus();
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && caret != null && el.type !== "number") el.setSelectionRange(caret, caret);
  }
  // A new setup step puts focus on its question, so a screen reader reads it and Enter goes on from there.
  if (setup.focusAfterRender) {
    document.getElementById(setup.focusAfterRender)?.focus();
    setup.focusAfterRender = null;
  }
}
