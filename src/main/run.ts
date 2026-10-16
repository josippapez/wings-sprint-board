// What the main script knows: the state of the board check, the check itself, the title bar label and the board
// the sidebar lists. The sidebar gets them as the `state` and `board` queries, and Claude gets the check as text.

import { cached } from "wings-plugin-sdk/async";
import { CliError } from "wings-plugin-sdk/cli";
import { plural } from "wings-plugin-sdk/format";
import { setting } from "wings-plugin-sdk/settings";

import { failure } from "../lib/azure";
import { asText, boardCheck, type Result } from "../lib/check";
import { ch } from "../lib/messages";
import { DEFAULTS, missingSettings, savedSettings } from "../lib/settings";
import type { MainState, Published, Snapshot } from "../lib/types";

const SIDEBAR = "board";

const state: MainState = { phase: "loading", settings: DEFAULTS, missing: [], result: null, error: null, running: false };

/** The last check's board, kept for the next start: it shows while the first check runs. */
const lastBoard = setting<Snapshot | null>("board", {
  default: null,
  check: (value) => (value && typeof value === "object" && Array.isArray((value as Snapshot).items) ? (value as Snapshot) : undefined),
});

/** The state without the board, which has its query so a change of phase doesn't send it again. */
export function published(): Published {
  if (!state.result) return { ...state, result: null };
  const { snapshot: _board, ...result } = state.result;
  return { ...state, result };
}

export const boardOf = async () => state.result?.snapshot ?? (await lastBoard.get());

const publish = () => ch.put("state", undefined, published());

function label() {
  const r = state.result;
  if (state.phase === "signed-out") return wings.setSidebarLabel(SIDEBAR, "Sign in", { tone: "warning" });
  if (state.phase !== "ready" || !r) return wings.setSidebarLabel(SIDEBAR, null);
  // What the board looks like at a glance; the board checks are one row of the details.
  const items = r.snapshot.items;
  const active = items.filter((i) => i.category === "InProgress" || i.category === "Resolved").length;
  const blocked = items.filter((i) => i.blocked && i.category !== "Completed").length;
  const n = r.findings.length;
  return wings.setSidebarLabel(SIDEBAR, `${active} in progress · ${blocked} blocked`, {
    tone: blocked ? "warning" : undefined,
    rows: [
      { label: "Sprint", value: r.sprint.name },
      { label: "Board checks", value: n ? plural(n, "finding") : "Clean" },
      ...r.people.slice(0, 4).map((p) => ({
        label: p.name,
        value: `${p.items.length} open, ${p.items.filter((i) => i.blocked).length} blocked${p.lowPriority?.meets ? ", escalate" : ""}`,
      })),
    ],
  });
}

async function run(): Promise<Result | null> {
  try {
    const settings = await savedSettings.get();
    Object.assign(state, { settings, missing: missingSettings(settings) });
    if (state.missing.length) {
      Object.assign(state, { phase: "setup", result: null, error: null });
      return null;
    }
    state.running = true;
    // Still "setup" here would send the sidebar back into the stepper while the first check runs.
    if (state.phase === "setup") state.phase = "loading";
    publish();
    const result = await boardCheck(settings);
    await lastBoard.set(result.snapshot);
    ch.put("board", undefined, result.snapshot);
    Object.assign(state, { phase: "ready", result, error: null });
    return result;
  } catch (error) {
    if (error instanceof CliError && error.kind === "signed-out") Object.assign(state, { phase: "signed-out", error: failure(error) });
    else Object.assign(state, { phase: state.result ? "ready" : "error", error: failure(error) });
    return null;
  } finally {
    state.running = false;
    publish();
    void label();
  }
}

// A full check runs from a handful to a few dozen az calls, and a board changes slowly. A check from the last minute
// is fresh enough for Claude, and a call during a run joins it.
const checks = cached(run, { ttlMs: 60_000 });
const CHECK = "check";

/** Reads the board now, or joins the check that is running. */
export const refresh = () => checks.get(CHECK, { fresh: true });

/** The board check as text, for Claude. */
export async function boardText() {
  const result = await checks.get(CHECK);
  if (state.phase === "setup") throw new Error(`The sprint board isn't set up. Open its sidebar in Wings and fill in ${state.missing.join(", ")}.`);
  if (state.phase === "signed-out") throw new Error("az isn't signed in. Open the Sprint board sidebar in Wings and sign in.");
  if (!result) throw new Error(state.error ?? "The board check failed.");
  return asText(result);
}
