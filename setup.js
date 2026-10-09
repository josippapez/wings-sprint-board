// @ts-check
/// <reference path="./wings.d.ts" />

// Settings for the Sprint board sidebar: works out as much as it can with read-only az and git calls, shows
// it for one click, and offers pickers to correct any of it. Loaded before sidebar.js, which draws the board
// and calls renderSettings, openSettings and maybeDetect from here. Lists read from Azure DevOps are kept
// in memory per organization and project, so a render never asks for them again.

/** @typedef {{ name: string, color: string, states: { name: string, category: string, color: string }[] }} WorkItemType */
/** @typedef {{ ref: string, name: string, type: string }} FieldInfo */
/** @typedef {{ types: WorkItemType[], categories: Map<string, string[]>, fields: FieldInfo[], tags: string[], teams: string[], myTeams: string[] }} ProjectMeta */
/** @typedef {{ id: number, title: string, type: string, state: string, assignee: string | null, assigneeLogin: string | null, tags: string[], parent: number | null, created: string, changed: string, values: Record<string, unknown> }} SprintItem */
/** @typedef {{ sprint: { name: string, path: string, start: string | null, finish: string | null }, items: SprintItem[], blockFields: string[], pointFields: string[] }} SprintData */

const POINT_FIELDS = ["Microsoft.VSTS.Scheduling.StoryPoints", "Microsoft.VSTS.Scheduling.Effort", "Microsoft.VSTS.Scheduling.Size"];
/** Categories of types that aren't board work, like test cases and code review requests. */
const NOT_WORK = /Hidden|Test|SharedStep|SharedParameter|CodeReview|Feedback|Epic|Feature/;

/** The settings form's values while it's open. @type {Record<string, any> | null} */
let draft = null;
/** Text typed into "Other…" fields, by setting key. @type {Record<string, string>} */
let other = {};
/** What each checkbox list had ticked when the form opened. Those go first, and stay put while you tick. @type {Record<string, Set<string>>} */
let tickedFirst = {};
/** @type {{ step: string } | null} */
let detecting = null;
/** @type {{ notes: string[], off: string[], calls: number, ms: number } | null} */
let detection = null;
/** @type {string | null} */
let detectError = null;
/** @type {any[] | null} */
let panes = null;
/** Azure DevOps repos open in Wings, most panes first. @type {{ org: string, project: string, panes: number }[]} */
let repos = [];
let calls = 0;

// ---------- az, git and the list cache ----------

class AzError extends Error {
  /** @param {string} message @param {boolean} login */
  constructor(message, login) {
    super(message);
    this.login = login;
  }
}

const orgUrl = (/** @type {string} */ org) => org.trim().replace(/\/+$/, "");
const validOrg = (/** @type {string} */ org) => /^https:\/\/dev\.azure\.com\/[\w.-]+\/?$/.test(org.trim());
/** Wings refuses az arguments starting with "-" or "@". */
const safeArg = (/** @type {string} */ v) => !!v.trim() && !/^[-@]/.test(v);

/** A read-only az call. @param {string[]} args @param {string | null} org */
async function az(args, org) {
  calls++;
  const out = await wings.exec("az", [...args, ...(org ? ["--organization", orgUrl(org)] : []), "-o", "json"], { timeoutMs: 60_000 });
  if (out.code !== 0) {
    const message = out.stderr.trim().split("\n").filter((l) => l && !/^WARNING/.test(l)).at(-1) || `az exited with ${out.code}`;
    throw new AzError(message, /login/i.test(out.stderr));
  }
  return out.stdout.trim() ? JSON.parse(out.stdout) : null;
}

/** @param {string} org @param {string} resource @param {string[]} route @param {string[]} [query] */
const invoke = (org, resource, route, query = [], area = "wit", version = "7.1") =>
  az(["devops", "invoke", "--area", area, "--resource", resource, "--route-parameters", ...route, ...(query.length ? ["--query-parameters", ...query] : []), "--api-version", version], org);

/** Loaded lists by key: { value } once loaded, { error } if it failed, or a pending promise. @type {Map<string, { value?: any, error?: string, promise?: Promise<any> }>} */
const lists = new Map();

/** Loads a list once and re-renders when it lands. Returns what's known now. @template T @param {string} key @param {() => Promise<T>} load @returns {{ value?: T, error?: string, loading: boolean }} */
function want(key, load) {
  let entry = lists.get(key);
  if (!entry) {
    entry = {};
    const e = entry;
    e.promise = load().then(
      (value) => {
        e.value = value;
        delete e.promise;
        render();
        return value;
      },
      (error) => {
        e.error = String(error?.message ?? error);
        delete e.promise;
        render();
        throw error;
      },
    );
    // Rendering reads the entry; a failed load shows as a message, so nothing waits on this promise.
    e.promise.catch(() => {});
    lists.set(key, entry);
  }
  return { value: entry.value, error: entry.error, loading: !!entry.promise };
}

/** Waits for a list, for detection. @template T @param {string} key @param {() => Promise<T>} load @returns {Promise<T>} */
async function need(key, load) {
  want(key, load);
  const entry = /** @type {any} */ (lists.get(key));
  if (entry.promise) return entry.promise;
  if (entry.error) throw new Error(entry.error);
  return entry.value;
}

const projectsOf = (/** @type {string} */ org) => async () => {
  const out = await az(["devops", "project", "list", "--top", "500"], org);
  return (out?.value ?? out ?? []).map((/** @type {any} */ p) => String(p.name)).sort();
};

/** Types with their states, type categories, fields, tags, teams and your teams: six calls, once per project. */
const metaOf = (/** @type {string} */ org, /** @type {string} */ project) => async () => {
  const route = [`project=${project}`];
  const [types, categories, fields, tags, teams, mine] = await Promise.all([
    invoke(org, "workItemTypes", route),
    invoke(org, "workItemTypeCategories", route),
    invoke(org, "fields", route),
    invoke(org, "tags", route),
    az(["devops", "team", "list", "--project", project, "--top", "500"], org),
    // $mine lists the teams the signed-in user is in, so nobody has to say who they are.
    invoke(org, "teams", [`projectId=${project}`], ["$mine=true"], "core", "7.1-preview"),
  ]);
  /** @type {ProjectMeta} */
  const meta = {
    types: (types?.value ?? [])
      .filter((/** @type {any} */ t) => !t.isDisabled)
      .map((/** @type {any} */ t) => ({
        name: String(t.name),
        color: /^[0-9a-f]{6}$/i.test(String(t.color)) ? `#${t.color}` : "#888888",
        states: (t.states ?? []).map((/** @type {any} */ s) => ({ name: String(s.name), category: String(s.category), color: /^[0-9a-f]{6}$/i.test(String(s.color)) ? `#${s.color}` : "#888888" })),
      })),
    categories: new Map((categories?.value ?? []).map((/** @type {any} */ c) => [String(c.referenceName), (c.workItemTypes ?? []).map((/** @type {any} */ t) => String(t.name))])),
    fields: (fields?.value ?? []).map((/** @type {any} */ f) => ({ ref: String(f.referenceName), name: String(f.name), type: String(f.type) })),
    tags: (tags?.value ?? []).map((/** @type {any} */ t) => String(t.name)).sort((/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b)),
    teams: (teams ?? []).map((/** @type {any} */ t) => String(t.name)).sort(),
    myTeams: (mine?.value ?? []).map((/** @type {any} */ t) => String(t.name)),
  };
  return meta;
};

/** Text fields that could hold a blocking ticket: their name or reference name says "block". @param {ProjectMeta} meta */
const blockFieldsOf = (meta) => meta.fields.filter((f) => ["string", "plainText"].includes(f.type) && /block/i.test(`${f.ref} ${f.name}`)).map((f) => f.ref);

/** The team's areas as WIQL, each path with or without its children, as on the team's board. @param {any} area @param {(v: string) => string} q */
function areaClause(area, q) {
  const values = area?.values ?? [];
  if (!values.length) throw new Error("The team has no areas.");
  return values.map((/** @type {any} */ v) => `[System.AreaPath] ${v.includeChildren ? "UNDER" : "="} ${q(String(v.value))}`).join(" OR ");
}

/** The team's current sprint and its items, with the fields detection looks at. Three calls. */
const sprintOf = (/** @type {string} */ org, /** @type {string} */ project, /** @type {string} */ team) => async () => {
  const meta = await need(`meta|${org}|${project}`, metaOf(org, project));
  const [iterations, area] = await Promise.all([
    az(["boards", "iteration", "team", "list", "--team", team, "--timeframe", "current", "--project", project], org),
    az(["boards", "area", "team", "list", "--team", team, "--project", project], org),
  ]);
  const it = iterations?.[0];
  if (!it) throw new Error(`${team} has no current sprint.`);
  const refs = new Set(meta.fields.map((f) => f.ref));
  const blockFields = blockFieldsOf(meta);
  const pointFields = POINT_FIELDS.filter((f) => refs.has(f));
  const q = (/** @type {string} */ v) => `'${v.replace(/'/g, "''")}'`;
  const select = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "System.Tags", "System.Parent", "System.CreatedDate", "System.ChangedDate", ...blockFields, ...pointFields].map((f) => `[${f}]`).join(", ");
  const wiql = `SELECT ${select} FROM WorkItems WHERE [System.TeamProject] = ${q(project)} AND [System.IterationPath] = ${q(String(it.path))} AND (${areaClause(area, q)}) AND [System.State] <> 'Removed'`;
  const rows = (await az(["boards", "query", "--wiql", wiql, "--project", project], org)) ?? [];
  /** @type {SprintData} */
  const data = {
    sprint: { name: String(it.name), path: String(it.path), start: it.attributes?.startDate ?? null, finish: it.attributes?.finishDate ?? null },
    blockFields,
    pointFields,
    items: rows.map((/** @type {any} */ r) => {
      const f = r.fields ?? {};
      return {
        id: r.id,
        title: String(f["System.Title"] ?? ""),
        created: String(f["System.CreatedDate"] ?? ""),
        changed: String(f["System.ChangedDate"] ?? ""),
        type: String(f["System.WorkItemType"] ?? ""),
        state: String(f["System.State"] ?? ""),
        assignee: f["System.AssignedTo"]?.displayName ?? null,
        assigneeLogin: f["System.AssignedTo"]?.uniqueName ?? null,
        tags: String(f["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean),
        parent: typeof f["System.Parent"] === "number" ? f["System.Parent"] : null,
        values: f,
      };
    }),
  };
  return data;
};

const teamMembersOf = (/** @type {string} */ org, /** @type {string} */ project, /** @type {string} */ team) => async () => {
  const out = await az(["devops", "team", "list-member", "--team", team, "--project", project, "--top", "500"], org);
  return (out ?? [])
    .map((/** @type {any} */ m) => m.identity ?? {})
    .filter((/** @type {any} */ i) => !i.isContainer && i.displayName)
    .map((/** @type {any} */ i) => ({ name: String(i.displayName), login: String(i.uniqueName ?? "") }));
};

/** The signed-in az account, read locally. */
const meOf = () => async () => String((await az(["account", "show", "--query", "user.name"], null)) ?? "");

// ---------- open repos ----------

/** Same patterns as Wings' pr-tracker. A visualstudio.com organization is the same one at dev.azure.com. @param {string} url */
function azureRemote(url) {
  let m = url.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) m = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/);
  if (!m) m = url.match(/([^/.@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?$/);
  return m ? { org: `https://dev.azure.com/${m[1]}`, project: decodeURIComponent(m[2]) } : null;
}

/** Remotes by folder, read once each. @type {Map<string, Promise<{ org: string, project: string } | null>>} */
const remotes = new Map();

async function findRepos() {
  const cwds = [...new Set((panes ?? []).map((p) => String(p.cwd)).filter(Boolean))].slice(0, 12);
  const found = await Promise.all(
    cwds.map((cwd) => {
      if (!remotes.has(cwd)) {
        remotes.set(cwd, wings.exec("git", ["remote", "get-url", "origin"], { cwd }).then((out) => (out.code === 0 ? azureRemote(out.stdout.trim()) : null), () => null));
      }
      return remotes.get(cwd);
    }),
  );
  /** @type {Map<string, { org: string, project: string, panes: number }>} */
  const counts = new Map();
  for (const r of found) {
    if (!r) continue;
    const key = `${r.org}|${r.project}`;
    counts.set(key, { ...r, panes: (counts.get(key)?.panes ?? 0) + 1 });
  }
  repos = [...counts.values()].sort((a, b) => b.panes - a.panes);
}

// ---------- detection ----------

/** Counts of each value, most common first. @param {string[]} values @returns {[string, number][]} */
function counted(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Fills the form with what can be worked out. Keeps an organization, project and team already picked. */
async function detect() {
  detecting = { step: "Looking for Azure DevOps repos open in Wings…" };
  detectError = null;
  render();
  calls = 0;
  const started = Date.now();
  const base = draft ?? {};
  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const off = [];
  try {
    await findRepos();
    const repo = repos[0];
    const org = validOrg(base.org ?? "") ? orgUrl(base.org) : repo?.org ?? "";
    const project = base.project?.trim() || (repo && repo.org === org ? repo.project : "");
    if (!org || !project) {
      notes.push("No Azure DevOps repo is open in Wings. Pick the organization and project, then detect again.");
      return finish({ ...defaultsFrom(base), org, project }, notes, off, started);
    }
    notes.push(base.project?.trim() ? `Project as picked: ${project}.` : `From your open repos: ${project}${repos.length > 1 ? ` (${repos.length - 1} other repo${repos.length > 2 ? "s" : ""} found)` : ""}.`);

    detecting.step = "Reading the project's teams, types and fields…";
    render();
    const meta = await need(`meta|${org}|${project}`, metaOf(org, project));
    let team = base.team?.trim() || "";
    if (!team) {
      // Of your teams with a current sprint, the one with the most items, then the most of them yours.
      const [me, sprints] = await Promise.all([
        need("me", meOf()).catch(() => ""),
        Promise.all(meta.myTeams.slice(0, 5).map((t) => need(`sprint|${org}|${project}|${t}`, sprintOf(org, project, t)).then((d) => ({ t, d }), () => null))),
      ]);
      const mine = (/** @type {SprintData} */ d) => d.items.filter((i) => !!me && i.assigneeLogin?.toLowerCase() === me.toLowerCase()).length;
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

    detecting.step = "Reading the team's current sprint…";
    render();
    const [data, members, me] = await Promise.all([
      need(`sprint|${org}|${project}|${team}`, sprintOf(org, project, team)),
      need(`members|${org}|${project}|${team}`, teamMembersOf(org, project, team)),
      need("me", meOf()).catch(() => ""),
    ]);
    const settings = infer(meta, data, members, me, notes, off);
    return finish({ ...settings, org, project, team, areaPath: base.areaPath ?? "" }, notes, off, started);
  } catch (error) {
    detectError = String(/** @type {any} */ (error)?.message ?? error);
    if (/** @type {any} */ (error)?.login) detectError = `az isn't signed in. ${detectError}`;
    detecting = null;
    if (!draft) draft = defaultsFrom(main?.settings ?? {});
    render();
  }
}

/** @param {Record<string, any>} s */
const defaultsFrom = (s) => ({ ...(main?.settings ?? {}), ...s });

/** @param {Record<string, any>} settings @param {string[]} notes @param {string[]} off @param {number} started */
function finish(settings, notes, off, started) {
  draft = settings;
  step = 0;
  focusAfterRender = "step-question";
  other = {};
  tickedFirst = {};
  detection = { notes, off, calls, ms: Date.now() - started };
  detecting = null;
  render();
}

/** Works out the scope and rules from the project and the sprint. @param {ProjectMeta} meta @param {SprintData} data @param {{ name: string, login: string }[]} teamMembers @param {string} me @param {string[]} notes @param {string[]} off */
function infer(meta, data, teamMembers, me, notes, off) {
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

  const isSet = (/** @type {SprintItem} */ i, /** @type {string} */ f) => i.values[f] != null && String(i.values[f]).trim() !== "";
  const blockedByField = [...data.blockFields].sort((a, b) => items.filter((i) => isSet(i, b)).length - items.filter((i) => isSet(i, a)).length)[0] ?? "";
  const pointFields = data.pointFields.filter((f) => items.some((i) => isSet(i, f)));
  const pointed = (/** @type {SprintItem} */ i) => pointFields.some((f) => Number(i.values[f]) > 0);
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
function maybeDetect() {
  if (main?.phase === "setup" && panes && !detecting && !detection && !detectError) void detect();
}

wings.onPanes((list) => {
  const first = panes === null;
  panes = list;
  if (first) maybeDetect();
});

// ---------- the form ----------

/** Opens the settings at a step. @param {number} [at] */
function openSettings(at = 0) {
  step = at;
  focusAfterRender = "step-question";
  draft = { ...(main?.settings ?? {}) };
  other = {};
  tickedFirst = {};
  render();
}

async function save() {
  if (!draft) return;
  const d = draft;
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
    localError = String(/** @type {any} */ (error)?.message ?? error);
    return render();
  }
  draft = null;
  detection = null;
  localError = null;
  if (main) main = { ...main, phase: "loading", settings, error: null };
  render();
  await wings.broadcast({ type: "settings-changed" });
}

/** Re-renders after typing stops, so lists for a typed name load without one render per key. */
let typingTimer = 0;
const settle = () => {
  clearTimeout(typingTimer);
  typingTimer = setTimeout(render, 500);
};

/** @param {string} label @param {Node | null} control @param {string | null} [hint] */
const labelled = (label, control, hint) => h("div", { class: "field" }, h("span", { class: "label" }, label), control, hint ? h("span", { class: "hint" }, hint) : null);

/** A list state as a line under a picker. @param {{ loading: boolean, error?: string } | null} state @param {string} what */
const listStatus = (state, what) =>
  state?.loading ? h("span", { class: "hint row" }, spinner(), `Loading ${what}…`) : state?.error ? h("span", { class: "hint error" }, `Couldn't load ${what}: ${state.error}. Type it instead.`) : null;

/**
 * One value from a list, with "Other…" for typing one. Falls back to a text field while the list loads or fails.
 * @param {string} key @param {string[] | undefined} options @param {{ none?: string, placeholder?: string, labels?: (v: string) => string }} [o]
 */
function pickOne(key, options, o = {}) {
  const d = /** @type {Record<string, any>} */ (draft);
  const value = String(d[key] ?? "");
  const id = `f-${key}`;
  const typed = (/** @type {Event} */ e) => {
    d[key] = /** @type {HTMLInputElement} */ (e.target).value;
    other[key] = d[key];
    // The lists that depend on this value load once typing stops.
    settle();
  };
  const text = h("input", { id: `${id}-text`, type: "text", autocomplete: "off", spellcheck: "false", placeholder: o.placeholder ?? null, value, oninput: typed });
  if (!options) return text;
  const isOther = key in other || (value !== "" && !options.includes(value));
  const select = h(
    "select",
    {
      id,
      onchange: (/** @type {Event} */ e) => {
        const v = /** @type {HTMLSelectElement} */ (e.target).value;
        if (v === "\u0000other") other[key] = value;
        else {
          delete other[key];
          d[key] = v;
        }
        render();
      },
    },
    o.none !== undefined ? h("option", { value: "", selected: !isOther && value === "" }, o.none) : !value && !isOther ? h("option", { value: "", selected: true, disabled: true }, "Choose…") : null,
    ...options.map((v) => h("option", { value: v, selected: !isOther && v === value }, o.labels ? o.labels(v) : v)),
    h("option", { value: "\u0000other", selected: isOther }, "Other…"),
  );
  return h("div", { class: "stack tight" }, select, isOther ? text : null);
}

/**
 * Several values from a list as checkboxes, plus a field for values the list doesn't have.
 * @param {string} key @param {string[] | undefined} options @param {{ labels?: (v: string) => string, extra?: string }} [o]
 */
function pickMany(key, options, o = {}) {
  const d = /** @type {Record<string, any>} */ (draft);
  /** @type {string[]} */
  const values = Array.isArray(d[key]) ? d[key] : [];
  if (!(key in tickedFirst) && options) tickedFirst[key] = new Set(values);
  const first = tickedFirst[key] ?? new Set();
  const listed = [...(options ?? [])].sort((a, b) => Number(first.has(b)) - Number(first.has(a)));
  const extras = values.filter((v) => !listed.includes(v));
  const id = `f-${key}`;
  const boxes = [...listed, ...extras].map((v, i) =>
    h(
      "label",
      { class: "check-row", for: `${id}-${i}` },
      h("input", {
        id: `${id}-${i}`,
        type: "checkbox",
        checked: values.includes(v),
        onchange: (/** @type {Event} */ e) => {
          const on = /** @type {HTMLInputElement} */ (e.target).checked;
          d[key] = on ? [...values.filter((x) => x !== v), v] : values.filter((x) => x !== v);
          render();
        },
      }),
      h("span", {}, o.labels ? o.labels(v) : v),
    ),
  );
  const add = h("input", {
    id: `${id}-add`,
    type: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: o.extra ?? "Add another, then Enter",
    value: other[key] ?? "",
    oninput: (/** @type {Event} */ e) => (other[key] = /** @type {HTMLInputElement} */ (e.target).value),
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const added = (other[key] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
      d[key] = [...values, ...added.filter((v) => !values.includes(v))];
      delete other[key];
      render();
    },
  });
  return h("div", { class: "stack tight" }, boxes.length ? h("div", { id: `${id}-list`, class: `checks${boxes.length > 8 ? " scroll" : ""}` }, ...boxes) : null, add);
}

// ---------- the stepper ----------

/** The step on screen. */
let step = 0;
/** An element to focus once the next render is on screen, like a new step's question. @type {string | null} */
let focusAfterRender = null;

/** Weekdays after `iso`'s day up to today. @param {string} iso */
function workingDaysAgo(iso) {
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return 0;
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let n = 0;
  for (day.setUTCDate(day.getUTCDate() + 1); day.getTime() <= today; day.setUTCDate(day.getUTCDate() + 1)) if (day.getUTCDay() % 6 !== 0) n++;
  return n;
}

/**
 * What the steps read: the draft, the lists loaded for it, and the team's sprint.
 * @typedef {{ d: Record<string, any>, org: string, project: string, team: string, orgOk: boolean,
 *   projects: ReturnType<typeof want> | null, meta: ReturnType<typeof want> | null, m: ProjectMeta | undefined,
 *   sprint: ReturnType<typeof want> | null, data: SprintData | undefined, members: ReturnType<typeof want> | null,
 *   me: string | null, typeNames: string[] | undefined }} Ctx
 */

/** @returns {Ctx} */
function context() {
  const d = /** @type {Record<string, any>} */ (draft);
  const org = orgUrl(String(d.org ?? ""));
  const project = String(d.project ?? "").trim();
  const team = String(d.team ?? "").trim();
  const orgOk = validOrg(org);
  const projects = orgOk ? want(`projects|${org}`, projectsOf(org)) : null;
  const meta = orgOk && safeArg(project) ? want(`meta|${org}|${project}`, metaOf(org, project)) : null;
  const m = /** @type {ProjectMeta | undefined} */ (meta?.value);
  const teamOk = !!m && safeArg(team) && m.teams.includes(team);
  const sprint = teamOk ? want(`sprint|${org}|${project}|${team}`, sprintOf(org, project, team)) : null;
  const members = teamOk ? want(`members|${org}|${project}|${team}`, teamMembersOf(org, project, team)) : null;
  const me = /** @type {string | undefined} */ (want("me", meOf()).value) ?? null;
  return { d, org, project, team, orgOk, projects, meta, m, sprint, data: /** @type {SprintData | undefined} */ (sprint?.value), members, me, typeNames: m?.types.map((t) => t.name).sort() };
}

const typeColorOf = (/** @type {Ctx} */ c, /** @type {string} */ type) => c.m?.types.find((t) => t.name === type)?.color ?? "#888888";

/** A board row as the sidebar will draw it, for previews. @param {Ctx} c @param {SprintItem} i @param {{ dim?: boolean, chips?: (Node | null)[] }} [o] */
const previewRow = (c, i, o = {}) =>
  h("div", { class: `preview-row${o.dim ? " dim" : ""}` }, dot(typeColorOf(c, i.type), i.type), h("span", { class: "item-id" }, String(i.id)), h("span", { class: "item-title" }, i.title), ...(o.chips ?? []), avatar(i.assignee));

/** The preview card under a step. @param {string} caption @param {...(Node | null)} body */
const preview = (caption, ...body) => h("div", { class: "preview" }, h("div", { class: "preview-caption" }, caption), ...body);
const noExample = () => h("p", { class: "muted note" }, "No example in this sprint.");
const waitFor = (/** @type {Ctx} */ c) => listStatus(c.sprint, "the sprint") ?? (c.data ? null : h("p", { class: "muted note" }, "Pick a team to see an example."));

/** Items assigned to the chosen people. @param {Ctx} c */
const peopleItems = (c) => (c.data?.items ?? []).filter((i) => i.assignee && (c.d.members ?? []).includes(i.assignee));

/**
 * The steps. `ready` says whether Next is allowed, `off` clears an optional check.
 * @type {{ id: string, question: string, explain: string, optional?: boolean, off?: (d: Record<string, any>) => void, ready?: (c: Ctx) => boolean, why: (c: Ctx) => string | null, body: (c: Ctx) => (Node | null)[], show: (c: Ctx) => Node | null }[]}
 */
const STEPS = [
  {
    id: "where",
    question: "Where is your board?",
    explain: "The Azure DevOps organization and project your team's sprint lives in.",
    ready: (c) => c.orgOk && !!c.project,
    why: (c) => (repos.length && repos.some((r) => r.org === c.org && r.project === c.project) ? `Found in ${repos.find((r) => r.org === c.org && r.project === c.project)?.panes} of the repos open in Wings.` : repos.length ? null : "No Azure DevOps repo is open in Wings, so pick it here."),
    body: (c) => [
      labelled("Organization", pickOne("org", repos.length ? [...new Set(repos.map((r) => r.org))] : undefined, { placeholder: "https://dev.azure.com/your-org" })),
      labelled("Project", pickOne("project", /** @type {string[] | undefined} */ (c.projects?.value))),
      listStatus(c.projects, "projects"),
    ],
    show: (c) =>
      repos.length
        ? preview("Azure DevOps repos open in Wings", ...repos.slice(0, 4).map((r) => h("div", { class: `preview-row${r.org === c.org && r.project === c.project ? "" : " dim"}` }, h("span", { class: "item-title" }, `${r.project} · ${r.org.replace("https://dev.azure.com/", "")}`), h("span", { class: "chip" }, `${r.panes} pane${r.panes > 1 ? "s" : ""}`))))
        : null,
  },
  {
    id: "team",
    question: "Which team's sprint?",
    explain: "The board shows the current sprint of this team, in the areas the team owns.",
    ready: (c) => !!c.m && c.m.teams.includes(c.team),
    why: (c) => (c.m?.myTeams.includes(c.team) ? `You're in ${c.m.myTeams.length} team${c.m.myTeams.length > 1 ? "s" : ""} here${c.m.myTeams.length > 1 ? "; this one has the most items in its current sprint" : ""}.` : null),
    body: (c) => [labelled("Team", pickOne("team", c.m?.teams, { labels: (t) => (c.m?.myTeams.includes(t) ? `${t} (yours)` : t) })), listStatus(c.meta, "the project's teams")],
    show: (c) => {
      if (!c.data) return waitFor(c);
      const cats = counted(c.data.items.map((i) => c.m?.types.find((t) => t.name === i.type)?.states.find((s) => s.name === i.state)?.category ?? "Other"));
      const colors = /** @type {Record<string, string>} */ ({ Proposed: "var(--wings-muted)", InProgress: "var(--wings-info)", Resolved: "var(--wings-warning)", Completed: "var(--wings-success)" });
      const names = /** @type {Record<string, string>} */ ({ Proposed: "Not started", InProgress: "In progress", Resolved: "Resolved", Completed: "Done" });
      return preview(
        `${c.data.sprint.name} · ${c.data.items.length} items`,
        h("div", { class: "bar" }, ...cats.map(([cat, n]) => h("span", { style: `flex:${n};background:${colors[cat] ?? "var(--wings-hairline-strong)"}`, title: `${names[cat] ?? cat}: ${n}` }))),
        h("div", { class: "legend" }, ...cats.map(([cat, n]) => h("span", {}, h("span", { class: "swatch", style: `background:${colors[cat] ?? "var(--wings-hairline-strong)"}` }), `${names[cat] ?? cat} ${n}`))),
      );
    },
  },
  {
    id: "people",
    question: "Whose work do you follow?",
    explain: "The board checks and \"Working on\" cover these people. You're picked; add teammates you look after. The board's own Everyone / Mine filter doesn't depend on this.",
    ready: (c) => (c.d.members ?? []).length > 0,
    why: (c) => (c.me && (c.d.members ?? []).length === 1 && c.data?.items.some((i) => i.assigneeLogin?.toLowerCase() === c.me?.toLowerCase() && i.assignee === c.d.members[0]) ? "You're signed in to az as this person." : null),
    body: (c) => {
      /** @type {Map<string, number>} */
      const hints = new Map(counted((c.data?.items ?? []).map((i) => i.assignee ?? "").filter(Boolean)));
      for (const mem of /** @type {{ name: string }[]} */ (c.members?.value ?? [])) if (!hints.has(mem.name)) hints.set(mem.name, 0);
      return [
        pickMany("members", [...hints.keys()].sort((a, b) => (hints.get(b) ?? 0) - (hints.get(a) ?? 0) || a.localeCompare(b)), { labels: (n) => (hints.get(n) ? `${n} · ${hints.get(n)} in sprint` : n), extra: "Add a display name, then Enter" }),
        listStatus(c.sprint, "the sprint's people"),
      ];
    },
    show: (c) => {
      if (!c.data) return waitFor(c);
      const items = peopleItems(c);
      return preview(`Their work in this sprint · ${items.length}`, ...(items.length ? items.slice(0, 4).map((i) => previewRow(c, i, { chips: [h("span", { class: "chip state" }, i.state)] })) : [noExample()]), items.length > 4 ? h("p", { class: "muted note" }, `+ ${items.length - 4} more`) : null);
    },
  },
  {
    id: "stories",
    question: "Which work items are stories, and which are the tasks under them?",
    explain: "A story is the piece of work a board row stands for; tasks are its children. If only some stories are your team's, say which tasks mark them.",
    why: (c) => (c.m ? "Stories come from the process's requirement types; tasks are the types found under them in this sprint." : null),
    body: (c) => [
      labelled("Stories are", pickMany("storyTypes", c.typeNames)),
      labelled("Tasks under a story are", pickMany("childTypes", c.typeNames)),
      labelled("A story is your team's when it has a task of type", pickMany("scopeChildTypes", c.typeNames), "None picked means every story is your team's."),
    ],
    show: (c) => {
      if (!c.data) return waitFor(c);
      const d = c.d;
      const stories = c.data.items.filter((i) => (d.storyTypes ?? []).includes(i.type));
      const kidsOf = (/** @type {number} */ id) => c.data?.items.filter((i) => i.parent === id) ?? [];
      const mine = (/** @type {SprintItem} */ s) => !(d.scopeChildTypes ?? []).length || kidsOf(s.id).some((k) => d.scopeChildTypes.includes(k.type));
      const story = stories.find((s) => mine(s) && kidsOf(s.id).length) ?? stories.find((s) => kidsOf(s.id).length);
      if (!story) return preview("A story and its tasks", noExample());
      const kids = kidsOf(story.id).slice(0, 5);
      return preview(
        mine(story) ? "Your team's story, with its tasks" : "A story that isn't your team's",
        previewRow(c, story, { chips: [h("span", { class: `chip ${mine(story) ? "ok" : ""}` }, mine(story) ? "Yours" : "Not yours")] }),
        ...kids.map((k) => h("div", { class: "preview-child" }, previewRow(c, k, { dim: !(d.childTypes ?? []).includes(k.type), chips: [(d.childTypes ?? []).includes(k.type) ? h("span", { class: "chip" }, "checked") : null] }))),
      );
    },
  },
  {
    id: "other",
    question: "Any other work your team does outside stories?",
    explain: "Work items of these types count as your team's when one of your people has them, or their title starts with a prefix.",
    optional: true,
    off: (d) => ((d.itemTypes = []), (d.titlePrefixes = [])),
    why: () => "These types sit on the sprint board outside stories.",
    body: (c) => [labelled("Types", pickMany("itemTypes", c.typeNames)), labelled("Title prefixes", pickMany("titlePrefixes", [], { extra: "Add a prefix, then Enter" }))],
    show: (c) => {
      if (!c.data) return waitFor(c);
      const d = c.d;
      const items = c.data.items.filter((i) => (d.itemTypes ?? []).includes(i.type) && ((i.assignee && (d.members ?? []).includes(i.assignee)) || (d.titlePrefixes ?? []).some((/** @type {string} */ p) => i.title.toLowerCase().startsWith(p.toLowerCase()))));
      return preview(`Included now · ${items.length}`, ...(items.length ? items.slice(0, 4).map((i) => previewRow(c, i)) : [noExample()]));
    },
  },
  {
    id: "blocked",
    question: "Where do you write what blocks an item?",
    explain: "A text field holding the blocking ticket's number. Items with it set get a red Blocked mark, and the checks flag text that isn't a ticket number, or a ticket that's already closed.",
    optional: true,
    off: (d) => (d.blockedByField = ""),
    why: (c) => (c.d.blockedByField && c.data ? `It has "block" in its name and is set on ${c.data.items.filter((i) => String(i.values[c.d.blockedByField] ?? "").trim()).length} sprint items.` : null),
    body: (c) => {
      const fields = c.m?.fields.filter((f) => ["string", "plainText"].includes(f.type)).sort((a, b) => Number(!/block/i.test(`${a.ref} ${a.name}`)) - Number(!/block/i.test(`${b.ref} ${b.name}`)) || a.name.localeCompare(b.name));
      return [labelled("Field", pickOne("blockedByField", fields?.map((f) => f.ref), { none: "None (checks off)", labels: (ref) => `${c.m?.fields.find((f) => f.ref === ref)?.name ?? ref} (${ref})`, placeholder: "Custom.Blocker" }))];
    },
    show: (c) => {
      if (!c.data) return waitFor(c);
      const field = c.d.blockedByField;
      if (!field) return preview("Blocked marks are off");
      const set = c.data.items.filter((i) => String(i.values[field] ?? "").trim());
      const example = set.find((i) => !/^\s*#?\d/.test(String(i.values[field]))) ?? set[0];
      if (!example) return preview("An item marked blocked", noExample());
      const value = String(example.values[field]).trim();
      return preview(
        "An item marked blocked",
        previewRow(c, example, { chips: [h("span", { class: "chip blocked" }, "Blocked")] }),
        h("p", { class: "note" }, `${field.split(".").at(-1)}: "${value}"`),
        h("p", { class: "note muted" }, /^\s*#?\d/.test(value) ? "Starts with a ticket number, so it links to that item." : "Not a ticket number, so the checks propose putting the blocking ticket's number first."),
      );
    },
  },
  {
    id: "goal",
    question: "Which tag marks the sprint's priority work?",
    explain: "Items with this tag, or under a story with it, are goal work. The checks tell you when someone has only blocked or non-goal work left.",
    optional: true,
    off: (d) => (d.goalTag = ""),
    why: (c) => (c.d.goalTag && c.data ? `The tag with "goal" in it used most in this sprint: on ${c.data.items.filter((i) => i.tags.includes(c.d.goalTag)).length} items.` : null),
    body: (c) => {
      const counts = new Map(counted((c.data?.items ?? []).flatMap((i) => i.tags)));
      const tags = c.m ? [...[...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)), ...c.m.tags.filter((t) => !counts.has(t))] : undefined;
      return [labelled("Tag", pickOne("goalTag", tags, { none: "None (test off)", labels: (t) => (counts.get(t) ? `${t} · ${counts.get(t)} in sprint` : t) }))];
    },
    show: (c) => {
      if (!c.data) return waitFor(c);
      if (!c.d.goalTag) return preview("The lower-priority test is off");
      const items = c.data.items.filter((i) => i.tags.includes(c.d.goalTag));
      return preview(`Goal work · ${items.length}`, ...(items.length ? items.slice(0, 3).map((i) => previewRow(c, i, { chips: [h("span", { class: "chip ok" }, "Goal")] })) : [noExample()]));
    },
  },
  {
    id: "added",
    question: "How do you mark work added after the sprint started?",
    explain: "Items created after the sprint started should carry these tags. Types that need points must have every point field set, and equal when there are several. Titles with \"spike\" are exempt.",
    optional: true,
    off: (d) => ((d.addedTags = []), (d.pointTypes = [])),
    why: (c) => ((c.d.addedTags ?? []).length ? "These tags say \"added\" or \"stretch\" and are used in this sprint." : null),
    body: (c) => {
      const counts = new Map(counted((c.data?.items ?? []).flatMap((i) => i.tags)));
      const numbers = c.m?.fields.filter((f) => ["integer", "double"].includes(f.type) && /^(Custom\.|Microsoft\.VSTS\.Scheduling\.)/.test(f.ref)).map((f) => f.ref).sort();
      return [
        labelled("Tags", pickMany("addedTags", [...counts.keys()], { labels: (t) => `${t} · ${counts.get(t) ?? 0} in sprint`, extra: "Add a tag, then Enter" })),
        labelled("Types that need points", pickMany("pointTypes", c.typeNames)),
        labelled("Point fields", pickMany("pointFields", numbers, { labels: (ref) => `${c.m?.fields.find((f) => f.ref === ref)?.name ?? ref}` })),
      ];
    },
    show: (c) => {
      if (!c.data) return waitFor(c);
      const start = Date.parse(c.data.sprint.start ?? "");
      const added = c.data.items.filter((i) => Date.parse(i.created) > start);
      const tags = c.d.addedTags ?? [];
      return preview(
        `Created after the sprint started · ${added.length}`,
        ...(added.length
          ? added.slice(0, 4).map((i) => previewRow(c, i, { chips: [tags.length ? (tags.every((/** @type {string} */ t) => i.tags.includes(t)) ? h("span", { class: "chip ok" }, "tagged") : h("span", { class: "chip check" }, "missing tag")) : null] }))
          : [noExample()]),
      );
    },
  },
  {
    id: "review",
    question: "Which states mean \"in code review\"?",
    explain: "In these states an item should have an open pull request. The checks flag one whose pull request is already merged or missing, and a done item whose pull request is still open.",
    optional: true,
    off: (d) => (d.codeReviewStates = []),
    why: () => "States with \"review\" in their name.",
    body: (c) => {
      const chosen = new Set([...(c.d.storyTypes ?? []), ...(c.d.childTypes ?? []), ...(c.d.itemTypes ?? [])]);
      const states = c.m ? [...new Set(c.m.types.filter((t) => chosen.has(t.name)).flatMap((t) => t.states.map((s) => s.name)))] : undefined;
      return [
        labelled("States", pickMany("codeReviewStates", states)),
        labelled("Skip pull requests titled", h("input", { id: "f-parkedPrPrefix", type: "text", autocomplete: "off", placeholder: "Leave empty to check them all", value: c.d.parkedPrPrefix ?? "", oninput: (/** @type {Event} */ e) => (c.d.parkedPrPrefix = /** @type {HTMLInputElement} */ (e.target).value) }), "A pull request whose title starts with this is parked on purpose."),
      ];
    },
    show: (c) => {
      const type = c.m?.types.find((t) => (c.d.storyTypes ?? []).includes(t.name));
      if (!type) return waitFor(c);
      const review = c.d.codeReviewStates ?? [];
      const flow = type.states.filter((s) => s.category !== "Removed");
      const at = flow.findIndex((s) => review.includes(s.name));
      const example = c.data?.items.find((i) => review.includes(i.state));
      return preview(
        `${type.name} workflow`,
        h(
          "div",
          { class: "flow" },
          ...flow.map((s, n) =>
            h(
              "div",
              { class: `flow-step${review.includes(s.name) ? " review" : ""}` },
              h("span", { class: "flow-name" }, s.name),
              n === at ? h("div", { class: "flow-card" }, h("span", { class: "item-title" }, example ? `${example.id} ${example.title}` : "An item here"), h("span", { class: "chip pr active" }, "PR open?")) : null,
            ),
          ),
        ),
        at < 0 ? h("p", { class: "muted note" }, "No review state picked for this type.") : null,
      );
    },
  },
  {
    id: "stale",
    question: "When is in-progress work stale?",
    explain: "An item in progress with no change for this many working days is listed as stale. Weekends don't count.",
    why: () => null,
    body: (c) => [labelled("Working days", h("input", { id: "f-staleDays", type: "number", min: 1, value: c.d.staleDays ?? 3, oninput: (/** @type {Event} */ e) => ((c.d.staleDays = /** @type {HTMLInputElement} */ (e.target).value), settle()) }))],
    show: (c) => {
      if (!c.data) return waitFor(c);
      const days = Math.max(1, Number(c.d.staleDays) || 3);
      const active = c.data.items.filter((i) => ["InProgress", "Resolved"].includes(c.m?.types.find((t) => t.name === i.type)?.states.find((s) => s.name === i.state)?.category ?? ""));
      const stale = active.filter((i) => workingDaysAgo(i.changed) >= days);
      return preview(`Stale now · ${stale.length} of ${active.length} in progress`, ...(stale.length ? stale.slice(0, 4).map((i) => previewRow(c, i, { chips: [h("span", { class: "chip check" }, `${workingDaysAgo(i.changed)}d`)] })) : [h("p", { class: "muted note" }, "Nothing in progress has gone that long without a change.")]));
    },
  },
];

/** Moves to a step and puts focus on its question. @param {number} n */
function goTo(n) {
  step = Math.max(0, Math.min(STEPS.length - 1, n));
  focusAfterRender = "step-question";
  render();
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
}

function renderSettings() {
  const c = context();
  const s = STEPS[step];
  const setup = main?.phase === "setup";
  const essentials = STEPS.slice(0, 3).every((x) => !x.ready || x.ready(c));
  const ready = !s.ready || s.ready(c);
  const last = step === STEPS.length - 1;
  const why = s.why(c);
  return h(
    "form",
    {
      class: "card settings stepper",
      // Browsers submit on Enter only from text fields; from the question, a checkbox or a select it goes on too.
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        const native = t instanceof HTMLButtonElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type !== "checkbox");
        if (e.key === "Enter" && !native && !e.defaultPrevented) {
          e.preventDefault();
          /** @type {HTMLFormElement} */ (e.currentTarget).requestSubmit();
        }
      },
      onsubmit: (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        if (!ready) return;
        if (last) void save();
        else goTo(step + 1);
      },
    },
    h(
      "div",
      { class: "row step-top" },
      h("span", { class: "grow muted note" }, `${setup ? "Set up" : "Settings"} · step ${step + 1} of ${STEPS.length}`),
      setup ? null : h("button", { type: "button", class: "ghost", onclick: () => ((draft = null), (detection = null), (localError = null), render()) }, "Close"),
    ),
    h(
      "div",
      { class: "dots", role: "list" },
      ...STEPS.map((x, n) =>
        h("button", {
          type: "button",
          role: "listitem",
          class: `step-dot${n === step ? " current" : n < step ? " done" : ""}`,
          "aria-label": `Step ${n + 1}: ${x.question}`,
          "aria-current": n === step ? "step" : null,
          title: x.question,
          // Later steps need the board picked first.
          disabled: n > step && !essentials,
          onclick: () => goTo(n),
        }),
      ),
    ),
    h("h1", { id: "step-question", tabindex: "-1" }, s.question),
    h("p", { class: "muted" }, s.explain),
    why ? h("p", { class: "why" }, why) : null,
    detectError && step === 0 ? h("p", { class: "error", role: "alert" }, `Couldn't detect the settings: ${detectError}`) : null,
    detection && step === 0
      ? h("details", { class: "detected-all" }, h("summary", {}, `What was detected (${detection.calls} calls, ${(detection.ms / 1000).toFixed(1)} s)`), h("ul", { class: "detected" }, ...detection.notes.map((n) => h("li", {}, n)), ...detection.off.map((n) => h("li", { class: "muted" }, `Off: ${n}`))))
      : null,
    ...s.body(c),
    s.show(c),
    localError ? h("p", { class: "error", role: "alert" }, localError) : null,
    h(
      "div",
      { class: "row buttons" },
      step > 0 ? h("button", { type: "button", class: "ghost", onclick: () => goTo(step - 1) }, "Back") : null,
      h("span", { class: "grow" }),
      s.optional && s.off ? h("button", { type: "button", class: "ghost", onclick: () => (s.off?.(c.d), last ? void save() : goTo(step + 1)) }, "Turn this check off") : null,
      h("button", { type: "submit", class: "primary", disabled: !ready }, last ? (setup ? "Finish" : "Save") : "Next"),
    ),
    h(
      "div",
      { class: "row buttons" },
      h("button", { type: "button", class: "ghost small", disabled: !!detecting, onclick: () => void detect() }, "Detect again"),
      essentials && !last ? h("button", { type: "button", class: "ghost small", onclick: () => void save() }, setup ? "Use detected for the rest" : "Save now") : null,
    ),
  );
}

function renderDetecting() {
  return h("div", { class: "card settings" }, h("h1", {}, "Setting up your sprint board"), h("div", { class: "row muted" }, spinner(), detecting?.step ?? ""));
}
