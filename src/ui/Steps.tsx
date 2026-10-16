// The setup steps: one question each, the detected answer picked, a "why" line, and a live preview from the real
// sprint of what the answer does.

import { Fragment, type ReactNode } from "react";
import { Badge, Dot, Row, Stack, Text } from "wings-plugin-ui";

import { orgUsersOf, type SprintItem } from "../lib/lists";
import { want } from "./want";
import { counted, settle, setup, workingDaysAgo, type Ctx, type Draft } from "./setup";
import { avatar, dot } from "./bits";
import { labelled, labelledGroup, listStatus, pickMany, pickOne, TextField } from "./Pickers";

const typeColorOf = (c: Ctx, type: string) => c.m?.types.find((t) => t.name === type)?.color ?? "#888888";

/** A board row as the sidebar will draw it, for previews. */
const previewRow = (c: Ctx, i: SprintItem, o: { dim?: boolean; chips?: ReactNode[] } = {}) => (
  <Row key={i.id} gap="s" className={`preview-row${o.dim ? " dim" : ""}`}>
    {dot(typeColorOf(c, i.type), i.type)}
    <Text mono size="tiny" tone="muted" numeric>{String(i.id)}</Text>
    <Text size="small" truncate grow>{i.title}</Text>
    {o.chips ?? []}
    {avatar(i.assignee)}
  </Row>
);

/** The preview card under a step. */
const preview = (caption: string, ...body: ReactNode[]) => (
  <Stack gap="s" className="preview">
    <Text size="tiny" weight="strong" tone="muted" className="caption">{caption}</Text>
    {body}
  </Stack>
);
const noExample = () => <Text key="none" as="p" tone="muted" size="small">No example in this sprint.</Text>;
const waitFor = (c: Ctx) => listStatus(c.sprint, "the sprint") ?? (c.data ? null : <Text as="p" tone="muted" size="small">Pick a team to see an example.</Text>);

/** Items assigned to the chosen people. */
const peopleItems = (c: Ctx) => (c.data?.items ?? []).filter((i) => i.assignee && (c.d.members ?? []).includes(i.assignee));

/** The steps. `ready` says whether Next is allowed, `off` clears an optional check. */
export const STEPS: {
  id: string;
  question: string;
  explain: string;
  optional?: boolean;
  off?: (d: Draft) => void;
  ready?: (c: Ctx) => boolean;
  why: (c: Ctx) => string | null;
  body: (c: Ctx) => ReactNode[];
  show: (c: Ctx) => ReactNode;
}[] = [
  {
    id: "where",
    question: "Where is your board?",
    explain: "The Azure DevOps organization and project your team's sprint lives in.",
    ready: (c) => c.orgOk && !!c.project,
    why: (c) => (setup.repos.length && setup.repos.some((r) => r.org === c.org && r.project === c.project) ? `Found in ${setup.repos.find((r) => r.org === c.org && r.project === c.project)?.panes} of the repos open in Wings.` : setup.repos.length ? null : "No Azure DevOps repo is open in Wings, so pick it here."),
    body: (c) => [
      pickOne("Organization", "org", setup.repos.length ? [...new Set(setup.repos.map((r) => r.org))] : undefined, { placeholder: "https://dev.azure.com/your-org" }),
      pickOne("Project", "project", c.projects?.value),
      listStatus(c.projects, "projects"),
    ],
    show: (c) =>
      setup.repos.length
        ? preview("Azure DevOps repos open in Wings", ...setup.repos.slice(0, 4).map((r, n) => (
            <Row key={n} gap="s" className={`preview-row${r.org === c.org && r.project === c.project ? "" : " dim"}`}>
              <Text size="small" truncate grow>{`${r.project} · ${r.org.replace("https://dev.azure.com/", "")}`}</Text>
              <Badge variant="outline">{`${r.panes} pane${r.panes > 1 ? "s" : ""}`}</Badge>
            </Row>
          )))
        : null,
  },
  {
    id: "team",
    question: "Which team's sprint?",
    explain: "The board shows the current sprint of this team, in the areas the team owns.",
    ready: (c) => !!c.m && c.m.teams.includes(c.team),
    why: (c) => (c.m?.myTeams.includes(c.team) ? `You're in ${c.m.myTeams.length} team${c.m.myTeams.length > 1 ? "s" : ""} here${c.m.myTeams.length > 1 ? "; this one has the most items in its current sprint" : ""}.` : null),
    body: (c) => [pickOne("Team", "team", c.m?.teams, { labels: (t) => (c.m?.myTeams.includes(t) ? `${t} (yours)` : t) }), listStatus(c.meta, "the project's teams")],
    show: (c) => {
      if (!c.data) return waitFor(c);
      const cats = counted(c.data.items.map((i) => c.m?.types.find((t) => t.name === i.type)?.states.find((s) => s.name === i.state)?.category ?? "Other"));
      const colors: Record<string, string> = { Proposed: "var(--wings-muted)", InProgress: "var(--wings-info)", Resolved: "var(--wings-warning)", Completed: "var(--wings-success)" };
      const names: Record<string, string> = { Proposed: "Not started", InProgress: "In progress", Resolved: "Resolved", Completed: "Done" };
      return preview(
        `${c.data.sprint.name} · ${c.data.items.length} items`,
        <div key="bar" className="bar">{cats.map(([cat, n]) => <span key={cat} style={{ flex: n, background: colors[cat] ?? "var(--wings-hairline-strong)" }} title={`${names[cat] ?? cat}: ${n}`} />)}</div>,
        <Row key="legend" wrap>{cats.map(([cat, n]) => <Row key={cat} as="span" gap="s"><Dot color={colors[cat] ?? "var(--wings-hairline-strong)"} /><Text size="tiny" tone="muted">{`${names[cat] ?? cat} ${n}`}</Text></Row>)}</Row>,
      );
    },
  },
  {
    id: "people",
    question: "Whose work do you follow?",
    explain: "The board checks and \"Working on\" cover these people. You're picked; add teammates you look after. The board's own Everyone / Mine filter doesn't depend on this.",
    ready: (c) => (c.d.members ?? []).length > 0,
    why: (c) => (c.me && (c.d.members ?? []).length === 1 && c.data?.items.some((i) => i.assigneeLogin?.toLowerCase() === c.me?.toLowerCase() && i.assignee === c.d.members![0]) ? "You're signed in to az as this person." : null),
    body: (c) => {
      const hints = new Map<string, number>(counted((c.data?.items ?? []).map((i) => i.assignee ?? "").filter(Boolean)));
      for (const mem of c.members?.value ?? []) if (!hints.has(mem.name)) hints.set(mem.name, 0);
      const users = want(orgUsersOf, c.org);
      return [
        <Fragment key="members">
          {pickMany("members", [...hints.keys()].sort((a, b) => (hints.get(b) ?? 0) - (hints.get(a) ?? 0) || a.localeCompare(b)), {
            labels: (n) => (hints.get(n) ? `${n} · ${hints.get(n)} in sprint` : n),
            extra: users.value ? "Search everyone by name or email" : "Add a display name, then Enter",
            suggest: users.value,
          })}
        </Fragment>,
        listStatus(c.sprint, "the sprint's people"),
        listStatus(users, "the organization's people"),
      ];
    },
    show: (c) => {
      if (!c.data) return waitFor(c);
      const items = peopleItems(c);
      return preview(`Their work in this sprint · ${items.length}`, ...(items.length ? items.slice(0, 4).map((i) => previewRow(c, i, { chips: [<Badge variant="outline" key="state" className="state">{i.state}</Badge>] })) : [noExample()]), items.length > 4 ? <Text key="more" as="p" tone="muted" size="small">{`+ ${items.length - 4} more`}</Text> : null);
    },
  },
  {
    id: "stories",
    question: "Which work items are stories, and which are the tasks under them?",
    explain: "A story is the piece of work a board row stands for; tasks are its children. If only some stories are your team's, say which tasks mark them.",
    why: (c) => (c.m ? "Stories come from the process's requirement types; tasks are the types found under them in this sprint." : null),
    body: (c) => [
      labelledGroup("Stories are", pickMany("storyTypes", c.typeNames)),
      labelledGroup("Tasks under a story are", pickMany("childTypes", c.typeNames)),
      labelledGroup("A story is your team's when it has a task of type", pickMany("scopeChildTypes", c.typeNames), "None picked means every story is your team's."),
    ],
    show: (c) => {
      if (!c.data) return waitFor(c);
      const d = c.d;
      const stories = c.data.items.filter((i) => (d.storyTypes ?? []).includes(i.type));
      const kidsOf = (id: number) => c.data?.items.filter((i) => i.parent === id) ?? [];
      const mine = (s: SprintItem) => !(d.scopeChildTypes ?? []).length || kidsOf(s.id).some((k) => d.scopeChildTypes!.includes(k.type));
      const story = stories.find((s) => mine(s) && kidsOf(s.id).length) ?? stories.find((s) => kidsOf(s.id).length);
      if (!story) return preview("A story and its tasks", noExample());
      const kids = kidsOf(story.id).slice(0, 5);
      return preview(
        mine(story) ? "Your team's story, with its tasks" : "A story that isn't your team's",
        previewRow(c, story, { chips: [mine(story) ? <Badge key="mine" tone="success">Yours</Badge> : <Badge variant="outline" key="mine">Not yours</Badge>] }),
        ...kids.map((k) => <div key={k.id} className="preview-child">{previewRow(c, k, { dim: !(d.childTypes ?? []).includes(k.type), chips: [(d.childTypes ?? []).includes(k.type) ? <Badge variant="outline" key="checked">checked</Badge> : null] })}</div>),
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
    body: (c) => [labelledGroup("Types", pickMany("itemTypes", c.typeNames)), labelledGroup("Title prefixes", pickMany("titlePrefixes", [], { extra: "Add a prefix, then Enter" }))],
    show: (c) => {
      if (!c.data) return waitFor(c);
      const d = c.d;
      const items = c.data.items.filter((i) => (d.itemTypes ?? []).includes(i.type) && ((i.assignee && (d.members ?? []).includes(i.assignee)) || (d.titlePrefixes ?? []).some((p) => i.title.toLowerCase().startsWith(p.toLowerCase()))));
      return preview(`Included now · ${items.length}`, ...(items.length ? items.slice(0, 4).map((i) => previewRow(c, i)) : [noExample()]));
    },
  },
  {
    id: "blocked",
    question: "Where do you write what blocks an item?",
    explain: "A text field holding the blocking ticket's number. Items with it set get a red Blocked mark, and the checks flag text that isn't a ticket number, or a ticket that's already closed.",
    optional: true,
    off: (d) => (d.blockedByField = ""),
    why: (c) => (c.d.blockedByField && c.data ? `It has "block" in its name and is set on ${c.data.items.filter((i) => String(i.values[c.d.blockedByField!] ?? "").trim()).length} sprint items.` : null),
    body: (c) => {
      const fields = c.m?.fields.filter((f) => ["string", "plainText"].includes(f.type)).sort((a, b) => Number(!/block/i.test(`${a.ref} ${a.name}`)) - Number(!/block/i.test(`${b.ref} ${b.name}`)) || a.name.localeCompare(b.name));
      return [pickOne("Field", "blockedByField", fields?.map((f) => f.ref), { none: "None (checks off)", labels: (ref) => `${c.m?.fields.find((f) => f.ref === ref)?.name ?? ref} (${ref})`, placeholder: "Custom.Blocker" })];
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
        previewRow(c, example, { chips: [<Badge key="blocked" tone="danger">Blocked</Badge>] }),
        <Text key="value" as="p" size="small">{`${field.split(".").at(-1)}: "${value}"`}</Text>,
        <Text key="says" as="p" size="small" tone="muted">{/^\s*#?\d/.test(value) ? "Starts with a ticket number, so it links to that item." : "Not a ticket number, so the checks propose putting the blocking ticket's number first."}</Text>,
      );
    },
  },
  {
    id: "goal",
    question: "Which tag marks the sprint's priority work?",
    explain: "Items with this tag, or under a story with it, are goal work. The checks tell you when someone has only blocked or non-goal work left.",
    optional: true,
    off: (d) => (d.goalTag = ""),
    why: (c) => (c.d.goalTag && c.data ? `The tag with "goal" in it used most in this sprint: on ${c.data.items.filter((i) => i.tags.includes(c.d.goalTag!)).length} items.` : null),
    body: (c) => {
      const counts = new Map(counted((c.data?.items ?? []).flatMap((i) => i.tags)));
      const tags = c.m ? [...[...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0)), ...c.m.tags.filter((t) => !counts.has(t))] : undefined;
      return [pickOne("Tag", "goalTag", tags, { none: "None (test off)", labels: (t) => (counts.get(t) ? `${t} · ${counts.get(t)} in sprint` : t) })];
    },
    show: (c) => {
      if (!c.data) return waitFor(c);
      if (!c.d.goalTag) return preview("The lower-priority test is off");
      const items = c.data.items.filter((i) => i.tags.includes(c.d.goalTag!));
      return preview(`Goal work · ${items.length}`, ...(items.length ? items.slice(0, 3).map((i) => previewRow(c, i, { chips: [<Badge key="goal" tone="success">Goal</Badge>] })) : [noExample()]));
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
        labelledGroup("Tags", pickMany("addedTags", [...counts.keys()], { labels: (t) => `${t} · ${counts.get(t) ?? 0} in sprint`, extra: "Add a tag, then Enter" })),
        labelledGroup("Types that need points", pickMany("pointTypes", c.typeNames)),
        labelledGroup("Point fields", pickMany("pointFields", numbers, { labels: (ref) => `${c.m?.fields.find((f) => f.ref === ref)?.name ?? ref}` })),
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
          ? added.slice(0, 4).map((i) => previewRow(c, i, { chips: [tags.length ? (tags.every((t) => i.tags.includes(t)) ? <Badge key="tag" tone="success">tagged</Badge> : <Badge key="tag" tone="warn">missing tag</Badge>) : null] }))
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
        labelledGroup("States", pickMany("codeReviewStates", states)),
        labelled("Skip pull requests titled", "f-parkedPrPrefix", <TextField type="text" autoComplete="off" placeholder="Leave empty to check them all" read={() => c.d.parkedPrPrefix ?? ""} onChange={(e) => (c.d.parkedPrPrefix = e.target.value)} />, "A pull request whose title starts with this is parked on purpose."),
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
        <Stack key="flow" gap="xs">
          {flow.map((s, n) => (
            <Stack key={n} gap="s" className={`flow-step${review.includes(s.name) ? " review" : ""}`}>
              <Text size="small">{s.name}</Text>
              {n === at ? <Row gap="s" className="flow-card"><Text truncate grow>{example ? `${example.id} ${example.title}` : "An item here"}</Text><Badge tone="info">PR open?</Badge></Row> : null}
            </Stack>
          ))}
        </Stack>,
        at < 0 ? <Text key="none" as="p" tone="muted" size="small">No review state picked for this type.</Text> : null,
      );
    },
  },
  {
    id: "stale",
    question: "When is in-progress work stale?",
    explain: "An item in progress with no change for this many working days is listed as stale. Weekends don't count.",
    why: () => null,
    body: (c) => [labelled("Working days", "f-staleDays", <TextField type="number" min={1} read={() => c.d.staleDays ?? 3} onChange={(e) => ((c.d.staleDays = e.target.value), settle())} />)],
    show: (c) => {
      if (!c.data) return waitFor(c);
      const days = Math.max(1, Number(c.d.staleDays) || 3);
      const active = c.data.items.filter((i) => ["InProgress", "Resolved"].includes(c.m?.types.find((t) => t.name === i.type)?.states.find((s) => s.name === i.state)?.category ?? ""));
      const stale = active.filter((i) => workingDaysAgo(i.changed) >= days);
      return preview(`Stale now · ${stale.length} of ${active.length} in progress`, ...(stale.length ? stale.slice(0, 4).map((i) => previewRow(c, i, { chips: [<Badge key="days" tone="warn">{`${workingDaysAgo(i.changed)}d`}</Badge>] })) : [<Text key="none" as="p" tone="muted" size="small">Nothing in progress has gone that long without a change.</Text>]));
    },
  },
];
