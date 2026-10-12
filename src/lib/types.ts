import type { Result } from "./check";
import type { Settings } from "./settings";

/** What main.js knows, and sends the sidebar with wings.broadcast. */
export interface MainState {
  phase: "loading" | "setup" | "signed-out" | "error" | "ready";
  settings: Settings;
  missing: string[];
  result: Result | null;
  error: string | null;
  running: boolean;
}

/** The state as the sidebar gets it: the board itself goes through storage, so the result comes without it. */
export type Published = Omit<MainState, "result"> & { result: Omit<Result, "snapshot"> | null };

/** A message from main.js to the sidebar. */
export interface StateMessage {
  type: "state";
  state: Published;
}
