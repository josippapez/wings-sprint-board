// Reads a team's current Azure DevOps sprint with `az` and checks the board's hygiene for the team's own scope.
// Read-only: it never changes a work item, comments or creates anything. Each finding carries a proposed fix
// for a person to apply. The sidebar gets what main/run.ts keeps as queries, so the board is read once however
// many pages show it, and Claude gets the same result from the board_check tool.

import { pollWhileFocused } from "wings-plugin-sdk/poll";
import { registerTools } from "wings-plugin-sdk/tools";

import { ch } from "./lib/messages";
import { savedSettings } from "./lib/settings";
import { boardOf, published, refresh } from "./main/run";
import { tools } from "./tools";

const POLL_MS = 15 * 60_000;

ch.serve("state", published);
ch.serve("board", boardOf);
ch.on("refresh", () => void refresh());
savedSettings.onChange(() => void refresh());
registerTools(tools);

void refresh();
pollWhileFocused(() => void refresh(), POLL_MS);
