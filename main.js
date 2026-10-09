// @ts-check
/// <reference path="./wings.d.ts" />

// Reads a team's current Azure DevOps sprint with `az` and checks the board's hygiene for the team's own scope.
// Read-only: it never changes a work item, comments or creates anything. Each finding carries a proposed fix
// for a person to apply. The sidebar draws what this script sends it with wings.broadcast, so the board is
// read once however many pages show it, and Claude gets the same result from the board_check tool.

/** Settings start empty or with neutral defaults. Empty lists and fields turn their check off. */
const DEFAULTS = {
  org: "",
  project: "",
  team: "",
  /** Empty uses the team's areas. */
  areaPath: "",
  members: /** @type {string[]} */ ([]),
  storyTypes: ["User Story", "Product Backlog Item"],
  /** A story is in scope when it has a child of one of these types. Empty puts every story in scope. */
  scopeChildTypes: ["Task"],
  /** Children of an in-scope story that are checked too. */
  childTypes: ["Task", "Bug"],
  /** Other sprint items in scope when assigned to a team member or titled with one of the prefixes. */
  itemTypes: ["Bug"],
  titlePrefixes: /** @type {string[]} */ ([]),
  codeReviewStates: ["Code Review", "In Code Review"],
  blockedByField: "",
  goalTag: "",
  addedTags: /** @type {string[]} */ ([]),
  pointTypes: /** @type {string[]} */ ([]),
  pointFields: ["Microsoft.VSTS.Scheduling.StoryPoints"],
  parkedPrPrefix: "",
  staleDays: 3,
};

// A full check runs from a handful to a few dozen az calls, and a board changes slowly. Refresh checks at once.
const POLL_MS = 15 * 60_000;
const SIDEBAR = "board";
const PARALLEL = 6;
const NOT_COVERED = ["Blocked but not marked: it needs comments read and judged, so it's left to you."];

class SignedOut extends Error {}

/** @typedef {typeof DEFAULTS} Settings */
/**
 * @typedef {{ id: number, title: string, type: string, state: string, assignee: string | null, tags: string[],
 *   blockedBy: string, parent: number | null, iteration: string, changed: string, created: string,
 *   points: (number | null)[] }} Item
 */
/** @typedef {{ id: number, title: string, url: string, check: string, problem: string, fix: string, dependency: boolean }} Finding */

/** @returns {Promise<Settings>} */
async function loadSettings() {
  const saved = await wings.storage.get("settings");
  return { ...DEFAULTS, ...(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}) };
}

/** What's still missing before a check can run. @param {Settings} s */
const missingSettings = (s) =>
  [["Organization", s.org], ["Project", s.project], ["Team", s.team], ["Team members", s.members.length ? "x" : ""]]
    .filter(([, v]) => !String(v).trim())
    .map(([name]) => name);

const REF_NAME = /^[A-Za-z][\w.]*$/;

/** Throws when a setting would break a query, since they go into WIQL and az arguments. @param {Settings} s */
function validate(s) {
  if (!/^https:\/\/dev\.azure\.com\/[\w.-]+\/?$/.test(s.org)) throw new Error("Organization must look like https://dev.azure.com/<name>.");
  for (const field of [s.blockedByField, ...s.pointFields].filter(Boolean)) {
    if (!REF_NAME.test(field)) throw new Error(`"${field}" isn't a field reference name like Custom.MyField.`);
  }
  for (const [name, value] of Object.entries({ project: s.project, team: s.team, areaPath: s.areaPath })) {
    // Wings refuses az arguments starting with "-" or "@".
    if (/^[-@]/.test(value)) throw new Error(`${name} can't start with - or @.`);
  }
}

const org = (/** @type {Settings} */ s) => s.org.replace(/\/+$/, "");
const itemUrl = (/** @type {Settings} */ s, /** @type {number} */ id) => `${org(s)}/${encodeURIComponent(s.project)}/_workitems/edit/${id}`;
const quote = (/** @type {string} */ value) => `'${value.replace(/'/g, "''")}'`;
const list = (/** @type {string[]} */ values) => values.map(quote).join(", ");
const lower = (/** @type {string[]} */ values) => values.map((v) => v.toLowerCase());

// ---------- az ----------

/** Counts az calls in the current check, for the report. */
let calls = 0;

/** Runs a read-only az command and parses its JSON. @param {string[]} args @param {Settings} s */
async function az(args, s, timeoutMs = 60_000) {
  calls++;
  const out = await wings.exec("az", [...args, "--organization", org(s), "-o", "json"], { timeoutMs });
  if (out.code !== 0) {
    const message = out.stderr.trim().split("\n").filter((l) => l && !/^WARNING/.test(l)).at(-1) || `az exited with ${out.code}`;
    if (/login/i.test(out.stderr)) throw new SignedOut(message);
    throw new Error(message);
  }
  return out.stdout.trim() ? JSON.parse(out.stdout) : null;
}

/** Runs fn over items, a few at a time. @template T, R @param {T[]} items @param {(item: T) => Promise<R>} fn @returns {Promise<R[]>} */
async function pool(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return results;
}

const fields = (/** @type {Settings} */ s) =>
  [
    "System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "System.Tags",
    "System.Parent", "System.IterationPath", "System.ChangedDate", "System.CreatedDate",
    ...(s.blockedByField ? [s.blockedByField] : []), ...s.pointFields,
  ].map((f) => `[${f}]`).join(", ");

/** A flat WIQL query. `az boards query` reads the selected fields itself, 200 ids per request. @param {string} where @param {Settings} s @returns {Promise<Item[]>} */
async function query(where, s) {
  const wiql = `SELECT ${fields(s)} FROM WorkItems WHERE ${where}`;
  const rows = (await az(["boards", "query", "--wiql", wiql, "--project", s.project], s)) ?? [];
  return rows.map((/** @type {any} */ row) => toItem(row, s));
}

/** @param {any} row @param {Settings} s @returns {Item} */
function toItem(row, s) {
  const f = row.fields ?? {};
  return {
    id: row.id,
    title: String(f["System.Title"] ?? ""),
    type: String(f["System.WorkItemType"] ?? ""),
    state: String(f["System.State"] ?? ""),
    assignee: f["System.AssignedTo"]?.displayName ?? null,
    tags: String(f["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean),
    blockedBy: s.blockedByField ? String(f[s.blockedByField] ?? "").trim() : "",
    parent: typeof f["System.Parent"] === "number" ? f["System.Parent"] : null,
    iteration: String(f["System.IterationPath"] ?? ""),
    changed: String(f["System.ChangedDate"] ?? ""),
    created: String(f["System.CreatedDate"] ?? ""),
    points: s.pointFields.map((p) => (typeof f[p] === "number" ? f[p] : null)),
  };
}

/** The item's links, one `az boards work-item show` each: az has no batch read that keeps relations. @param {number} id @param {Settings} s */
async function relations(id, s) {
  const item = await az(["boards", "work-item", "show", "--id", String(id), "--expand", "relations"], s);
  return /** @type {{ rel: string, url: string }[]} */ (item?.relations ?? []);
}

/** Pull request ids from ArtifactLinks like vstfs:///Git/PullRequestId/{projectId}%2F{repositoryId}%2F{prId}. */
function pullRequestIds(/** @type {{ rel: string, url: string }[]} */ rels) {
  return rels
    .filter((r) => r.rel === "ArtifactLink" && /^vstfs:\/\/\/Git\/PullRequestId\//i.test(r.url))
    .map((r) => Number(decodeURIComponent(r.url).split("/").at(-1)))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Work item ids a relation of this kind points to. @param {{ rel: string, url: string }[]} rels @param {string} rel */
const linked = (rels, rel) => rels.filter((r) => r.rel === rel).map((r) => Number(r.url.split("/").at(-1))).filter(Number.isInteger);
const PREDECESSOR = "System.LinkTypes.Dependency-Reverse";
const RELATED = "System.LinkTypes.Related";

/** Each project's work item types, with their states in board order and each state's category (Proposed, InProgress, Resolved, Completed, Removed). Kept per project, since a process rarely changes. @type {Map<string, Map<string, { name: string, category: string }[]>>} */
const typeStates = new Map();

/** One call reads every type of the project with its states. @param {Settings} s */
async function loadStates(s) {
  const key = `${s.org}|${s.project}`;
  if (!typeStates.has(key)) {
    const out = await az(["devops", "invoke", "--area", "wit", "--resource", "workItemTypes", "--route-parameters", `project=${s.project}`, "--api-version", "7.1"], s);
    const types = new Map((out?.value ?? []).map((/** @type {any} */ t) => [String(t.name), (t.states ?? []).map((/** @type {any} */ x) => ({ name: String(x.name), category: String(x.category) }))]));
    typeStates.set(key, types);
  }
  const types = /** @type {Map<string, { name: string, category: string }[]>} */ (typeStates.get(key));
  /** @param {{ type: string, state: string }} item */
  const category = (item) => types.get(item.type)?.find((x) => x.name === item.state)?.category ?? "";
  /** The first state of a type in this category, like "In Progress". @param {string} type @param {string} cat */
  const firstOf = (type, cat) => types.get(type)?.find((x) => x.category === cat)?.name ?? null;
  return { category, firstOf };
}

// ---------- dates ----------

/** Weekdays after `iso`'s day up to and including today, in UTC. @param {string} iso @param {Date} now */
function workingDaysSince(iso, now) {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return 0;
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let n = 0;
  for (day.setUTCDate(day.getUTCDate() + 1); day.getTime() <= today; day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) n++;
  }
  return n;
}

// ---------- the check ----------

/** Ticket numbers at the start of a Blocked By value, like "123, 456, no ticket: x", and the note after them. @param {string} text */
function blockedByParts(text) {
  const lead = text.match(/^\s*#?\d+(\s*[,;]?\s*#?\d+)*/)?.[0] ?? "";
  const ids = lead.match(/\d+/g)?.map(Number) ?? [];
  const rest = text.slice(lead.length).replace(/^[\s,;]+/, "");
  return { ids, rest };
}

/** Runs the whole board check. @param {Settings} s */
async function boardCheck(s) {
  validate(s);
  calls = 0;
  const started = Date.now();
  const now = new Date();
  const ci = (/** @type {string[]} */ values, /** @type {string} */ v) => lower(values).includes(v.toLowerCase());

  // 1. The current sprint, and every item in it and the team's area.
  const [iterations, area] = await Promise.all([
    az(["boards", "iteration", "team", "list", "--team", s.team, "--timeframe", "current", "--project", s.project], s),
    s.areaPath.trim() ? null : az(["boards", "area", "team", "list", "--team", s.team, "--project", s.project], s),
  ]);
  const iteration = iterations?.[0];
  if (!iteration) throw new Error(`${s.team} has no current sprint.`);
  const sprint = { name: String(iteration.name), path: String(iteration.path), start: iteration.attributes?.startDate ?? null, finish: iteration.attributes?.finishDate ?? null };
  // A team's area is a set of paths, each with or without its children, like the team's own board.
  const areas = s.areaPath.trim()
    ? [`[System.AreaPath] = ${quote(s.areaPath.trim())}`]
    : (area?.values ?? []).map((/** @type {any} */ v) => `[System.AreaPath] ${v.includeChildren ? "UNDER" : "="} ${quote(String(v.value))}`);
  if (!areas.length) throw new Error(`${s.team} has no areas. Set the area path in Settings.`);
  const board = await query(
    `[System.TeamProject] = ${quote(s.project)} AND [System.IterationPath] = ${quote(sprint.path)} AND (${areas.join(" OR ")}) AND [System.State] <> 'Removed'`,
    s,
  );
  /** Every item read, by id. @type {Map<number, Item>} */
  const items = new Map(board.map((i) => [i.id, i]));
  const onBoard = new Set(board.map((i) => i.id));

  // 2. The team's scope. az boards query runs only flat queries, so instead of a WorkItemLinks query the
  // stories' children are read by their Parent field.
  const stories = board.filter((i) => ci(s.storyTypes, i.type));
  const childTypes = [...new Set([...s.scopeChildTypes, ...s.childTypes])];
  const children = stories.length && childTypes.length
    ? await query(`[System.WorkItemType] IN (${list(childTypes)}) AND [System.Parent] IN (${stories.map((i) => i.id).join(", ")})`, s)
    : [];
  for (const c of children) if (!items.has(c.id)) items.set(c.id, c);
  const scopeStoryIds = new Set(
    s.scopeChildTypes.length ? children.filter((c) => ci(s.scopeChildTypes, c.type)).map((c) => /** @type {number} */ (c.parent)) : stories.map((i) => i.id),
  );
  const scopeStories = stories.filter((i) => scopeStoryIds.has(i.id));
  const storyChildren = children.filter((c) => c.state !== "Removed" && ci(s.childTypes, c.type) && scopeStoryIds.has(/** @type {number} */ (c.parent)));
  const isMember = (/** @type {string | null} */ name) => !!name && ci(s.members, name);
  const prefixed = (/** @type {string} */ title) => s.titlePrefixes.some((p) => p && title.trimStart().toLowerCase().startsWith(p.toLowerCase()));
  const otherItems = board.filter((i) => ci(s.itemTypes, i.type) && !scopeStoryIds.has(i.id) && (isMember(i.assignee) || prefixed(i.title)));
  const scoped = new Map([...scopeStories, ...storyChildren, ...otherItems].map((i) => [i.id, i]));

  // What the scope depends on: Blocked By tickets now; Predecessor and Related links once links are read.
  const depIds = new Set();
  for (const i of scoped.values()) for (const id of blockedByParts(i.blockedBy).ids) depIds.add(id);

  const { category, firstOf } = await loadStates(s);
  const isReview = (/** @type {Item} */ i) => ci(s.codeReviewStates, i.state);
  const isDone = (/** @type {Item} */ i) => category(i) === "Completed";
  const isClosed = (/** @type {Item} */ i) => ["Completed", "Removed"].includes(category(i)) || i.state === "Removed";
  const isActive = (/** @type {Item} */ i) => ["InProgress", "Resolved"].includes(category(i));
  const prDecides = (/** @type {Item} */ i) => isReview(i) || isDone(i);

  // Links: in-scope stories and other items always; children only when a PR decides their check.
  const needsLinks = [...scopeStories, ...otherItems, ...storyChildren.filter(prDecides)];
  const rels = new Map(await pool(needsLinks, async (i) => /** @type {const} */ ([i.id, await relations(i.id, s)])));
  for (const story of scopeStories) {
    const r = rels.get(story.id) ?? [];
    for (const id of [...linked(r, PREDECESSOR), ...linked(r, RELATED)]) depIds.add(id);
  }
  for (const id of scoped.keys()) depIds.delete(id);
  const unread = [...depIds].filter((id) => !items.has(id));
  for (let i = 0; i < unread.length; i += 200) {
    for (const d of await query(`[System.Id] IN (${unread.slice(i, i + 200).join(", ")})`, s)) items.set(d.id, d);
  }
  const deps = /** @type {Item[]} */ ([...depIds].map((id) => items.get(id)).filter((d) => d && d.state !== "Removed"));
  const depLinks = deps.filter((d) => prDecides(d) && !rels.has(d.id));
  for (const [id, r] of await pool(depLinks, async (d) => /** @type {const} */ ([d.id, await relations(d.id, s)]))) rels.set(id, r);

  // Pull requests of everything whose state a PR decides.
  const prIds = new Set();
  for (const [id, r] of rels) {
    const item = items.get(id);
    if (item && prDecides(item)) for (const pr of pullRequestIds(r)) prIds.add(pr);
  }
  /** @type {Map<number, { status: string, title: string }>} */
  const prs = new Map(
    await pool([...prIds], async (id) => {
      const pr = await az(["repos", "pr", "show", "--id", String(id), "--detect", "false"], s);
      return /** @type {const} */ ([id, { status: String(pr?.status ?? ""), title: String(pr?.title ?? "") }]);
    }),
  );

  // 3. Checks.
  /** @type {Finding[]} */
  const findings = [];
  /** @param {Item} item @param {string} check @param {string} problem @param {string} fix */
  const add = (item, check, problem, fix, dependency = false) =>
    findings.push({
      id: item.id, title: item.title, url: itemUrl(s, item.id), check, problem, dependency,
      fix: dependency ? `Ask ${item.assignee ?? "the owner"}: ${fix[0].toLowerCase()}${fix.slice(1)}` : fix,
    });
  const resolved = (/** @type {number} */ id) => {
    const item = items.get(id);
    return !!item && isClosed(item);
  };
  const sprintStart = sprint.start ? Date.parse(sprint.start) : NaN;
  const ids = (/** @type {number[]} */ xs) => xs.map((x) => `#${x}`).join(", ");

  /** Blocked By and PR checks, which dependencies get too. @param {Item} item @param {boolean} dependency */
  function sharedChecks(item, dependency) {
    if (item.blockedBy) {
      const { ids: blockers, rest } = blockedByParts(item.blockedBy);
      // A short "no ... ticket" note is fine on its own: it says what's missing has no ticket yet.
      if (blockers.length === 0 && !/^no\b.*\bticket\b/i.test(rest)) {
        const preds = linked(rels.get(item.id) ?? [], PREDECESSOR);
        add(item, "Blocked By not a ticket", `Blocked By is "${item.blockedBy}", not a ticket number.`,
          `Put the blocking ticket number first, or a short "no ticket: <what is missing>" note.${preds.length ? ` Its Predecessor links: ${ids(preds)}.` : ""} If no single ticket matches, ask the owner.`, dependency);
      } else if (blockers.length) {
        const closed = blockers.filter(resolved);
        if (closed.length === blockers.length && !rest) {
          add(item, "Blocked By resolved", `Blocked By names ${blockers.map((id) => `#${id} (${items.get(id)?.state})`).join(", ")}, all closed.`, "Clear Blocked By.", dependency);
        } else if (closed.length) {
          add(item, "Blocked By resolved", `${ids(closed)} in Blocked By ${closed.length > 1 ? "are" : "is"} closed.`, `Remove ${ids(closed)} from Blocked By.`, dependency);
        }
      }
    }
    const linkedPrs = pullRequestIds(rels.get(item.id) ?? []).map((id) => ({ id, ...(prs.get(id) ?? { status: "", title: "" }) }));
    // A PR parked on purpose takes the item out of this check.
    if (s.parkedPrPrefix && linkedPrs.some((p) => p.title.toLowerCase().startsWith(s.parkedPrPrefix.toLowerCase()))) return;
    const prList = (/** @type {{ id: number }[]} */ xs) => xs.map((p) => `!${p.id}`).join(", ");
    if (isReview(item)) {
      if (linkedPrs.length === 0) {
        add(item, "Status ahead of the PR", `${item.state} with no linked pull request.`, "Link the PR, or move it back to the working state.", dependency);
      } else if (!linkedPrs.some((p) => p.status === "active")) {
        const merged = linkedPrs.filter((p) => p.status === "completed");
        add(item, "Status ahead of the PR",
          merged.length ? `${item.state}, but PR ${prList(merged)} is completed.` : `${item.state}, but PR ${prList(linkedPrs)} is abandoned.`,
          merged.length ? "Move it on to the state after review." : "Link the new PR, or move it back to the working state.", dependency);
      }
    } else if (isDone(item)) {
      const open = linkedPrs.filter((p) => p.status === "active");
      if (open.length) add(item, "Status ahead of the PR", `${item.state}, but PR ${prList(open)} is still active.`, "Complete or abandon the PR, or move the item back to review.", dependency);
    }
  }

  for (const item of scoped.values()) {
    sharedChecks(item, false);
    if (scopeStoryIds.has(item.id)) {
      const kids = storyChildren.filter((c) => c.parent === item.id);
      const started = kids.filter((c) => isActive(c) || isDone(c));
      if (category(item) === "Proposed" && started.length) {
        add(item, "Status behind the work", `${item.state}, but ${started.map((c) => `#${c.id} is ${c.state}`).join(", ")}.`, `Move the story to ${firstOf(item.type, "InProgress") ?? "in progress"}.`);
      } else if (item.state === firstOf(item.type, "InProgress") && kids.length && kids.every(isDone)) {
        add(item, "Status behind the work", `${item.state}, but all ${kids.length} of its tasks are done.`, "Move the story on, or add the task that's still open.");
      }
    }
    if (isActive(item) && !item.assignee) add(item, "In progress, nobody on it", `${item.state} with nobody assigned.`, "Assign whoever is working on it, or move it back.");
    const idle = workingDaysSince(item.changed, now);
    if (isActive(item) && idle >= s.staleDays) add(item, "Stale", `${item.state}, no change in ${idle} working days.`, "Report only.");
    const topLevel = !(item.parent && onBoard.has(item.parent));
    if (topLevel && Date.parse(item.created) > sprintStart) {
      const missing = s.addedTags.filter((t) => t && !ci(item.tags, t));
      if (missing.length) add(item, "Added without tags", `Created after the sprint started, without ${missing.map((t) => `"${t}"`).join(" or ")}.`, `Add ${missing.join("; ")}.`);
      // Spikes are sized by time, not points.
      if (ci(s.pointTypes, item.type) && s.pointFields.length && !/\bspike\b/i.test(item.title)) {
        const values = item.points;
        if (values.some((v) => !v) || new Set(values).size > 1) {
          add(item, "Missing points", s.pointFields.map((f, i) => `${f.split(".").at(-1)} ${values[i] ?? "empty"}`).join(", ") + ".",
            s.pointFields.length > 1 ? "Set them to the same number." : "Set the points.");
        }
      }
    }
  }
  for (const d of deps) sharedChecks(d, true);

  // 4 and 5. Who is working on what, and who is blocked with only lower-priority work left.
  const goal = s.goalTag.trim();
  const isGoal = (/** @type {Item} */ i) => !!goal && [i, i.parent ? items.get(i.parent) : undefined].some((x) => x && ci(x.tags, goal));
  const isBlocked = (/** @type {Item} */ i) => {
    if (!i.blockedBy) return false;
    const { ids: blockers, rest } = blockedByParts(i.blockedBy);
    return !!rest || blockers.some((id) => !resolved(id));
  };
  const pickable = [...scoped.values()].filter((i) => !ci(s.storyTypes, i.type) && !i.assignee && !isClosed(i) && isGoal(i) && !isBlocked(i));
  const people = s.members.map((name) => {
    const open = [...items.values()]
      .filter((i) => i.iteration === sprint.path && i.assignee?.toLowerCase() === name.toLowerCase() && !isClosed(i))
      .map((i) => ({ id: i.id, title: i.title, url: itemUrl(s, i.id), type: i.type, state: i.state, goal: isGoal(i), blocked: isBlocked(i), blockedBy: i.blockedBy || null }));
    if (!goal) return { name, items: open, lowPriority: null };
    const lowOnly = open.every((i) => i.blocked || !i.goal);
    const reason = !lowOnly
      ? `Has unblocked goal work: ${ids(open.filter((i) => !i.blocked && i.goal).map((i) => i.id))}.`
      : pickable.length
        ? `Only blocked or non-goal work, but unassigned goal work is free to pick up: ${ids(pickable.map((i) => i.id))}.`
        : `${open.length ? "Every open item is blocked or not goal work" : "No open items"}, and no unassigned goal work is left. Worth escalating.`;
    return { name, items: open, lowPriority: { meets: lowOnly && pickable.length === 0, reason } };
  });

  return {
    sprint,
    checkedAt: now.toISOString(),
    findings,
    people,
    goalTag: goal || null,
    notCovered: [...NOT_COVERED, ...(goal ? [] : ["Blocked with only lower-priority work: set a goal tag to run it."])],
    stats: { azCalls: calls, ms: Date.now() - started, board: board.length, scoped: scoped.size, dependencies: deps.length, pullRequests: prIds.size },
  };
}

/** @typedef {Awaited<ReturnType<typeof boardCheck>>} Result */

/** The check as plain text, for Claude. @param {Result} r */
function asText(r) {
  const day = (/** @type {string | null} */ iso) => (iso ? iso.slice(0, 10) : "?");
  const lines = [`Sprint ${r.sprint.name} (${day(r.sprint.start)} to ${day(r.sprint.finish)}), checked ${r.checkedAt}. Read-only: nothing was changed, the fixes are proposals.`, ""];
  if (r.findings.length === 0) lines.push("Board is clean.");
  else {
    lines.push(`Findings (${r.findings.length}):`);
    for (const f of r.findings) lines.push(`- #${f.id} ${f.title}${f.dependency ? " (dependency)" : ""} [${f.check}] ${f.problem} Proposed fix: ${f.fix} ${f.url}`);
  }
  lines.push("", "Who is working on what:");
  for (const p of r.people) {
    const items = p.items.map((i) => `#${i.id} ${i.title} (${i.state}${i.goal ? ", goal" : ""}${i.blocked ? `, blocked: ${i.blockedBy}` : ""})`);
    lines.push(`- ${p.name}: ${items.length ? items.join("; ") : "no open items"}`);
  }
  if (r.goalTag) {
    lines.push("", "Blocked with only lower-priority work:");
    for (const p of r.people) lines.push(`- ${p.name}: ${p.lowPriority?.meets ? "yes" : "no"}. ${p.lowPriority?.reason ?? ""}`);
  }
  lines.push("", `Not covered: ${r.notCovered.join(" ")}`);
  return lines.join("\n");
}

// ---------- state shared with the sidebar ----------

/** @type {{ phase: "loading" | "setup" | "signed-out" | "error" | "ready", settings: Settings, missing: string[], result: Result | null, error: string | null, running: boolean }} */
const state = { phase: "loading", settings: DEFAULTS, missing: [], result: null, error: null, running: false };
/** @type {Promise<Result | null> | null} */
let inFlight = null;

const publish = () => void wings.broadcast({ type: "state", state });

function label() {
  const r = state.result;
  if (state.phase === "signed-out") return wings.setSidebarLabel(SIDEBAR, "Sign in", { tone: "warning" });
  if (state.phase !== "ready" || !r) return wings.setSidebarLabel(SIDEBAR, null);
  const n = r.findings.length;
  return wings.setSidebarLabel(SIDEBAR, n ? `${n} finding${n > 1 ? "s" : ""}` : "Clean", {
    tone: n ? "warning" : undefined,
    rows: [
      { label: "Sprint", value: r.sprint.name },
      ...r.people.slice(0, 5).map((p) => ({
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
      publish();
      const result = await boardCheck(settings);
      Object.assign(state, { phase: "ready", result, error: null });
      return result;
    } catch (error) {
      if (error instanceof SignedOut) Object.assign(state, { phase: "signed-out", error: error.message });
      else Object.assign(state, { phase: state.result ? "ready" : "error", error: String(/** @type {any} */ (error)?.message ?? error) });
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
if (!(/** @type {any} */ (globalThis).harness)) {
  wings.onBroadcast((message) => {
    const type = /** @type {any} */ (message)?.type;
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
