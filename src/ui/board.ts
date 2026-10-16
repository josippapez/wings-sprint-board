// The board view's state: the snapshot main serves after each board check, so the list costs no az calls, the
// filters, and the items opened. An item's details, comments and pull requests are read when it's opened, and kept
// until the board shows a newer revision of it.

import { setting } from "wings-plugin-sdk/settings";

import { azJson, failure, pullRequestIds } from "../lib/azure";
import { invoke } from "../lib/lists";
import type { Settings } from "../lib/settings";
import type { Snapshot } from "../lib/types";
import { page, render } from "./page";

export type { BoardItem, Snapshot } from "../lib/types";

/** `az boards work-item show --expand relations`. */
export interface WorkItemJson {
  rev?: number;
  fields?: Record<string, unknown> & {
    "System.Title"?: string;
    "System.WorkItemType"?: string;
    "System.State"?: string;
    "System.AssignedTo"?: { displayName?: string };
    "System.IterationPath"?: string;
    "System.AreaPath"?: string;
  };
  relations?: { rel: string; url: string }[];
  multilineFieldsFormat?: Record<string, string>;
}
/** A comment of the comments API. */
export interface CommentJson {
  id?: number;
  text?: string;
  renderedText?: string;
  format?: string;
  createdBy?: { displayName?: string };
  createdDate?: string;
}
/** `az repos pr show`, or why it couldn't be read. */
export interface PullRequestJson {
  status?: string;
  title?: string;
  isDraft?: boolean;
  repository?: { webUrl?: string };
  error?: string;
}

export interface Detail {
  rev: number;
  item?: WorkItemJson | null;
  comments?: CommentJson[];
  prs: Map<number, PullRequestJson | null>;
  error?: string;
  loading: boolean;
}

export const board = {
  snapshot: null as Snapshot | null,
  /** Filters, tab and which groups are flipped from their default, kept in storage. */
  view: { tab: "board", who: "all", type: "", q: "", toggled: [] as string[] },
  /** Items opened, the last one on screen. */
  opened: [] as number[],
  listScroll: 0,
  /** The signed-in az account, to filter "Mine". */
  meLogin: null as string | null,
};

export const details = new Map<number, Detail>();

type View = typeof board.view;
/** The filters, tab and folds, remembered between starts. */
const savedView = setting<View>("view", {
  default: board.view,
  check: (value) => (value && typeof value === "object" && !Array.isArray(value) ? { ...board.view, ...value } : undefined),
});

export async function loadView() {
  board.view = await savedView.get();
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function saveView() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void savedView.set(board.view).catch(() => {}), 400);
}

/** Drops cached details whose item the board now shows at a newer revision, and reads the one on screen again. */
export function dropStaleDetails() {
  const next = board.snapshot;
  if (!next) return;
  const revs = new Map(next.items.map((i) => [i.id, i.rev]));
  for (const [id, d] of details) {
    if (revs.has(id) && revs.get(id) !== d.rev) {
      details.delete(id);
      if (board.opened.at(-1) === id) void openItem(id, false);
    }
  }
  render();
}

// ---------- small pieces ----------

export const settingsOf = (): Partial<Settings> => page.main?.settings ?? {};
export const workItemUrl = (id: number) => `${String(settingsOf().org ?? "").replace(/\/+$/, "")}/${encodeURIComponent(settingsOf().project ?? "")}/_workitems/edit/${id}`;
export const byId = () => new Map((board.snapshot?.items ?? []).map((i) => [i.id, i]));
export const typeColor = (type: string) => board.snapshot?.types[type]?.color ?? "#888888";
export const stateInfo = (type: string, state: string) => board.snapshot?.types[type]?.states.find((s) => s.name === state);

/** Whether a group or parent is open: groups of done work and parents start closed. */
export const isOpen = (key: string, openByDefault: boolean) => openByDefault !== board.view.toggled.includes(key);
export function toggle(key: string) {
  const view = board.view;
  view.toggled = view.toggled.includes(key) ? view.toggled.filter((k) => k !== key) : [...view.toggled, key];
  saveView();
  render();
}

// ---------- an item ----------

/** Opens an item in the sidebar and reads what the board doesn't have. */
export async function openItem(id: number, push = true) {
  if (push) {
    if (!board.opened.length) board.listScroll = document.scrollingElement?.scrollTop ?? 0;
    if (board.opened.at(-1) !== id) board.opened.push(id);
    render();
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  }
  const known = byId().get(id);
  const cached = details.get(id);
  if (cached && (cached.loading || (cached.item && !cached.error && (!known || known.rev === cached.rev)))) return;
  const s = settingsOf();
  const d: Detail = { rev: known?.rev ?? 0, prs: new Map(), loading: true };
  details.set(id, d);
  render();
  try {
    const [item, comments] = await Promise.all([
      azJson<WorkItemJson>(["boards", "work-item", "show", "--id", String(id), "--expand", "relations"], s.org ?? null),
      invoke<{ comments?: CommentJson[] }>(s.org ?? null, "comments", [`project=${s.project}`, `workItemId=${id}`], ["order=asc"], "wit", "7.1-preview"),
    ]);
    d.item = item;
    d.rev = item?.rev ?? d.rev;
    d.comments = comments?.comments ?? [];
    d.loading = false;
    render();
    // Pull requests last: the item is already on screen.
    const prIds = pullRequestIds(item?.relations ?? []);
    await Promise.all(
      prIds.map(async (pr) => {
        try {
          d.prs.set(pr, await azJson<PullRequestJson>(["repos", "pr", "show", "--id", String(pr), "--detect", "false"], s.org ?? null));
        } catch (error) {
          d.prs.set(pr, { error: failure(error) });
        }
        render();
      }),
    );
  } catch (error) {
    d.error = failure(error);
    d.loading = false;
    render();
  }
}

export function back() {
  board.opened.pop();
  render();
  if (!board.opened.length && document.scrollingElement) document.scrollingElement.scrollTop = board.listScroll;
}
