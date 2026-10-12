// Settings for the Sprint board sidebar: works out as much as it can with read-only az and git calls, shows
// it for one click, and offers pickers to correct any of it. sidebar.tsx draws the board and calls
// renderSettings, openSettings and maybeDetect from here.

import { counter, metaOf, meOf, need, orgUrl, projectsOf, safeArg, sprintOf, teamMembersOf, validOrg, want, type Loaded, type Person, type ProjectMeta, type SprintData, type SprintItem } from "./lists";
import { page, render } from "./page";
import type { Settings } from "./settings";

/** Categories of types that aren't board work, like test cases and code review requests. */
const NOT_WORK = /Hidden|Test|SharedStep|SharedParameter|CodeReview|Feedback|Epic|Feature/;

/** The settings form's values while it's open. Typing in Working days leaves text in staleDays until it's saved. */
export type Draft = Partial<Omit<Settings, "staleDays">> & { staleDays?: number | string };
/** The settings keys that hold one text value or a list of them. */
export type TextKey = "org" | "project" | "team" | "areaPath" | "blockedByField" | "goalTag" | "parkedPrPrefix";
export type ListKey = "members" | "storyTypes" | "scopeChildTypes" | "childTypes" | "itemTypes" | "titlePrefixes" | "codeReviewStates" | "addedTags" | "pointTypes" | "pointFields";

export const setup = {
  /** The settings form's values while it's open. */
  draft: null as Draft | null,
  /** Text typed into "Other…" fields, by setting key. */
  other: {} as Record<string, string>,
  /** What each checkbox list had ticked when the form opened. Those go first, and stay put while you tick. */
  tickedFirst: {} as Record<string, Set<string>>,
  detecting: null as { step: string } | null,
  detection: null as { notes: string[]; off: string[]; calls: number; ms: number } | null,
  detectError: null as string | null,
  panes: null as WingsPane[] | null,
  /** Azure DevOps repos open in Wings, most panes first. */
  repos: [] as { org: string; project: string; panes: number }[],
  /** The step on screen. */
  step: 0,
  /** An element to focus once the next render is on screen, like a new step's question. */
  focusAfterRender: null as string | null,
};

// ---------- open repos ----------

/** Same patterns as Wings' pr-tracker. A visualstudio.com organization is the same one at dev.azure.com. */
function azureRemote(url: string) {
  let m = url.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) m = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/);
  if (!m) m = url.match(/([^/.@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?$/);
  return m ? { org: `https://dev.azure.com/${m[1]}`, project: decodeURIComponent(m[2]) } : null;
}

/** Remotes by folder, read once each. */
const remotes = new Map<string, Promise<{ org: string; project: string } | null>>();

async function findRepos() {
  const cwds = [...new Set((setup.panes ?? []).map((p) => String(p.cwd)).filter(Boolean))].slice(0, 12);
  const found = await Promise.all(
    cwds.map((cwd) => {
      if (!remotes.has(cwd)) {
        remotes.set(cwd, wings.exec("git", ["remote", "get-url", "origin"], { cwd }).then((out) => (out.code === 0 ? azureRemote(out.stdout.trim()) : null), () => null));
      }
      return remotes.get(cwd);
    }),
  );
  const counts = new Map<string, { org: string; project: string; panes: number }>();
  for (const r of found) {
    if (!r) continue;
    const key = `${r.org}|${r.project}`;
    counts.set(key, { ...r, panes: (counts.get(key)?.panes ?? 0) + 1 });
  }
  setup.repos = [...counts.values()].sort((a, b) => b.panes - a.panes);
}

// ---------- detection ----------

/** Counts of each value, most common first. */
export function counted(values: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Fills the form with what can be worked out. Keeps an organization, project and team already picked. */
export async function detect() {
  setup.detecting = { step: "Looking for Azure DevOps repos open in Wings…" };
  setup.detectError = null;
  render();
  counter.calls = 0;
  const started = Date.now();
  const base: Draft = setup.draft ?? {};
  const notes: string[] = [];
  const off: string[] = [];
  try {
    await findRepos();
    const repos = setup.repos;
    const repo = repos[0];
    const org = validOrg(base.org ?? "") ? orgUrl(base.org ?? "") : repo?.org ?? "";
    const project = base.project?.trim() || (repo && repo.org === org ? repo.project : "");
    if (!org || !project) {
      notes.push("No Azure DevOps repo is open in Wings. Pick the organization and project, then detect again.");
      return finish({ ...defaultsFrom(base), org, project }, notes, off, started);
    }
    notes.push(base.project?.trim() ? `Project as picked: ${project}.` : `From your open repos: ${project}${repos.length > 1 ? ` (${repos.length - 1} other repo${repos.length > 2 ? "s" : ""} found)` : ""}.`);

    setup.detecting!.step = "Reading the project's teams, types and fields…";
    render();
    const meta = await need(`meta|${org}|${project}`, metaOf(org, project));
    let team = base.team?.trim() || "";
    if (!team) {
      // Of your teams with a current sprint, the one with the most items, then the most of them yours.
      const [me, sprints] = await Promise.all([
        need("me", meOf()).catch(() => ""),
        Promise.all(meta.myTeams.slice(0, 5).map((t) => need(`sprint|${org}|${project}|${t}`, sprintOf(org, project, t)).then((d) => ({ t, d }), () => null))),
      ]);
      const mine = (d: SprintData) => d.items.filter((i) => !!me && i.assigneeLogin?.toLowerCase() === me.toLowerCase()).length;
      const best = sprints.filter((x) => !!x).sort((a, b) => b.d.items.length - a.d.items.length || mine(b.d) - mine(a.d))[0];
      team = best?.t ?? "";
      notes.push(
        team
          ? `From the teams you're in: ${team}${meta.myTeams.length > 1 ? ` (1 of ${meta.myTeams.length}, the one with the most sprint items; change it below)` : ""}.`
          : meta.myTeams.length
            ? "None of your teams has a current sprint. Pick a team, then detect again."
            : "You're not in a team of this project. Pick a team, then detect again.",
      );
    }
    if (!team) return finish({ ...defaultsFrom(base), org, project }, notes, off, started);

    setup.detecting!.step = "Reading the team's current sprint…";
    render();
    const [data, members, me] = await Promise.all([
      need(`sprint|${org}|${project}|${team}`, sprintOf(org, project, team)),
      need(`members|${org}|${project}|${team}`, teamMembersOf(org, project, team)),
      need("me", meOf()).catch(() => ""),
    ]);
    const settings = infer(meta, data, members, me, notes, off);
    return finish({ ...settings, org, project, team, areaPath: base.areaPath ?? "" }, notes, off, started);
  } catch (error) {
    setup.detectError = String((error as Error | null)?.message ?? error);
    if ((error as { login?: boolean } | null)?.login) setup.detectError = `az isn't signed in. ${setup.detectError}`;
    setup.detecting = null;
    if (!setup.draft) setup.draft = defaultsFrom(page.main?.settings ?? {});
    render();
  }
}

const defaultsFrom = (s: Draft): Draft => ({ ...(page.main?.settings ?? {}), ...s });

function finish(settings: Draft, notes: string[], off: string[], started: number) {
  setup.draft = settings;
  setup.step = 0;
  setup.focusAfterRender = "step-question";
  setup.other = {};
  setup.tickedFirst = {};
  setup.detection = { notes, off, calls: counter.calls, ms: Date.now() - started };
  setup.detecting = null;
  render();
}

/** Works out the scope and rules from the project and the sprint. */
function infer(meta: ProjectMeta, data: SprintData, teamMembers: Person[], me: string, notes: string[], off: string[]): Draft {
  const items = data.items;
  const requirement = meta.categories.get("Microsoft.RequirementCategory") ?? [];
  const notWork = new Set([...meta.categories.entries()].filter(([ref]) => NOT_WORK.test(ref)).flatMap(([, types]) => types));
  const present = new Set(items.map((i) => i.type));
  const storyTypes = requirement.filter((t) => present.has(t)).length ? requirement.filter((t) => present.has(t)) : requirement;
  const storyIds = new Set(items.filter((i) => storyTypes.includes(i.type)).map((i) => i.id));
  const kids = items.filter((i) => i.parent && storyIds.has(i.parent));
  const childTypes = counted(kids.map((i) => i.type)).map(([t]) => t);

  // Members: you. Teammates are added on purpose.
  const meName = me ? (items.find((i) => i.assigneeLogin?.toLowerCase() === me.toLowerCase())?.assignee ?? teamMembers.find((m) => m.login.toLowerCase() === me.toLowerCase())?.name ?? null) : null;
  const members = meName ? [meName] : [];

  const mine = kids.filter((i) => i.assignee && members.includes(i.assignee));
  const scopeChildTypes = counted(mine.map((i) => i.type)).map(([t]) => t);
  const topLevel = items.filter((i) => !(i.parent && storyIds.has(i.parent)) && !storyTypes.includes(i.type) && !notWork.has(i.type));
  const itemTypes = counted(topLevel.map((i) => i.type)).map(([t]) => t).filter((t) => !childTypes.includes(t) || topLevel.some((i) => i.type === t));

  const checkedTypes = new Set([...storyTypes, ...childTypes, ...itemTypes]);
  const states = [...new Set(meta.types.filter((t) => checkedTypes.has(t.name)).flatMap((t) => t.states.map((s) => s.name)))];
  const codeReviewStates = states.filter((s) => /code\s*review/i.test(s)).length ? states.filter((s) => /code\s*review/i.test(s)) : states.filter((s) => /review/i.test(s));

  const isSet = (i: SprintItem, f: string) => i.values[f] != null && String(i.values[f]).trim() !== "";
  const blockedByField = [...data.blockFields].sort((a, b) => items.filter((i) => isSet(i, b)).length - items.filter((i) => isSet(i, a)).length)[0] ?? "";
  const pointFields = data.pointFields.filter((f) => items.some((i) => isSet(i, f)));
  const pointed = (i: SprintItem) => pointFields.some((f) => Number(i.values[f]) > 0);
  const pointTypes = [...present].filter((t) => {
    const ofType = items.filter((i) => i.type === t);
    return ofType.filter(pointed).length >= Math.max(2, ofType.length / 2);
  });

  const tags = counted(items.flatMap((i) => i.tags));
  const goal = tags.filter(([t]) => /goal/i.test(t) && !/stretch|added/i.test(t));
  const added = tags.filter(([t]) => /added|stretch/i.test(t));

  notes.push(
    items.length
      ? `From ${data.sprint.name} (${items.length} items): types, review states, fields and tags.`
      : `${data.sprint.name} has 0 items in the team's area, so the types, fields and tags below are guesses. Check the team and area path.`,
  );
  notes.push(members.length ? "You're ticked as the team member. Add teammates if you watch their work too." : "Couldn't match your az sign-in to anyone in the sprint. Tick yourself below.");
  if (!scopeChildTypes.length && childTypes.length) notes.push("None of the stories' children is assigned to a ticked member, so every story is in scope until you pick scope child types.");
  if (!blockedByField) off.push("Blocked By checks: no text field with \"block\" in its name.");
  if (!goal.length) off.push("Lower-priority test: no tag with \"goal\" on sprint items.");
  if (!added.length) off.push("Added without tags: no tag with \"added\" or \"stretch\" on sprint items.");
  if (!pointFields.length || !pointTypes.length) off.push("Missing points: no type in the sprint usually carries points.");
  if (!codeReviewStates.length) off.push("Status ahead of the PR for review states: no state with \"review\" in its name.");

  return {
    ...defaultsFrom({}),
    members,
    storyTypes,
    scopeChildTypes,
    childTypes,
    itemTypes,
    titlePrefixes: [],
    codeReviewStates,
    blockedByField,
    goalTag: goal[0]?.[0] ?? "",
    addedTags: added.map(([t]) => t),
    pointTypes,
    pointFields,
    parkedPrPrefix: "",
    staleDays: 3,
  };
}

/** Starts detection once the setup form is needed and Wings has said which panes are open. */
export function maybeDetect() {
  if (page.main?.phase === "setup" && setup.panes && !setup.detecting && !setup.detection && !setup.detectError) void detect();
}

export function onPanes(list: WingsPane[]) {
  const first = setup.panes === null;
  setup.panes = list;
  if (first) maybeDetect();
}

// ---------- the form ----------

/** Opens the settings at a step. */
export function openSettings(at = 0) {
  setup.step = at;
  setup.focusAfterRender = "step-question";
  setup.draft = { ...(page.main?.settings ?? {}) };
  setup.other = {};
  setup.tickedFirst = {};
  render();
}

export async function save() {
  if (!setup.draft) return;
  const d = setup.draft;
  const settings = {
    ...d,
    org: orgUrl(String(d.org ?? "")),
    project: String(d.project ?? "").trim(),
    team: String(d.team ?? "").trim(),
    areaPath: String(d.areaPath ?? "").trim(),
    staleDays: Math.max(1, Math.round(Number(d.staleDays) || 3)),
  };
  try {
    await wings.storage.set("settings", settings);
  } catch (error) {
    page.localError = String((error as Error | null)?.message ?? error);
    return render();
  }
  setup.draft = null;
  setup.detection = null;
  page.localError = null;
  if (page.main) page.main = { ...page.main, phase: "loading", settings: settings as Settings, error: null };
  render();
  await wings.broadcast({ type: "settings-changed" });
}

/** Re-renders after typing stops, so lists for a typed name load without one render per key. */
let typingTimer: ReturnType<typeof setTimeout> | undefined;
export const settle = () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(render, 500);
};

// ---------- the stepper ----------

/** Weekdays after `iso`'s day up to today. */
export function workingDaysAgo(iso: string) {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return 0;
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let n = 0;
  for (day.setUTCDate(day.getUTCDate() + 1); day.getTime() <= today; day.setUTCDate(day.getUTCDate() + 1)) if (day.getUTCDay() % 6 !== 0) n++;
  return n;
}

/** What the steps read: the draft, the lists loaded for it, and the team's sprint. */
export interface Ctx {
  d: Draft;
  org: string;
  project: string;
  team: string;
  orgOk: boolean;
  projects: Loaded<string[]> | null;
  meta: Loaded<ProjectMeta> | null;
  m: ProjectMeta | undefined;
  sprint: Loaded<SprintData> | null;
  data: SprintData | undefined;
  members: Loaded<Person[]> | null;
  me: string | null;
  typeNames: string[] | undefined;
}

export function context(): Ctx {
  const d = setup.draft!;
  const org = orgUrl(String(d.org ?? ""));
  const project = String(d.project ?? "").trim();
  const team = String(d.team ?? "").trim();
  const orgOk = validOrg(org);
  const projects = orgOk ? want(`projects|${org}`, projectsOf(org)) : null;
  const meta = orgOk && safeArg(project) ? want(`meta|${org}|${project}`, metaOf(org, project)) : null;
  const m = meta?.value;
  const teamOk = !!m && safeArg(team) && m.teams.includes(team);
  const sprint = teamOk ? want(`sprint|${org}|${project}|${team}`, sprintOf(org, project, team)) : null;
  const members = teamOk ? want(`members|${org}|${project}|${team}`, teamMembersOf(org, project, team)) : null;
  const me = want("me", meOf()).value ?? null;
  return { d, org, project, team, orgOk, projects, meta, m, sprint, data: sprint?.value, members, me, typeNames: m?.types.map((t) => t.name).sort() };
}
