// Reads a team's current Azure DevOps sprint with `az` and checks the board's hygiene for the team's own scope.
// Read-only: it never changes a work item, comments or creates anything. Each finding carries a proposed fix
// for a person to apply. The sidebar draws what this script sends it with wings.broadcast, so the board is
// read once however many pages show it, and Claude gets the same result from the board_check tool.

import { SignedOut } from "./lib/azure";
import { asText, boardCheck, type Result } from "./lib/check";
import { DEFAULTS, loadSettings, missingSettings } from "./lib/settings";
import type { MainState } from "./lib/types";

// A full check runs from a handful to a few dozen az calls, and a board changes slowly. Refresh checks at once.
const POLL_MS = 15 * 60_000;
const SIDEBAR = "board";

// ---------- state shared with the sidebar ----------

const state: MainState = { phase: "loading", settings: DEFAULTS, missing: [], result: null, error: null, running: false };
let inFlight: Promise<Result | null> | null = null;

// The board itself goes through storage, which also keeps it for the next start; a broadcast is limited to 64 KB.
const publish = () => void wings.broadcast({ type: "state", state: { ...state, result: state.result && { ...state.result, snapshot: undefined } } });

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
      { label: "Board checks", value: n ? `${n} finding${n > 1 ? "s" : ""}` : "Clean" },
      ...r.people.slice(0, 4).map((p) => ({
        label: p.name,
        value: `${p.items.length} open, ${p.items.filter((i) => i.blocked).length} blocked${p.lowPriority?.meets ? ", escalate" : ""}`,
      })),
    ],
  });
}

/** Runs one check at a time; callers during a run share it. */
function refresh() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const settings = await loadSettings();
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
      await wings.storage.set("board", result.snapshot);
      Object.assign(state, { phase: "ready", result, error: null });
      return result;
    } catch (error) {
      if (error instanceof SignedOut) Object.assign(state, { phase: "signed-out", error: error.message });
      else Object.assign(state, { phase: state.result ? "ready" : "error", error: String((error as Error | null)?.message ?? error) });
      return null;
    } finally {
      state.running = false;
      inFlight = null;
      publish();
      void label();
    }
  })();
  return inFlight;
}

// The Node harness loads this file only to call boardCheck and asText, so it leaves these out.
if (!(globalThis as { harness?: unknown }).harness) {
  wings.onBroadcast((message) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (type === "hello") publish();
    if (type === "refresh" || type === "settings-changed") void refresh();
  });

  wings.onTool("board_check", async () => {
    // A check from the last minute is fresh enough; otherwise run one.
    const fresh = state.result && !state.running && Date.now() - Date.parse(state.result.checkedAt) < 60_000;
    const result = fresh ? state.result : await refresh();
    if (state.phase === "setup") throw new Error(`The sprint board isn't set up. Open its sidebar in Wings and fill in ${state.missing.join(", ")}.`);
    if (state.phase === "signed-out") throw new Error("az isn't signed in. Open the Sprint board sidebar in Wings and sign in.");
    if (!result) throw new Error(state.error ?? "The board check failed.");
    return asText(result);
  });

  void refresh();
  setInterval(refresh, POLL_MS);
}
