// @ts-check
/// <reference path="./wings.d.ts" />

// Settings for the Sprint board sidebar: works out as much as it can with read-only az and git calls, shows
// it for one click, and offers pickers to correct any of it. Loaded before sidebar.js, which draws the board
// and calls renderSettings, openSettings and maybeDetect from here. Lists read from Azure DevOps are kept
// in memory per organization and project, so a render never asks for them again.

/** @typedef {{ name: string, states: { name: string, category: string }[] }} WorkItemType */
/** @typedef {{ ref: string, name: string, type: string }} FieldInfo */
/** @typedef {{ types: WorkItemType[], categories: Map<string, string[]>, fields: FieldInfo[], tags: string[], teams: string[], myTeams: string[] }} ProjectMeta */
/** @typedef {{ id: number, type: string, state: string, assignee: string | null, assigneeLogin: string | null, tags: string[], parent: number | null, values: Record<string, unknown> }} SprintItem */
/** @typedef {{ sprint: { name: string, path: string }, items: SprintItem[], blockFields: string[], pointFields: string[] }} SprintData */

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
      .map((/** @type {any} */ t) => ({ name: String(t.name), states: (t.states ?? []).map((/** @type {any} */ s) => ({ name: String(s.name), category: String(s.category) })) })),
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
  const select = ["System.Id", "System.WorkItemType", "System.State", "System.AssignedTo", "System.Tags", "System.Parent", ...blockFields, ...pointFields].map((f) => `[${f}]`).join(", ");
  const wiql = `SELECT ${select} FROM WorkItems WHERE [System.TeamProject] = ${q(project)} AND [System.IterationPath] = ${q(String(it.path))} AND (${areaClause(area, q)}) AND [System.State] <> 'Removed'`;
  const rows = (await az(["boards", "query", "--wiql", wiql, "--project", project], org)) ?? [];
  /** @type {SprintData} */
  const data = {
    sprint: { name: String(it.name), path: String(it.path) },
    blockFields,
    pointFields,
    items: rows.map((/** @type {any} */ r) => {
      const f = r.fields ?? {};
      return {
        id: r.id,
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

  // Members: the team's own members when it lists several; many teams list only a few, so otherwise you.
  const meName = me ? (items.find((i) => i.assigneeLogin?.toLowerCase() === me.toLowerCase())?.assignee ?? teamMembers.find((m) => m.login.toLowerCase() === me.toLowerCase())?.name ?? null) : null;
  const members = teamMembers.length >= 2 ? teamMembers.map((m) => m.name) : meName ? [meName] : [];

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
  notes.push(
    members.length
      ? `${members.length} team member${members.length > 1 ? "s" : ""} ticked${teamMembers.length < 2 ? " (you; the team lists fewer than two members)" : ""}. Tick the rest below.`
      : "No team members found. Tick them below.",
  );
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

function openSettings() {
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
  return h("div", { class: "stack tight" }, boxes.length ? h("div", { class: `checks${boxes.length > 8 ? " scroll" : ""}` }, ...boxes) : null, add);
}

function renderSettings() {
  const d = /** @type {Record<string, any>} */ (draft);
  const setup = main?.phase === "setup";
  const org = String(d.org ?? "");
  const project = String(d.project ?? "").trim();
  const team = String(d.team ?? "").trim();
  const orgOk = validOrg(org);
  const projects = orgOk ? want(`projects|${orgUrl(org)}`, projectsOf(orgUrl(org))) : null;
  const metaKey = `meta|${orgUrl(org)}|${project}`;
  const meta = orgOk && safeArg(project) ? want(metaKey, metaOf(orgUrl(org), project)) : null;
  const m = /** @type {ProjectMeta | undefined} */ (meta?.value);
  const members = m && safeArg(team) && m.teams.includes(team) ? want(`members|${orgUrl(org)}|${project}|${team}`, teamMembersOf(orgUrl(org), project, team)) : null;
  // The sprint's assignees are offered as members too, since a team often lists only some of its people.
  const sprint = m && safeArg(team) && m.teams.includes(team) ? want(`sprint|${orgUrl(org)}|${project}|${team}`, sprintOf(orgUrl(org), project, team)) : null;
  /** Names offered as members, with their item count in the sprint. @type {Map<string, number>} */
  const hints = new Map(counted((/** @type {SprintData | undefined} */ (sprint?.value)?.items ?? []).map((i) => i.assignee ?? "").filter(Boolean)));
  for (const mem of members?.value ?? []) if (!hints.has(mem.name)) hints.set(mem.name, 0);
  const typeNames = m?.types.map((t) => t.name).sort();
  const chosen = new Set([...(d.storyTypes ?? []), ...(d.childTypes ?? []), ...(d.itemTypes ?? [])]);
  const states = m ? [...new Set(m.types.filter((t) => chosen.has(t.name)).flatMap((t) => t.states.map((s) => s.name)))] : undefined;
  const textFields = m?.fields.filter((f) => ["string", "plainText"].includes(f.type)).map((f) => f.ref).sort((a, b) => Number(!/^Custom\./.test(a)) - Number(!/^Custom\./.test(b)) || a.localeCompare(b));
  const numberFields = m?.fields.filter((f) => ["integer", "double"].includes(f.type) && /^(Custom\.|Microsoft\.VSTS\.Scheduling\.)/.test(f.ref)).map((f) => f.ref).sort();
  const fieldName = (/** @type {string} */ ref) => {
    const f = m?.fields.find((x) => x.ref === ref);
    return f ? `${f.name} (${f.ref})` : ref;
  };
  const tagCounts = new Map(counted((/** @type {SprintData | undefined} */ (sprint?.value)?.items ?? []).flatMap((i) => i.tags)));
  const tagLabel = (/** @type {string} */ t) => (tagCounts.get(t) ? `${t} · ${tagCounts.get(t)} in sprint` : t);
  // Tags used in the sprint first, then the rest of the project's.
  const tags = m ? [...[...tagCounts.keys()].sort((a, b) => (tagCounts.get(b) ?? 0) - (tagCounts.get(a) ?? 0)), ...m.tags.filter((t) => !tagCounts.has(t))] : undefined;
  const sprintTags = tags?.filter((t) => tagCounts.has(t) || (d.addedTags ?? []).includes(t));
  const orgs = [...new Set(repos.map((r) => r.org))];

  return h(
    "form",
    {
      class: "card settings",
      onsubmit: (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        void save();
      },
    },
    h("h1", {}, setup ? "Set up your sprint board" : "Settings"),
    detection
      ? h("ul", { class: "detected" }, ...detection.notes.map((n) => h("li", {}, n)), ...detection.off.map((n) => h("li", { class: "muted" }, `Off: ${n}`)))
      : setup
        ? h("p", { class: "muted" }, "Settings stay in Wings on this computer, and the board is only ever read.")
        : null,
    detectError ? h("p", { class: "error", role: "alert" }, `Couldn't detect the settings: ${detectError}`) : null,
    labelled("Organization", pickOne("org", orgs.length ? orgs : undefined, { placeholder: "https://dev.azure.com/your-org" })),
    labelled("Project", pickOne("project", projects?.value)),
    listStatus(projects, "projects"),
    labelled("Team", pickOne("team", m?.teams, { labels: (t) => (m?.myTeams.includes(t) ? `${t} (yours)` : t) })),
    listStatus(meta, "the project's teams, types and fields"),
    labelled("Area path", h("input", { id: "f-areaPath", type: "text", autocomplete: "off", spellcheck: "false", value: d.areaPath ?? "", oninput: (/** @type {Event} */ e) => (d.areaPath = /** @type {HTMLInputElement} */ (e.target).value) }), "Empty uses the team's areas."),
    labelled(
      "Team members",
      pickMany("members", [...hints.keys()].sort((a, b) => (hints.get(b) ?? 0) - (hints.get(a) ?? 0) || a.localeCompare(b)), {
        labels: (n) => (hints.get(n) ? `${n} · ${hints.get(n)} in sprint` : n),
        extra: "Add a display name, then Enter",
      }),
    ),
    listStatus(sprint, "the sprint's people"),
    h(
      "details",
      { open: !setup },
      h("summary", {}, "Scope and board rules"),
      labelled("Story types", pickMany("storyTypes", typeNames)),
      labelled("Scope child types", pickMany("scopeChildTypes", typeNames), "A story is in your team's scope when it has a child of one of these types. None puts every story in scope."),
      labelled("Child types checked", pickMany("childTypes", typeNames), "Children of an in-scope story that are checked too."),
      labelled("Other item types", pickMany("itemTypes", typeNames), "In scope when assigned to a team member or titled with a prefix below."),
      labelled("Title prefixes", pickMany("titlePrefixes", [], { extra: "Add a prefix, then Enter" })),
      labelled("Code review states", pickMany("codeReviewStates", states), "States whose linked pull request should be open."),
      labelled("Blocked By field", pickOne("blockedByField", textFields, { none: "None (checks off)", labels: fieldName, placeholder: "Custom.Blocker" }), "A text field holding the blocking ticket number."),
      labelled("Goal tag", pickOne("goalTag", tags, { none: "None (test off)", labels: tagLabel }), "Tag on the sprint's priority work."),
      labelled("Added-during-sprint tags", pickMany("addedTags", sprintTags, { labels: tagLabel, extra: "Add a tag, then Enter" }), "Tags an item created after the sprint started must carry. None turns the check off."),
      labelled("Types that need points", pickMany("pointTypes", typeNames), "When added during the sprint. Titles with \"spike\" are exempt. None turns the check off."),
      labelled("Point fields", pickMany("pointFields", numberFields, { labels: fieldName }), "All must be set and equal."),
      labelled("Parked PR title prefix", h("input", { id: "f-parkedPrPrefix", type: "text", autocomplete: "off", value: d.parkedPrPrefix ?? "", oninput: (/** @type {Event} */ e) => (d.parkedPrPrefix = /** @type {HTMLInputElement} */ (e.target).value) }), "A linked PR titled with this is parked on purpose, so its item skips the PR check."),
      labelled("Stale after (working days)", h("input", { id: "f-staleDays", type: "number", min: 1, value: d.staleDays ?? 3, oninput: (/** @type {Event} */ e) => (d.staleDays = /** @type {HTMLInputElement} */ (e.target).value) })),
    ),
    localError ? h("p", { class: "error", role: "alert" }, localError) : null,
    detection ? h("p", { class: "hint" }, `Detected with ${detection.calls} calls in ${(detection.ms / 1000).toFixed(1)} s.`) : null,
    h(
      "div",
      { class: "row buttons" },
      h("button", { type: "button", class: "ghost", disabled: !!detecting, onclick: () => void detect() }, "Detect again"),
      setup ? null : h("button", { type: "button", class: "ghost", onclick: () => ((draft = null), (detection = null), (localError = null), render()) }, "Cancel"),
      h("button", { type: "submit", class: "primary", disabled: !orgOk || !project || !team || !(d.members ?? []).length }, setup ? "Use these" : "Save"),
    ),
  );
}

function renderDetecting() {
  return h("div", { class: "card settings" }, h("h1", {}, "Setting up your sprint board"), h("div", { class: "row muted" }, spinner(), detecting?.step ?? ""));
}
