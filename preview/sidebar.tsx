// The Sprint board sidebar with made-up data: the board, the checks, signed out, and before main has answered.
import type { Published, Snapshot } from "../src/lib/types";
import { DEFAULTS } from "../src/lib/settings";

export { default, page } from "../src/pages/sidebar";

const settings = { ...DEFAULTS, org: "https://dev.azure.com/example", project: "Web", team: "Web Team", members: ["Ada Lovelace"] };
const now = new Date().toISOString();
const color = { Story: "#009ccc", Task: "#f2cb1d", Bug: "#cc293d" };
const workflow = (type: string) => ({ color: color[type as keyof typeof color], states: [
  { name: "New", category: "Proposed", color: "#b2b2b2" },
  { name: "Active", category: "InProgress", color: "#007acc" },
  { name: "Closed", category: "Completed", color: "#339933" },
] });

const item = (id: number, title: string, type: string, state: string, category: string, extra: object = {}) => ({
  id, rev: 1, title, type, state, category, assignee: "Ada Lovelace", login: "ada@example.com", parent: null, tags: [], blocked: false,
  blockedBy: null, comments: 0, prs: null, checks: [], ...extra,
});

const snapshot: Snapshot = {
  checkedAt: now,
  sprint: { name: "Sprint 12", start: "2026-10-05T00:00:00Z", finish: "2026-10-16T00:00:00Z" },
  items: [
    item(101, "Sign-in page", "Story", "Active", "InProgress"),
    item(102, "Build the form", "Task", "Active", "InProgress", { parent: 101, comments: 2, prs: [{ id: 7, status: "active" }] }),
    item(103, "Wire up the API", "Task", "New", "Proposed", { parent: 101, blocked: true, blockedBy: "#150", checks: ["Blocked By resolved"] }),
    item(104, "Fix the logout redirect", "Bug", "Closed", "Completed", { assignee: null, login: null }),
    item(105, "Password reset", "Story", "New", "Proposed", { assignee: null, login: null }),
  ],
  types: { Story: workflow("Story"), Task: workflow("Task"), Bug: workflow("Bug") },
};

const { snapshot: _board, ...result } = {
  sprint: snapshot.sprint,
  snapshot,
  checkedAt: now,
  findings: [{ id: 103, title: "Wire up the API", url: "https://dev.azure.com/example/Web/_workitems/edit/103", check: "Blocked By resolved", problem: "#150 in Blocked By is closed.", fix: "Remove #150 from Blocked By.", dependency: false }],
  people: [{ name: "Ada Lovelace", items: [], lowPriority: null }],
  goalTag: null,
  notCovered: [],
  stats: { azCalls: 12, ms: 3000, board: 5, scoped: 3, dependencies: 0, pullRequests: 1 },
};

const ready: Published = { phase: "ready", settings, missing: [], result, error: null, running: false };

export const queries = { state: () => ready, board: () => snapshot };

// The project search's az query: items in other sprints and in none. The stub is installed after this module loads.
const found = [
  { id: 88, fields: { "System.Title": "Sign-in rate limit", "System.WorkItemType": "Story", "System.State": "New", "System.IterationPath": "Web" } },
  { id: 61, fields: { "System.Title": "Sign-in with a passkey", "System.WorkItemType": "Story", "System.State": "Closed", "System.IterationPath": "Web\\Sprint 9", "System.AssignedTo": { displayName: "Grace Hopper", uniqueName: "grace@example.com" } } },
  { id: 101, fields: { "System.Title": "Sign-in page", "System.WorkItemType": "Story", "System.State": "Active" } },
];
setTimeout(() => {
  const wings = (window as unknown as { wings: { exec: (program: string, args: string[]) => Promise<unknown> } }).wings;
  const sprints = ["Sprint 10", "Sprint 11", "Sprint 12", "Sprint 13"].map((name, n) => ({ name, path: `Web\\${name}`, attributes: { timeFrame: ["past", "past", "current", "future"][n] } }));
  wings.exec = async (_program, args) => ({ code: 0, stdout: args[1] === "query" ? JSON.stringify(found) : args[1] === "iteration" ? JSON.stringify(sprints) : "", stderr: "" });
});

export const states = {
  board: {},
  checks: { storage: { view: { tab: "checks" } } },
  search: { storage: { view: { tab: "board", q: "sign-in" } } },
  "other-sprint": { storage: { view: { tab: "board", sprint: "Web\\Sprint 11" } } },
  "signed-out": { queries: { state: (): Published => ({ ...ready, phase: "signed-out", result: null, error: "Please run 'az login' to setup account." }), board: () => null } },
  loading: { queries: {} },
};
