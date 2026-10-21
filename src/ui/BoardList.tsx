// The board view of the sidebar: the sprint's items grouped by state with their children nested, and filters.

import { Badge, Empty, ListButton, Row, SearchField, Select, Stack, Text } from "wings-plugin-ui";

import { board, isOpen, openItem, outside, saveView, searchOutside, stateInfo, toggle, typeColor, type BoardItem } from "./board";
import { meOf } from "../lib/lists";
import { render } from "./page";
import { avatar, CARET, dot, errorLine, icon, spinner } from "./bits";
import { need } from "./want";

const CATEGORY_ORDER = ["Proposed", "InProgress", "Resolved", "Completed", "Removed"];

/** A pull request's status as a tone: open is info, completed success. */
export const prTone = (status: string) => (status === "active" ? "info" : status === "completed" ? "success" : undefined);

/** The most telling of an item's pull requests: an open one, else a completed one. */
function prChip(i: BoardItem) {
  if (!i.prs?.length) return null;
  const pr = i.prs.find((p) => p.status === "active") ?? i.prs.find((p) => p.status === "completed") ?? i.prs[0];
  return <Badge tone={prTone(pr.status)} title={i.prs.map((p) => `PR !${p.id} ${p.status}`).join("\n")}>PR</Badge>;
}

// ---------- the list ----------

function itemRow(i: BoardItem, o: { child?: boolean; state?: boolean; kids?: BoardItem[] } = {}) {
  const kids = o.kids ?? [];
  const open = kids.length > 0 && isOpen(`p:${i.id}`, false);
  const done = kids.filter((k) => k.category === "Completed").length;
  const row = (
    <div key={i.id} className={`item-row${o.child ? " child" : ""}`}>
      {kids.length
        ? <button className={`twisty${open ? " open" : ""}`} type="button" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} ${kids.length} children`} title={`${done}/${kids.length} done`} onClick={() => toggle(`p:${i.id}`)}>{icon(CARET)}</button>
        : <span className="twisty-space" />}
      <ListButton className="item-main" title={`${i.type} ${i.id}: ${i.title}${i.iteration ? `\n${i.iteration}` : ""}`} onClick={() => void openItem(i.id)}>
        {dot(typeColor(i.type), i.type)}
        <Text mono size="tiny" tone="muted" numeric>{String(i.id)}</Text>
        <Text truncate grow>{i.title}</Text>
        {o.child || o.state ? <Badge variant="outline" className="state" title={i.state}>{i.state}</Badge> : null}
        {kids.length ? <Badge variant="outline" title={`${done} of ${kids.length} children done`}>{`${done}/${kids.length}`}</Badge> : null}
        {i.blocked ? <Badge tone="danger" title={`Blocked by ${i.blockedBy ?? ""}`}>Blocked</Badge> : null}
        {prChip(i)}
        {i.checks.length ? <Badge tone="warn" title={i.checks.join("\n")}>!</Badge> : null}
        {i.comments ? <Badge variant="outline" className="talk" title={`${i.comments} comment${i.comments > 1 ? "s" : ""}`}>{String(i.comments)}</Badge> : null}
        {avatar(i.assignee)}
      </ListButton>
    </div>
  );
  if (!open) return row;
  return (
    <Stack key={i.id} gap="none">
      {row}
      {kids.map((k) => itemRow(k, { child: true }))}
    </Stack>
  );
}

/** States in workflow order: by category, then by their place in their type's workflow. */
function groupByState(items: BoardItem[]) {
  const groups = new Map<string, { rank: number; color: string; category: string; items: BoardItem[] }>();
  for (const i of items) {
    const states = board.snapshot?.types[i.type]?.states ?? [];
    const at = states.findIndex((s) => s.name === i.state);
    const rank = Math.max(0, CATEGORY_ORDER.indexOf(i.category)) * 1000 + Math.max(0, at);
    const g = groups.get(i.state) ?? { rank, color: stateInfo(i.type, i.state)?.color ?? "#888888", category: i.category, items: [] };
    g.rank = Math.min(g.rank, rank);
    g.items.push(i);
    groups.set(i.state, g);
  }
  return [...groups.entries()].sort((a, b) => a[1].rank - b[1].rank);
}

/** The people and types on the board, which the filters offer. */
function options() {
  const items = board.snapshot?.items ?? [];
  const people = [...new Set(items.map((i) => i.assignee).filter((a) => !!a))].map(String).sort();
  const types = [...new Set(items.map((i) => i.type))].sort();
  return { people, types };
}

/**
 * The filters as they apply now. A saved person or type that's no longer on the board filters by Everyone or All
 * types, as the selects show; the saved view keeps it until you pick another.
 */
function filters() {
  const { people, types } = options();
  const who = board.view.who.startsWith("p:") && !people.includes(board.view.who.slice(2)) ? "all" : board.view.who;
  const type = board.view.type && !types.includes(board.view.type) ? "" : board.view.type;
  return { who, type };
}

function filterBar() {
  const view = board.view;
  const { people, types } = options();
  const { who, type } = filters();
  const set = (patch: Partial<typeof view>) => {
    Object.assign(view, patch);
    saveView();
    render();
  };
  return (
    <Stack key="filters" gap="s">
      <SearchField id="board-search" label="Search id or title" placeholder="Search id or title" autoComplete="off" spellCheck="false" value={view.q} onChange={(e) => set({ q: e.target.value })} />
      <Row>
        <Select
          id="board-who"
          label="Assigned to"
          value={who}
          onChange={(v) => set({ who: v })}
          options={[{ value: "all", label: "Everyone" }, { value: "mine", label: "Mine" }, { value: "none", label: "Unassigned" }, ...people.map((p) => ({ value: `p:${p}`, label: p }))]}
        />
        <Select id="board-type" label="Type" value={type} onChange={(v) => set({ type: v })} options={[{ value: "", label: "All types" }, ...types.map((t) => ({ value: t, label: t }))]} />
      </Row>
    </Stack>
  );
}

export function renderList() {
  const view = board.view;
  const snapshot = board.snapshot;
  if (!snapshot) return [<Row key="loading">{spinner()}<Text tone="muted">Reading the sprint board…</Text></Row>];
  const { who, type } = filters();
  if (who === "mine" && board.meLogin === null) void need(meOf, "me").then((me) => ((board.meLogin = me.toLowerCase()), render()), () => ((board.meLogin = ""), render()));
  const meLogin = board.meLogin;
  const q = view.q.trim().toLowerCase();
  const match = (i: BoardItem) =>
    (who === "all" ||
      (who === "mine" && !!meLogin && i.login?.toLowerCase() === meLogin) ||
      (who === "none" && !i.assignee) ||
      (who.startsWith("p:") && i.assignee === who.slice(2))) &&
    (!type || i.type === type) &&
    (!q || String(i.id).includes(q) || i.title.toLowerCase().includes(q));
  const filtered = who !== "all" || !!type || !!q;
  const items = snapshot.items;
  const ids = new Set(items.map((i) => i.id));
  const kids = new Map<number, BoardItem[]>();
  for (const i of items) if (i.parent && ids.has(i.parent)) kids.set(i.parent, [...(kids.get(i.parent) ?? []), i]);
  // Filtering lists matching items on their own; otherwise children sit under their story, as on the backlog.
  const top = filtered ? items.filter(match) : items.filter((i) => !(i.parent && ids.has(i.parent)));
  const groups = groupByState(top);
  searchOutside(view.q);
  const others = outside.items.filter(match);
  const outsideOpen = isOpen("outside", true);
  const outsideSection = q ? (
    <Stack key="outside" as="section" gap="none" aria-busy={outside.loading}>
      <ListButton className={`group-head${outsideOpen ? " open" : ""}`} aria-expanded={outsideOpen} onClick={() => toggle("outside")}>
        {icon(CARET)}
        <Text size="small" weight="medium" truncate className="fg">Outside this sprint</Text>
        {outside.loading ? spinner() : <Text size="small" tone="muted" numeric>{String(others.length)}</Text>}
      </ListButton>
      {outside.error ? errorLine(`Couldn't search the project: ${outside.error}`) : null}
      {outsideOpen ? <Stack gap="none">{others.map((i) => itemRow(i, { state: true }))}</Stack> : null}
    </Stack>
  ) : null;
  if (!groups.length && !q) return [filterBar(), <Empty key="empty" title={filtered ? "Nothing matches." : "The sprint has no items."} />];
  return [
    filterBar(),
    ...(groups.length ? [] : [<Text key="none" as="p" tone="muted" size="small">Nothing in this sprint matches.</Text>]),
    ...groups.map(([state, g]) => {
      const key = `s:${state}`;
      const open = isOpen(key, g.category !== "Completed" && g.category !== "Removed");
      return (
        <Stack key={key} as="section" gap="none">
          <ListButton className={`group-head${open ? " open" : ""}`} aria-expanded={open} onClick={() => toggle(key)}>
            {icon(CARET)}
            {dot(g.color)}
            <Text size="small" weight="medium" truncate className="fg">{state}</Text>
            <Text size="small" tone="muted" numeric>{String(g.items.length)}</Text>
          </ListButton>
          {open ? <Stack gap="none">{g.items.map((i) => itemRow(i, { kids: filtered ? [] : (kids.get(i.id) ?? []) }))}</Stack> : null}
        </Stack>
      );
    }),
    outsideSection,
  ];
}
