import type { Result } from "./check";
import type { Settings } from "./settings";

/** What main knows, and serves the sidebar as the `state` query. */
export interface MainState {
  phase: "loading" | "setup" | "signed-out" | "error" | "ready";
  settings: Settings;
  missing: string[];
  result: Result | null;
  error: string | null;
  running: boolean;
}

/** The state as the sidebar gets it: the board has a query of its own, so the result comes without it. */
export type Published = Omit<MainState, "result"> & { result: Omit<Result, "snapshot"> | null };

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
  /** The sprint path, set only on items found outside the sprint. */
  iteration?: string;
}

/** The board as the last check read it. */
export interface Snapshot {
  checkedAt: string;
  sprint: { name: string; start: string | null; finish: string | null };
  items: BoardItem[];
  types: Record<string, { color: string; states: { name: string; category: string; color: string }[] }>;
}
