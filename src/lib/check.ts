import { az, counter, linked, loadStates, pool, PREDECESSOR, pullRequestIds, query, RELATED, relations, type Item } from "./azure";
import { itemUrl, list, lower, quote, validate, type Settings } from "./settings";

const NOT_COVERED = ["Blocked but not marked: it needs comments read and judged, so it's left to you."];

export interface Finding {
  id: number;
  title: string;
  url: string;
  check: string;
  problem: string;
  fix: string;
  dependency: boolean;
}

/** `az boards iteration team list`. */
interface IterationJson {
  name: unknown;
  path: unknown;
  attributes?: { startDate?: string | null; finishDate?: string | null };
}
/** `az boards area team list`. */
interface TeamAreaJson {
  values?: { value: unknown; includeChildren?: boolean }[];
}

// ---------- dates ----------

/** Weekdays after `iso`'s day up to and including today, in UTC. */
function workingDaysSince(iso: string, now: Date) {
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

/** Ticket numbers at the start of a Blocked By value, like "123, 456, no ticket: x", and the note after them. */
function blockedByParts(text: string) {
  const lead = text.match(/^\s*#?\d+(\s*[,;]?\s*#?\d+)*/)?.[0] ?? "";
  const ids = lead.match(/\d+/g)?.map(Number) ?? [];
  const rest = text.slice(lead.length).replace(/^[\s,;]+/, "");
  return { ids, rest };
}

/** Runs the whole board check. */
export async function boardCheck(s: Settings) {
  validate(s);
  counter.calls = 0;
  const started = Date.now();
  const now = new Date();
  const ci = (values: string[], v: string) => lower(values).includes(v.toLowerCase());

  // 1. The current sprint, and every item in it and the team's area.
  const [iterations, area] = await Promise.all([
    az<IterationJson[]>(["boards", "iteration", "team", "list", "--team", s.team, "--timeframe", "current", "--project", s.project], s),
    s.areaPath.trim() ? null : az<TeamAreaJson>(["boards", "area", "team", "list", "--team", s.team, "--project", s.project], s),
  ]);
  const iteration = iterations?.[0];
  if (!iteration) throw new Error(`${s.team} has no current sprint.`);
  const sprint = { name: String(iteration.name), path: String(iteration.path), start: iteration.attributes?.startDate ?? null, finish: iteration.attributes?.finishDate ?? null };
  // A team's area is a set of paths, each with or without its children, like the team's own board.
  const areas = s.areaPath.trim()
    ? [`[System.AreaPath] = ${quote(s.areaPath.trim())}`]
    : (area?.values ?? []).map((v) => `[System.AreaPath] ${v.includeChildren ? "UNDER" : "="} ${quote(String(v.value))}`);
  if (!areas.length) throw new Error(`${s.team} has no areas. Set the area path in Settings.`);
  const board = await query(
    `[System.TeamProject] = ${quote(s.project)} AND [System.IterationPath] = ${quote(sprint.path)} AND (${areas.join(" OR ")}) AND [System.State] <> 'Removed'`,
    s,
  );
  /** Every item read, by id. */
  const items = new Map<number, Item>(board.map((i) => [i.id, i]));
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
    s.scopeChildTypes.length ? children.filter((c) => ci(s.scopeChildTypes, c.type)).map((c) => c.parent as number) : stories.map((i) => i.id),
  );
  const scopeStories = stories.filter((i) => scopeStoryIds.has(i.id));
  const storyChildren = children.filter((c) => c.state !== "Removed" && ci(s.childTypes, c.type) && scopeStoryIds.has(c.parent as number));
  const isMember = (name: string | null) => !!name && ci(s.members, name);
  const prefixed = (title: string) => s.titlePrefixes.some((p) => p && title.trimStart().toLowerCase().startsWith(p.toLowerCase()));
  const otherItems = board.filter((i) => ci(s.itemTypes, i.type) && !scopeStoryIds.has(i.id) && (isMember(i.assignee) || prefixed(i.title)));
  const scoped = new Map([...scopeStories, ...storyChildren, ...otherItems].map((i) => [i.id, i]));

  // What the scope depends on: Blocked By tickets now; Predecessor and Related links once links are read.
  const depIds = new Set<number>();
  for (const i of scoped.values()) for (const id of blockedByParts(i.blockedBy).ids) depIds.add(id);

  const { category, firstOf, types } = await loadStates(s);
  const isReview = (i: Item) => ci(s.codeReviewStates, i.state);
  const isDone = (i: Item) => category(i) === "Completed";
  const isClosed = (i: Item) => ["Completed", "Removed"].includes(category(i)) || i.state === "Removed";
  const isActive = (i: Item) => ["InProgress", "Resolved"].includes(category(i));
  const prDecides = (i: Item) => isReview(i) || isDone(i);

  // Links: in-scope stories and other items always; children only when a PR decides their check.
  const needsLinks = [...scopeStories, ...otherItems, ...storyChildren.filter(prDecides)];
  const rels = new Map(await pool(needsLinks, async (i) => [i.id, await relations(i.id, s)] as const));
  for (const story of scopeStories) {
    const r = rels.get(story.id) ?? [];
    for (const id of [...linked(r, PREDECESSOR), ...linked(r, RELATED)]) depIds.add(id);
  }
  for (const id of scoped.keys()) depIds.delete(id);
  // Blockers of every board item are read too, so the board can show what's blocked. Only the scope's are checked.
  const boardBlockers = board.flatMap((i) => blockedByParts(i.blockedBy).ids);
  const unread = [...new Set([...depIds, ...boardBlockers])].filter((id) => !items.has(id));
  for (let i = 0; i < unread.length; i += 200) {
    for (const d of await query(`[System.Id] IN (${unread.slice(i, i + 200).join(", ")})`, s)) items.set(d.id, d);
  }
  const deps = [...depIds].map((id) => items.get(id)).filter((d): d is Item => !!d && d.state !== "Removed");
  const depLinks = deps.filter((d) => prDecides(d) && !rels.has(d.id));
  for (const [id, r] of await pool(depLinks, async (d) => [d.id, await relations(d.id, s)] as const)) rels.set(id, r);

  // Pull requests of everything whose state a PR decides.
  const prIds = new Set<number>();
  for (const [id, r] of rels) {
    const item = items.get(id);
    if (item && prDecides(item)) for (const pr of pullRequestIds(r)) prIds.add(pr);
  }
  const prs = new Map<number, { status: string; title: string }>(
    await pool([...prIds], async (id) => {
      const pr = await az<{ status?: unknown; title?: unknown }>(["repos", "pr", "show", "--id", String(id), "--detect", "false"], s);
      return [id, { status: String(pr?.status ?? ""), title: String(pr?.title ?? "") }] as const;
    }),
  );

  // 3. Checks.
  const findings: Finding[] = [];
  const add = (item: Item, check: string, problem: string, fix: string, dependency = false) =>
    findings.push({
      id: item.id, title: item.title, url: itemUrl(s, item.id), check, problem, dependency,
      fix: dependency ? `Ask ${item.assignee ?? "the owner"}: ${fix[0].toLowerCase()}${fix.slice(1)}` : fix,
    });
  const resolved = (id: number) => {
    const item = items.get(id);
    return !!item && isClosed(item);
  };
  const sprintStart = sprint.start ? Date.parse(sprint.start) : NaN;
  const ids = (xs: number[]) => xs.map((x) => `#${x}`).join(", ");

  /** Blocked By and PR checks, which dependencies get too. */
  function sharedChecks(item: Item, dependency: boolean) {
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
    const prList = (xs: { id: number }[]) => xs.map((p) => `!${p.id}`).join(", ");
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
  const isGoal = (i: Item) => !!goal && [i, i.parent ? items.get(i.parent) : undefined].some((x) => x && ci(x.tags, goal));
  const isBlocked = (i: Item) => {
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

  // The board as the sidebar lists it: every sprint item in the team's areas, with what the check learned.
  const flagged = new Map<number, string[]>();
  for (const f of findings) flagged.set(f.id, [...(flagged.get(f.id) ?? []), f.check]);
  const prsOf = (id: number) => pullRequestIds(rels.get(id) ?? []).map((pr) => ({ id: pr, status: prs.get(pr)?.status ?? "" }));
  const boardItems = board.map((i) => ({
    id: i.id, rev: i.rev, title: i.title.slice(0, 300), type: i.type, state: i.state, category: category(i),
    assignee: i.assignee, login: i.login, parent: i.parent && onBoard.has(i.parent) ? i.parent : null, tags: i.tags,
    blocked: isBlocked(i), blockedBy: i.blockedBy || null, comments: i.comments, prs: rels.has(i.id) ? prsOf(i.id) : null, checks: flagged.get(i.id) ?? [],
  }));
  const shownTypes = Object.fromEntries([...new Set(board.map((i) => i.type))].map((t) => [t, types.get(t) ?? { color: "#888888", states: [] }]));
  const snapshot = { checkedAt: now.toISOString(), sprint, items: boardItems, types: shownTypes };

  return {
    sprint,
    snapshot,
    checkedAt: now.toISOString(),
    findings,
    people,
    goalTag: goal || null,
    notCovered: [...NOT_COVERED, ...(goal ? [] : ["Blocked with only lower-priority work: set a goal tag to run it."])],
    stats: { azCalls: counter.calls, ms: Date.now() - started, board: board.length, scoped: scoped.size, dependencies: deps.length, pullRequests: prIds.size },
  };
}

export type Result = Awaited<ReturnType<typeof boardCheck>>;

/** The check as plain text, for Claude. */
export function asText(r: Result) {
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "?");
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
