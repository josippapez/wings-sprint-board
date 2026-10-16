// The lists the settings steps read from Azure DevOps, each kept in memory per organization, project and team, so a
// render never asks for them again.

import { cached } from "wings-plugin-sdk/async";

import { azJson } from "./azure";

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

export const orgUrl = (org: string) => org.trim().replace(/\/+$/, "");
export const validOrg = (org: string) => /^https:\/\/dev\.azure\.com\/[\w.-]+\/?$/.test(org.trim());
/** Wings refuses az arguments starting with "-" or "@". */
export const safeArg = (v: string) => !!v.trim() && !/^[-@]/.test(v);

const az = azJson;

export const invoke = <T = unknown>(org: string | null, resource: string, route: string[], query: string[] = [], area = "wit", version = "7.1") =>
  az<T>(["devops", "invoke", "--area", area, "--resource", resource, "--route-parameters", ...route, ...(query.length ? ["--query-parameters", ...query] : []), "--api-version", version], org);

/** What names a project's lists. */
interface Project {
  org: string;
  project: string;
}
interface Team extends Project {
  team: string;
}
const byJson = { key: JSON.stringify };

export const projectsOf = cached(async (org: string) => {
  const out = await az<{ value?: Named[] } | Named[]>(["devops", "project", "list", "--top", "500"], org);
  return ((out && !Array.isArray(out) ? out.value : undefined) ?? (out as Named[] | null) ?? []).map((p) => String(p.name)).sort();
});

/** Types with their states, type categories, fields, tags, teams and your teams: six calls, once per project. */
export const metaOf = cached(async ({ org, project }: Project) => {
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
}, byJson);

/** Text fields that could hold a blocking ticket: their name or reference name says "block". */
const blockFieldsOf = (meta: ProjectMeta) => meta.fields.filter((f) => ["string", "plainText"].includes(f.type) && /block/i.test(`${f.ref} ${f.name}`)).map((f) => f.ref);

/** The team's areas as WIQL, each path with or without its children, as on the team's board. */
function areaClause(area: AreaJson | null, q: (v: string) => string) {
  const values = area?.values ?? [];
  if (!values.length) throw new Error("The team has no areas.");
  return values.map((v) => `[System.AreaPath] ${v.includeChildren ? "UNDER" : "="} ${q(String(v.value))}`).join(" OR ");
}

/** The team's current sprint and its items, with the fields detection looks at. Three calls. */
export const sprintOf = cached(async ({ org, project, team }: Team) => {
  const meta = await metaOf.get({ org, project });
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
}, byJson);

export const teamMembersOf = cached(async ({ org, project, team }: Team): Promise<Person[]> => {
  const out = await az<{ identity?: { isContainer?: boolean; displayName?: string; uniqueName?: string } }[]>(["devops", "team", "list-member", "--team", team, "--project", project, "--top", "500"], org);
  return (out ?? [])
    .map((m) => m.identity ?? {})
    .filter((i) => !i.isContainer && i.displayName)
    .map((i) => ({ name: String(i.displayName), login: String(i.uniqueName ?? "") }));
}, byJson);

/** Everyone in the organization, so the people step can find someone who isn't in the team or the sprint. */
export const orgUsersOf = cached(async (org: string): Promise<Person[]> => {
  const out = await az<{ members?: { user?: { displayName?: string; subjectKind?: string; mailAddress?: string; principalName?: string } }[] }>(["devops", "user", "list", "--top", "10000"], org);
  return (out?.members ?? [])
    .map((m) => m.user ?? {})
    .filter((u) => u.displayName && u.subjectKind !== "group")
    .map((u) => ({ name: String(u.displayName), login: String(u.mailAddress || u.principalName || "") }));
});

/** The signed-in az account, read locally. */
export const meOf = cached(async (_key: string) => String((await az(["account", "show", "--query", "user.name"], null)) ?? ""));
