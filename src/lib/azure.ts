import { cached, errorMessage, mapLimit } from "wings-plugin-sdk/async";
import { workItems } from "wings-plugin-sdk/azure";
import { cli } from "wings-plugin-sdk/cli";
import { azureApiOrg } from "wings-plugin-sdk/git";

import { org, type Settings } from "./settings";

/** How many az calls run at once. */
export const PARALLEL = 6;

export interface Item {
  id: number;
  title: string;
  type: string;
  state: string;
  assignee: string | null;
  tags: string[];
  blockedBy: string;
  parent: number | null;
  iteration: string;
  changed: string;
  created: string;
  points: (number | null)[];
  login: string | null;
  rev: number;
  comments: number;
}

export type Relation = { rel: string; url: string };

/** A work item's fields as `az` returns them. */
export type Fields = Record<string, unknown> & { "System.AssignedTo"?: { displayName?: string; uniqueName?: string } };

/** A row of `az boards query`. */
interface QueryRow {
  id: number;
  rev?: number;
  fields?: Fields;
}

/** A type of `workItemTypes`, with its states. */
interface WorkItemTypeJson {
  name: unknown;
  color: unknown;
  states?: { name: unknown; category: unknown; color: unknown }[];
}

// ---------- az ----------

/** The Azure CLI, with "not installed" and "signed out" told apart from a failure. */
export const azCli = cli("az", { signedOut: /login/i, signIn: ["login", "--allow-no-subscriptions", "--output", "none"] });

/** Counts az calls in the current check, for the report. */
export const counter = { calls: 0 };

/** Runs a read-only az command for an organization (none for a local one like `az account show`) and parses its JSON. */
export function azJson<T = unknown>(args: string[], organization: string | null): Promise<T | null> {
  counter.calls++;
  return azCli.json<T | null>([...args, ...(organization ? ["--organization", organization] : []), "-o", "json"], {
    timeoutMs: 60_000,
    key: organization ?? undefined,
    empty: null,
  });
}

/** `azJson` for the organization of the settings. */
export const az = <T = unknown>(args: string[], s: Settings) => azJson<T>(args, org(s));

/** What went wrong, in one line: the last line of az's message that isn't a warning. */
export function failure(error: unknown) {
  const text = errorMessage(error);
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !/^WARNING/.test(l)).at(-1) || text;
}

const fields = (s: Settings) =>
  [
    "System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "System.Tags",
    "System.Parent", "System.IterationPath", "System.ChangedDate", "System.CreatedDate", "System.Rev", "System.CommentCount",
    ...(s.blockedByField ? [s.blockedByField] : []), ...s.pointFields,
  ].map((f) => `[${f}]`).join(", ");

/** A flat WIQL query. `az boards query` reads the selected fields itself, 200 ids per request. */
export async function query(where: string, s: Settings): Promise<Item[]> {
  const wiql = `SELECT ${fields(s)} FROM WorkItems WHERE ${where}`;
  const rows = (await az<QueryRow[]>(["boards", "query", "--wiql", wiql, "--project", s.project], s)) ?? [];
  return rows.map((row) => toItem(row, s));
}

function toItem(row: QueryRow, s: Settings): Item {
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
    login: f["System.AssignedTo"]?.uniqueName ?? null,
    rev: typeof f["System.Rev"] === "number" ? f["System.Rev"] : (row.rev ?? 0),
    comments: typeof f["System.CommentCount"] === "number" ? f["System.CommentCount"] : 0,
  };
}

const loaders = new Map<string, ReturnType<typeof workItems>>();

/** The item's links. Items asked in the same turn go out as one `az rest` call, 200 at most. */
export async function relations(id: number, s: Settings): Promise<Relation[]> {
  const organization = org(s);
  let loader = loaders.get(organization);
  if (!loader) {
    const counted = { ...azCli, json: (args: string[], call?: Parameters<typeof azCli.json>[1]) => (counter.calls++, azCli.json(args, call)) } as typeof azCli;
    loader = workItems(counted, organization);
    loaders.set(organization, loader);
  }
  const item = await loader.get(id);
  return (item?.relations ?? []).map((r) => ({ rel: r.rel ?? "", url: r.url ?? "" }));
}

/** A pull request a work item links to, with the project it is in. */
export interface PullRequestRef {
  id: number;
  project: string;
}

/** Pull requests from ArtifactLinks like vstfs:///Git/PullRequestId/{projectId}%2F{repositoryId}%2F{prId}. */
export function pullRequestRefs(rels: Relation[]): PullRequestRef[] {
  return rels
    .filter((r) => r.rel === "ArtifactLink" && /^vstfs:\/\/\/Git\/PullRequestId\//i.test(r.url))
    .map((r) => decodeURIComponent(r.url).split("/"))
    .map((parts) => ({ id: Number(parts.at(-1)), project: parts.at(-3) ?? "" }))
    .filter((p) => Number.isInteger(p.id) && p.id > 0);
}

export const pullRequestIds = (rels: Relation[]) => pullRequestRefs(rels).map((p) => p.id);

/** Pull requests per call of the project's list: 500 keep an answer near 3 MB, and `exec` gives up past 8 MB. */
const PR_PAGE = 500;
/** Pages read before the rest are asked for one by one. */
const PR_PAGES = 4;
const DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

type PullRequestRow = { pullRequestId: number; status?: unknown; title?: unknown };

const pullRequestRest = (url: string, key: string) => {
  counter.calls++;
  return azCli.json<PullRequestRow | { value: PullRequestRow[] }>(["rest", "--resource", DEVOPS_RESOURCE, "--url", url, "-o", "json"], { timeoutMs: 60_000, key });
};

/**
 * The status and title of pull requests. The newest first of a project's list answer for many at once, a few calls in
 * all; one older than that is asked for by id.
 */
export async function pullRequests(refs: PullRequestRef[], s: Settings) {
  const base = azureApiOrg(org(s));
  const found = new Map<number, { status: string; title: string }>();
  const take = (row: PullRequestRow) => found.set(row.pullRequestId, { status: String(row.status ?? ""), title: String(row.title ?? "") });
  for (const project of new Set(refs.map((r) => r.project))) {
    const wanted = new Set(refs.filter((r) => r.project === project).map((r) => r.id));
    const oldest = Math.min(...wanted);
    for (let page = 0; page < PR_PAGES && wanted.size; page++) {
      const url = `${base}/${project}/_apis/git/pullrequests?searchCriteria.status=all&$top=${PR_PAGE}&$skip=${page * PR_PAGE}&api-version=7.1`;
      const { value } = (await pullRequestRest(url, org(s))) as { value: PullRequestRow[] };
      for (const row of value) if (wanted.delete(row.pullRequestId)) take(row);
      // Newest first: a page that reaches the oldest one we want, or the end of the list, has all there is.
      if (value.length < PR_PAGE || value.some((row) => row.pullRequestId <= oldest)) break;
    }
  }
  const rest = [...new Set(refs.map((r) => r.id))].filter((id) => !found.has(id));
  for (const [id, row] of await mapLimit(rest, PARALLEL, async (id) => [id, (await pullRequestRest(`${base}/_apis/git/pullrequests/${id}?api-version=7.1`, org(s))) as PullRequestRow] as const)) take({ ...row, pullRequestId: id });
  return found;
}

/** Work item ids a relation of this kind points to. */
export const linked = (rels: Relation[], rel: string) => rels.filter((r) => r.rel === rel).map((r) => Number(r.url.split("/").at(-1))).filter(Number.isInteger);
export const PREDECESSOR = "System.LinkTypes.Dependency-Reverse";
export const RELATED = "System.LinkTypes.Related";

export interface StateInfo {
  name: string;
  category: string;
  color: string;
}
export interface TypeInfo {
  color: string;
  states: StateInfo[];
}
/** Each project's work item types: their colour, and their states in board order with each state's category (Proposed, InProgress, Resolved, Completed, Removed) and colour. Read once per project, since a process rarely changes. */
const projectTypes = cached(
  async (s: Settings) => {
    const out = await az<{ value?: WorkItemTypeJson[] }>(["devops", "invoke", "--area", "wit", "--resource", "workItemTypes", "--route-parameters", `project=${s.project}`, "--api-version", "7.1"], s);
    const hex = (c: unknown) => (/^[0-9a-f]{6}$/i.test(String(c)) ? `#${c}` : "#888888");
    return new Map(
      (out?.value ?? []).map((t): [string, TypeInfo] => [
        String(t.name),
        { color: hex(t.color), states: (t.states ?? []).map((x) => ({ name: String(x.name), category: String(x.category), color: hex(x.color) })) },
      ]),
    );
  },
  { key: (s) => `${s.org}|${s.project}` },
);

/** One call reads every type of the project with its states. */
export async function loadStates(s: Settings) {
  const types = await projectTypes.get(s);
  const category = (item: { type: string; state: string }) => types.get(item.type)?.states.find((x) => x.name === item.state)?.category ?? "";
  /** The first state of a type in this category, like "In Progress". */
  const firstOf = (type: string, cat: string) => types.get(type)?.states.find((x) => x.category === cat)?.name ?? null;
  return { category, firstOf, types };
}
