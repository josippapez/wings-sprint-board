// The board view's state: the snapshot main.js keeps in storage after each board check, so the list costs no az
// calls, the filters, and the items opened. An item's details, comments and pull requests are read when it's
// opened, and kept until the board shows a newer revision of it.

import { az, invoke } from "./lists";
import { page, render } from "./page";
import type { Settings } from "./settings";

export interface BoardItem {
  id: number;
  rev: number;
  title: string;
  type: string;
  state: string;
  category: string;
  assignee: string | null;
  login: string | null;
  parent: number | null;
  tags: string[];
  blocked: boolean;
  blockedBy: string | null;
  comments: number;
  prs: { id: number; status: string }[] | null;
  checks: string[];
}
export interface Snapshot {
  checkedAt: string;
  sprint: { name: string; start: string | null; finish: string | null };
  items: BoardItem[];
  types: Record<string, { color: string; states: { name: string; category: string; color: string }[] }>;
}

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

export async function loadView() {
  try {
    const saved = await wings.storage.get("view");
    if (saved && typeof saved === "object") board.view = { ...board.view, ...saved };
  } catch {
    // The defaults do; storage only remembers filters.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function saveView() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void wings.storage.set("view", board.view).catch(() => {}), 400);
}

/** Reads the board main.js stored, and drops cached details whose item changed. */
export async function loadSnapshot() {
  const next = (await wings.storage.get("board")) as Snapshot | null;
  if (!next || next.checkedAt === board.snapshot?.checkedAt) return;
  board.snapshot = next;
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
      az<WorkItemJson>(["boards", "work-item", "show", "--id", String(id), "--expand", "relations"], s.org ?? null),
      invoke<{ comments?: CommentJson[] }>(s.org ?? null, "comments", [`project=${s.project}`, `workItemId=${id}`], ["order=asc"], "wit", "7.1-preview"),
    ]);
    d.item = item;
    d.rev = item?.rev ?? d.rev;
    d.comments = comments?.comments ?? [];
    d.loading = false;
    render();
    // Pull requests last: the item is already on screen.
    const prIds = (item?.relations ?? [])
      .filter((r) => r.rel === "ArtifactLink" && /^vstfs:\/\/\/Git\/PullRequestId\//i.test(r.url))
      .map((r) => Number(decodeURIComponent(r.url).split("/").at(-1)))
      .filter((n) => Number.isInteger(n) && n > 0);
    await Promise.all(
      prIds.map(async (pr) => {
        try {
          d.prs.set(pr, await az<PullRequestJson>(["repos", "pr", "show", "--id", String(pr), "--detect", "false"], s.org ?? null));
        } catch (error) {
          d.prs.set(pr, { error: String((error as Error | null)?.message ?? error) });
        }
        render();
      }),
    );
  } catch (error) {
    d.error = String((error as Error | null)?.message ?? error);
    d.loading = false;
    render();
  }
}

export function back() {
  board.opened.pop();
  render();
  if (!board.opened.length && document.scrollingElement) document.scrollingElement.scrollTop = board.listScroll;
}
