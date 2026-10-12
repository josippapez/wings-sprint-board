// az, git and the list cache of the sidebar. Lists read from Azure DevOps are kept in memory per organization
// and project, so a render never asks for them again.

import { render } from "./page";

export interface WorkItemType {
  name: string;
  color: string;
  states: { name: string; category: string; color: string }[];
}
export interface FieldInfo {
  ref: string;
  name: string;
  type: string;
}
export interface ProjectMeta {
  types: WorkItemType[];
  categories: Map<string, string[]>;
  fields: FieldInfo[];
  tags: string[];
  teams: string[];
  myTeams: string[];
}
export interface SprintItem {
  id: number;
  title: string;
  type: string;
  state: string;
  assignee: string | null;
  assigneeLogin: string | null;
  tags: string[];
  parent: number | null;
  created: string;
  changed: string;
  values: Record<string, unknown>;
}
export interface SprintData {
  sprint: { name: string; path: string; start: string | null; finish: string | null };
  items: SprintItem[];
  blockFields: string[];
  pointFields: string[];
}
export interface Person {
  name: string;
  login: string;
}

// What the Azure DevOps calls return, as far as the sidebar reads it.
type Named = { name: unknown };
type TypeJson = Named & { color: unknown; isDisabled?: boolean; states?: (Named & { category: unknown; color: unknown })[] };
type IterationJson = Named & { path: unknown; attributes?: { startDate?: string | null; finishDate?: string | null } };
type AreaJson = { values?: { value: unknown; includeChildren?: boolean }[] };
type RowJson = { id: number; fields?: Record<string, unknown> & { "System.AssignedTo"?: { displayName?: string; uniqueName?: string } } };

const POINT_FIELDS = ["Microsoft.VSTS.Scheduling.StoryPoints", "Microsoft.VSTS.Scheduling.Effort", "Microsoft.VSTS.Scheduling.Size"];

/** Counts az calls, for what detection reports. */
export const counter = { calls: 0 };

// ---------- az, git and the list cache ----------

export class AzError extends Error {
  login: boolean;
  constructor(message: string, login: boolean) {
    super(message);
    this.login = login;
  }
}

export const orgUrl = (org: string) => org.trim().replace(/\/+$/, "");
export const validOrg = (org: string) => /^https:\/\/dev\.azure\.com\/[\w.-]+\/?$/.test(org.trim());
/** Wings refuses az arguments starting with "-" or "@". */
export const safeArg = (v: string) => !!v.trim() && !/^[-@]/.test(v);

/** A read-only az call. */
export async function az<T = unknown>(args: string[], org: string | null): Promise<T | null> {
  counter.calls++;
  const out = await wings.exec("az", [...args, ...(org ? ["--organization", orgUrl(org)] : []), "-o", "json"], { timeoutMs: 60_000 });
  if (out.code !== 0) {
    const message = out.stderr.trim().split("\n").filter((l) => l && !/^WARNING/.test(l)).at(-1) || `az exited with ${out.code}`;
    throw new AzError(message, /login/i.test(out.stderr));
  }
  return out.stdout.trim() ? (JSON.parse(out.stdout) as T) : null;
}

export const invoke = <T = unknown>(org: string | null, resource: string, route: string[], query: string[] = [], area = "wit", version = "7.1") =>
  az<T>(["devops", "invoke", "--area", area, "--resource", resource, "--route-parameters", ...route, ...(query.length ? ["--query-parameters", ...query] : []), "--api-version", version], org);

interface Entry {
  value?: unknown;
  error?: string;
  promise?: Promise<unknown>;
}
/** Loaded lists by key: { value } once loaded, { error } if it failed, or a pending promise. */
const lists = new Map<string, Entry>();

export type Loaded<T> = { value?: T; error?: string; loading: boolean };

/** Loads a list once and re-renders when it lands. Returns what's known now. */
export function want<T>(key: string, load: () => Promise<T>): Loaded<T> {
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
      (error: unknown) => {
        e.error = String((error as Error | null)?.message ?? error);
        delete e.promise;
        render();
        throw error;
      },
    );
    // Rendering reads the entry; a failed load shows as a message, so nothing waits on this promise.
    e.promise.catch(() => {});
    lists.set(key, entry);
  }
  // The key says what was loaded, so its value is the T its loader returns.
  return { value: entry.value as T | undefined, error: entry.error, loading: !!entry.promise };
}

/** Waits for a list, for detection. */
export async function need<T>(key: string, load: () => Promise<T>): Promise<T> {
  want(key, load);
  const entry = lists.get(key)!;
  if (entry.promise) return entry.promise as Promise<T>;
  if (entry.error) throw new Error(entry.error);
  return entry.value as T;
}

export const projectsOf = (org: string) => async () => {
  const out = await az<{ value?: Named[] } | Named[]>(["devops", "project", "list", "--top", "500"], org);
  return ((out && !Array.isArray(out) ? out.value : undefined) ?? (out as Named[] | null) ?? []).map((p) => String(p.name)).sort();
};

/** Types with their states, type categories, fields, tags, teams and your teams: six calls, once per project. */
export const metaOf = (org: string, project: string) => async () => {
  const route = [`project=${project}`];
  const [types, categories, fields, tags, teams, mine] = await Promise.all([
    invoke<{ value?: TypeJson[] }>(org, "workItemTypes", route),
    invoke<{ value?: { referenceName: unknown; workItemTypes?: Named[] }[] }>(org, "workItemTypeCategories", route),
    invoke<{ value?: { referenceName: unknown; name: unknown; type: unknown }[] }>(org, "fields", route),
    invoke<{ value?: Named[] }>(org, "tags", route),
    az<Named[]>(["devops", "team", "list", "--project", project, "--top", "500"], org),
    // $mine lists the teams the signed-in user is in, so nobody has to say who they are.
    invoke<{ value?: Named[] }>(org, "teams", [`projectId=${project}`], ["$mine=true"], "core", "7.1-preview"),
  ]);
  const meta: ProjectMeta = {
    types: (types?.value ?? [])
      .filter((t) => !t.isDisabled)
      .map((t) => ({
        name: String(t.name),
        color: /^[0-9a-f]{6}$/i.test(String(t.color)) ? `#${t.color}` : "#888888",
        states: (t.states ?? []).map((s) => ({ name: String(s.name), category: String(s.category), color: /^[0-9a-f]{6}$/i.test(String(s.color)) ? `#${s.color}` : "#888888" })),
      })),
    categories: new Map((categories?.value ?? []).map((c) => [String(c.referenceName), (c.workItemTypes ?? []).map((t) => String(t.name))])),
    fields: (fields?.value ?? []).map((f) => ({ ref: String(f.referenceName), name: String(f.name), type: String(f.type) })),
    tags: (tags?.value ?? []).map((t) => String(t.name)).sort((a, b) => a.localeCompare(b)),
    teams: (teams ?? []).map((t) => String(t.name)).sort(),
    myTeams: (mine?.value ?? []).map((t) => String(t.name)),
  };
  return meta;
};

/** Text fields that could hold a blocking ticket: their name or reference name says "block". */
const blockFieldsOf = (meta: ProjectMeta) => meta.fields.filter((f) => ["string", "plainText"].includes(f.type) && /block/i.test(`${f.ref} ${f.name}`)).map((f) => f.ref);

/** The team's areas as WIQL, each path with or without its children, as on the team's board. */
function areaClause(area: AreaJson | null, q: (v: string) => string) {
  const values = area?.values ?? [];
  if (!values.length) throw new Error("The team has no areas.");
  return values.map((v) => `[System.AreaPath] ${v.includeChildren ? "UNDER" : "="} ${q(String(v.value))}`).join(" OR ");
}

/** The team's current sprint and its items, with the fields detection looks at. Three calls. */
export const sprintOf = (org: string, project: string, team: string) => async () => {
  const meta = await need(`meta|${org}|${project}`, metaOf(org, project));
  const [iterations, area] = await Promise.all([
    az<IterationJson[]>(["boards", "iteration", "team", "list", "--team", team, "--timeframe", "current", "--project", project], org),
    az<AreaJson>(["boards", "area", "team", "list", "--team", team, "--project", project], org),
  ]);
  const it = iterations?.[0];
  if (!it) throw new Error(`${team} has no current sprint.`);
  const refs = new Set(meta.fields.map((f) => f.ref));
  const blockFields = blockFieldsOf(meta);
  const pointFields = POINT_FIELDS.filter((f) => refs.has(f));
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const select = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "System.Tags", "System.Parent", "System.CreatedDate", "System.ChangedDate", ...blockFields, ...pointFields].map((f) => `[${f}]`).join(", ");
  const wiql = `SELECT ${select} FROM WorkItems WHERE [System.TeamProject] = ${q(project)} AND [System.IterationPath] = ${q(String(it.path))} AND (${areaClause(area, q)}) AND [System.State] <> 'Removed'`;
  const rows = (await az<RowJson[]>(["boards", "query", "--wiql", wiql, "--project", project], org)) ?? [];
  const data: SprintData = {
    sprint: { name: String(it.name), path: String(it.path), start: it.attributes?.startDate ?? null, finish: it.attributes?.finishDate ?? null },
    blockFields,
    pointFields,
    items: rows.map((r) => {
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

export const teamMembersOf = (org: string, project: string, team: string) => async (): Promise<Person[]> => {
  const out = await az<{ identity?: { isContainer?: boolean; displayName?: string; uniqueName?: string } }[]>(["devops", "team", "list-member", "--team", team, "--project", project, "--top", "500"], org);
  return (out ?? [])
    .map((m) => m.identity ?? {})
    .filter((i) => !i.isContainer && i.displayName)
    .map((i) => ({ name: String(i.displayName), login: String(i.uniqueName ?? "") }));
};

/** Everyone in the organization, so the people step can find someone who isn't in the team or the sprint. */
export const orgUsersOf = (org: string) => async (): Promise<Person[]> => {
  const out = await az<{ members?: { user?: { displayName?: string; subjectKind?: string; mailAddress?: string; principalName?: string } }[] }>(["devops", "user", "list", "--top", "10000"], org);
  return (out?.members ?? [])
    .map((m) => m.user ?? {})
    .filter((u) => u.displayName && u.subjectKind !== "group")
    .map((u) => ({ name: String(u.displayName), login: String(u.mailAddress || u.principalName || "") }));
};

/** The signed-in az account, read locally. */
export const meOf = () => async () => String((await az(["account", "show", "--query", "user.name"], null)) ?? "");
