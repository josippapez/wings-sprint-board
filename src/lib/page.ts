// The sidebar page's shared state and its render. Every change to the state calls render(), which draws the page
// at once, as the page did when it rebuilt itself with DOM calls.

import { createElement, Fragment, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { showSidebar } from "wings-plugin-ui";

import { setup } from "./setup";
import type { Published } from "./types";

export const app = document.getElementById("app") as HTMLElement;

export const page = {
  /** What main.js sent last. */
  main: null as Published | null,
  signingIn: false,
  localError: null as string | null,
};

let draw: () => ReactNode = () => null;

/** Sets what render() draws in the sidebar. */
export function mount(view: () => ReactNode) {
  draw = view;
}

export function render() {
  const active = document.activeElement;
  const focused = active?.id;
  const caret = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null;
  // Everything is rebuilt, so keep where the page and each scrolling list were.
  const page = document.scrollingElement?.scrollTop ?? 0;
  const lists = [...app.querySelectorAll(".scroll[id]")].map((el) => [el.id, el.scrollTop] as const);
  flushSync(() => showSidebar(createElement(Fragment, null, draw())));
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
