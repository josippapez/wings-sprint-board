//! The board view of the sidebar: the sprint's items grouped by state with their children nested, and filters.

use super::{
    Sidebar, View, checks_view, detail_view,
    items::{NO_SPRINT, open_item, search_outside},
    is_open,
    kit::{badge, dot, em_space, error_line, gap, muted_small, reading, spinner, strong, tabs},
    lists::team_sprints,
    save_view, setup, time, toggle, with,
};
use crate::{
    check::{BoardItem, Snapshot},
    state,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use wings_plugin::{
    messages,
    ui::{self, Node, muted, row, stack, text},
};

const CATEGORY_ORDER: [&str; 5] = ["Proposed", "InProgress", "Resolved", "Completed", "Removed"];

/// A pull request's status as a tone: open is info, completed success.
pub fn pr_tone(status: &str) -> Option<&'static str> {
    match status {
        "active" => Some("info"),
        "completed" => Some("success"),
        _ => None,
    }
}

/// The most telling of an item's pull requests: an open one, else a completed one.
fn pr_chip(i: &BoardItem) -> Option<Node> {
    let prs = i.prs.as_ref().filter(|p| !p.is_empty())?;
    let pr = prs.iter().find(|p| p.status == "active").or_else(|| prs.iter().find(|p| p.status == "completed")).unwrap_or(&prs[0]);
    Some(badge("PR", pr_tone(&pr.status)))
}

// ---------- the list ----------

#[derive(Default)]
struct RowOptions<'a> {
    child: bool,
    state: bool,
    kids: Vec<&'a BoardItem>,
}

fn item_row(s: &Sidebar, i: &BoardItem, o: RowOptions) -> Node {
    let open = !o.kids.is_empty() && is_open(&s.view, &format!("p:{}", i.id), false);
    let done = o.kids.iter().filter(|k| k.category == "Completed").count();
    let id = i.id;
    let twisty = if o.kids.is_empty() {
        em_space()
    } else {
        let key = format!("p:{id}");
        Node::new("Button")
            .prop("variant", "ghost")
            .prop("size", "xs")
            .prop("label", format!("{} {} children", if open { "Hide" } else { "Show" }, o.kids.len()))
            .on("onClick", move |_| toggle(&key))
            .child(muted(if open { "▾" } else { "▸" }))
    };
    let mut parts = vec![dot(s.type_color(&i.kind)), muted(id.to_string()).prop("mono", true).prop("size", "tiny"), text(i.title.as_str()).prop("truncate", true).prop("grow", true)];
    if o.child || o.state {
        parts.push(badge(i.state.as_str(), None));
    }
    if !o.kids.is_empty() {
        parts.push(badge(format!("{done}/{}", o.kids.len()), None));
    }
    if i.blocked {
        parts.push(badge("Blocked", Some("danger")));
    }
    parts.extend(pr_chip(i));
    if !i.checks.is_empty() {
        parts.push(badge("!", Some("warn")));
    }
    if i.comments > 0 {
        parts.push(badge(i.comments.to_string(), None));
    }
    parts.push(super::kit::avatar(i.assignee.as_deref()));
    let title = format!("{} {}: {}{}", i.kind, i.id, i.title, i.iteration.as_deref().filter(|n| !n.is_empty()).map_or(String::new(), |n| format!("\n{n}")));
    let main = ui::list_button(parts, move || open_item(id, true)).prop("title", title).key("main");
    let line = gap(row(), "none").key(format!("i{id}")).maybe(o.child.then(em_space)).child(twisty).child(main);
    if !open {
        return line;
    }
    gap(stack(), "none").key(format!("i{id}")).child(line).children(o.kids.iter().map(|k| item_row(s, k, RowOptions { child: true, ..RowOptions::default() })))
}

struct Group<'a> {
    state: String,
    rank: usize,
    color: String,
    category: String,
    items: Vec<&'a BoardItem>,
}

/// States in workflow order: by category, then by their place in their type's workflow.
fn group_by_state<'a>(items: &[&'a BoardItem], snapshot: &Snapshot) -> Vec<Group<'a>> {
    let mut groups: Vec<Group<'a>> = Vec::new();
    for i in items {
        let states = snapshot.types.get(&i.kind).map_or(&[][..], |t| t.states.as_slice());
        let at = states.iter().position(|s| s.name == i.state).unwrap_or(0);
        let rank = CATEGORY_ORDER.iter().position(|c| *c == i.category).unwrap_or(0) * 1000 + at;
        let known = groups.iter().position(|g| g.state == i.state);
        let g = match known {
            Some(at) => &mut groups[at],
            None => {
                let color = states.iter().find(|s| s.name == i.state).map_or("#888888", |s| s.color.as_str());
                groups.push(Group { state: i.state.clone(), rank, color: color.to_owned(), category: i.category.clone(), items: Vec::new() });
                groups.last_mut().unwrap()
            }
        };
        g.rank = g.rank.min(rank);
        g.items.push(i);
    }
    groups.sort_by_key(|g| g.rank);
    groups
}

/// The sprint picked, empty for the board's own, and the sprints to pick from: the team's coming ones, its past ones
/// latest first, and no sprint. A saved sprint the team no longer has shows the board's.
struct SprintPick {
    sprint: String,
    options: Vec<(String, String)>,
}

fn sprints(s: &Sidebar) -> SprintPick {
    let st = s.settings();
    let loaded = if !st.org.is_empty() && !st.project.is_empty() && !st.team.is_empty() { Some(team_sprints().want((st.org.clone(), st.project.clone(), st.team.clone()))) } else { None };
    let list = loaded.as_ref().and_then(|l| l.value.clone());
    let all = list.as_deref().map_or(&[][..], |l| l.as_slice());
    let mut options = vec![(String::new(), "This sprint".to_owned())];
    options.extend(all.iter().filter(|t| t.time_frame == "future").map(|t| (t.path.clone(), t.name.clone())));
    options.extend(all.iter().filter(|t| t.time_frame == "past").rev().map(|t| (t.path.clone(), format!("{} (past)", t.name))));
    options.push((NO_SPRINT.to_owned(), "No sprint".to_owned()));
    let saved = s.view.sprint.clone();
    let mut sprint = saved.clone();
    if !saved.is_empty() && !options.iter().any(|(v, _)| *v == saved) {
        if list.is_some() {
            sprint = String::new();
        } else {
            options.insert(1, (saved.clone(), saved.rsplit('\\').next().unwrap_or(&saved).to_owned()));
        }
    }
    SprintPick { sprint, options }
}

/// The items the list shows: the board's, or the picked sprint's.
fn list_items<'a>(s: &'a Sidebar, sprint: &str) -> Vec<&'a BoardItem> {
    if sprint.is_empty() { s.snapshot.iter().flat_map(|b| &b.items).collect() } else { s.outside.items.iter().collect() }
}

/// The people and types in the list, which the filters offer.
fn options(items: &[&BoardItem]) -> (Vec<String>, Vec<String>) {
    let mut people: Vec<String> = items.iter().filter_map(|i| i.assignee.clone()).filter(|a| !a.is_empty()).collect::<HashSet<_>>().into_iter().collect();
    let mut types: Vec<String> = items.iter().map(|i| i.kind.clone()).collect::<HashSet<_>>().into_iter().collect();
    people.sort();
    types.sort();
    (people, types)
}

/// The filters as they apply now. A saved person or type that's no longer on the board filters by Everyone or All
/// types, as the selects show; the saved view keeps it until you pick another.
fn filters(view: &View, people: &[String], types: &[String]) -> (String, String) {
    let who = if view.who.strip_prefix("p:").is_some_and(|p| !people.iter().any(|x| x == p)) { "all".to_owned() } else { view.who.clone() };
    let kind = if !view.kind.is_empty() && !types.contains(&view.kind) { String::new() } else { view.kind.clone() };
    (who, kind)
}

/// Whether an item passes the filters.
fn matches(i: &BoardItem, who: &str, kind: &str, q: &str, me_login: &str) -> bool {
    let person = who == "all"
        || (who == "mine" && !me_login.is_empty() && i.login.as_deref().is_some_and(|l| l.to_lowercase() == me_login))
        || (who == "none" && i.assignee.as_deref().is_none_or(str::is_empty))
        || who.strip_prefix("p:").is_some_and(|p| i.assignee.as_deref() == Some(p));
    person && (kind.is_empty() || i.kind == kind) && (q.is_empty() || i.id.to_string().contains(q) || i.title.to_lowercase().contains(q))
}

fn set(change: impl FnOnce(&mut View)) {
    with(|s| change(&mut s.view));
    save_view();
}

fn filter_bar(s: &Sidebar, pick: &SprintPick, people: &[String], types: &[String], who: &str, kind: &str) -> Node {
    let mut who_options = vec![("all".to_owned(), "Everyone".to_owned()), ("mine".to_owned(), "Mine".to_owned()), ("none".to_owned(), "Unassigned".to_owned())];
    who_options.extend(people.iter().map(|p| (format!("p:{p}"), p.clone())));
    let mut type_options = vec![(String::new(), "All types".to_owned())];
    type_options.extend(types.iter().map(|t| (t.clone(), t.clone())));
    gap(stack(), "s")
        .key("filters")
        .child(ui::search_field("Search id or title", &s.view.q, |q| set(|v| v.q = q.to_owned())))
        .child(
            row()
                .child(ui::select("Assigned to", &who_options, who, |who| set(|v| v.who = who.to_owned())))
                .child(ui::select("Type", &type_options, kind, |kind| set(|v| v.kind = kind.to_owned()))),
        )
        .child(ui::select("Sprint", &pick.options, &pick.sprint, |sprint| set(|v| v.sprint = sprint.to_owned())))
}

fn empty_title(title: &str) -> Node {
    Node::new("Empty").key("empty").child(Node::new("Slot").prop("name", "title").text(title))
}

/// Starts the search beyond the board as the list asks for it.
pub fn search_effects(s: &mut Sidebar) {
    let pick = sprints(s);
    let q = s.view.q.clone();
    search_outside(s, &q, &pick.sprint);
}

fn list(s: &Sidebar) -> Vec<Node> {
    let Some(snapshot) = &s.snapshot else { return vec![reading("Reading the sprint board…").key("loading")] };
    let pick = sprints(s);
    let sprint = pick.sprint.as_str();
    let items = list_items(s, sprint);
    let (people, types) = options(&items);
    let (who, kind) = filters(&s.view, &people, &types);
    // "Mine" is whoever `az` is signed in as; until it is known, or when it can't be, nobody is.
    let me_login = if who == "mine" { super::lists::me().want(()).value.map_or(String::new(), |me| me.to_lowercase()) } else { String::new() };
    let q = s.view.q.trim().to_lowercase();
    let filter_bar = || filter_bar(s, &pick, &people, &types, &who, &kind);
    let pass = |i: &BoardItem| matches(i, &who, &kind, &q, &me_login);
    let filtered = who != "all" || !kind.is_empty() || !q.is_empty();
    let outside = &s.outside;
    let ids: HashSet<u64> = items.iter().map(|i| i.id).collect();
    let mut kids: HashMap<u64, Vec<&BoardItem>> = HashMap::new();
    for i in &items {
        if let Some(parent) = i.parent.filter(|p| ids.contains(p)) {
            kids.entry(parent).or_default().push(i);
        }
    }
    // Filtering lists matching items on their own; otherwise children sit under their story, as on the backlog.
    let top: Vec<&BoardItem> = if filtered { items.iter().copied().filter(|i| pass(i)).collect() } else { items.iter().filter(|i| !i.parent.is_some_and(|p| ids.contains(&p))).copied().collect() };
    let groups = group_by_state(&top, snapshot);
    let others: Vec<&BoardItem> = outside.items.iter().filter(|i| pass(i)).collect();
    let outside_open = is_open(&s.view, "outside", true);
    let outside_section = (!q.is_empty() && sprint.is_empty()).then(|| {
        let head = ui::list_button(
            [
                text("Outside this sprint").prop("size", "small").prop("weight", "medium").prop("truncate", true),
                if outside.loading { spinner() } else { muted(others.len().to_string()).prop("size", "small") },
            ],
            || toggle("outside"),
        )
        .prop("aria-expanded", outside_open);
        gap(stack(), "none")
            .key("outside")
            .child(head)
            .maybe(outside.error.as_deref().map(|e| error_line(format!("Couldn't search the project: {e}"))))
            .maybe(outside_open.then(|| gap(stack(), "none").children(others.iter().map(|i| item_row(s, i, RowOptions { state: true, ..RowOptions::default() })))))
    });
    if !sprint.is_empty() && (outside.loading || outside.error.is_some()) {
        return vec![
            filter_bar(),
            match &outside.error {
                Some(error) => error_line(format!("Couldn't read the sprint: {error}")),
                None => reading("Reading the sprint…").key("loading"),
            },
        ];
    }
    if groups.is_empty() && (q.is_empty() || !sprint.is_empty()) {
        let title = if filtered {
            "Nothing matches."
        } else if sprint == NO_SPRINT {
            "Nothing is outside a sprint."
        } else {
            "The sprint has no items."
        };
        return vec![filter_bar(), empty_title(title)];
    }
    let mut out = vec![filter_bar()];
    if groups.is_empty() {
        out.push(muted_small("Nothing in this sprint matches.").key("none"));
    }
    for g in &groups {
        let key = format!("s:{}", g.state);
        let open = is_open(&s.view, &key, g.category != "Completed" && g.category != "Removed");
        let toggled = key.clone();
        let head = ui::list_button(
            [dot(&g.color), text(g.state.as_str()).prop("size", "small").prop("weight", "medium").prop("truncate", true), muted(g.items.len().to_string()).prop("size", "small")],
            move || toggle(&toggled),
        )
        .prop("aria-expanded", open);
        out.push(gap(stack(), "none").key(key).child(head).maybe(open.then(|| {
            gap(stack(), "none").children(g.items.iter().map(|i| item_row(s, i, RowOptions { kids: if filtered { Vec::new() } else { kids.get(&i.id).cloned().unwrap_or_default() }, ..RowOptions::default() })))
        })));
    }
    out.extend(outside_section);
    if outside.more {
        out.push(muted_small(format!("Showing the {} changed last. Search to narrow it down.", outside.items.len())).key("more"));
    }
    out
}

/// The board's main view: the sprint, Refresh and Settings, and the Board and Checks tabs.
pub fn main_view(s: &Sidebar) -> Vec<Node> {
    if let Some(id) = s.opened.last() {
        return detail_view::render(s, *id);
    }
    let main = s.main.as_ref();
    let report = main.and_then(|m| m.result.as_ref());
    let running = main.is_some_and(|m| m.running);
    let findings = report.map_or(0, |r| r.findings.len());
    let name = report.map(|r| r.sprint.name.clone()).or_else(|| s.snapshot.as_ref().map(|b| b.sprint.name.clone())).unwrap_or_else(|| "Sprint".to_owned());
    let when = report.map_or(String::new(), |r| format!("{} – {} · {}", time::day(r.sprint.start.as_deref()), time::day(r.sprint.finish.as_deref()), if running { "checking…".to_owned() } else { format!("checked {}", time::time(&r.checked_at)) }));
    let tab_items = vec![
        ("board".to_owned(), format!("Board{}", s.snapshot.as_ref().map_or(String::new(), |b| format!(" · {}", b.items.len())))),
        ("checks".to_owned(), format!("Checks · {findings}")),
    ];
    let panel = if s.view.tab == "checks" { checks_view::render(s) } else { list(s) };
    let mut out = vec![row()
        .key("head")
        .child(gap(stack(), "none").prop("grow", true).child(strong(name).prop("truncate", true)).child(muted_small(when).prop("truncate", true)))
        .child(ui::button(if running { "Checking…" } else { "Refresh" }, "ghost", running, || messages::tell(state::REFRESH, &Value::Null)))
        .child(ui::button("Settings", "ghost", false, setup::open_settings))];
    out.extend(main.and_then(|m| m.error.as_deref()).map(|e| error_line(format!("Last refresh failed: {e}")).key("refresh-failed")));
    out.push(tabs("Sprint board", &tab_items, &s.view.tab, |tab| set(|v| v.tab = tab.to_owned()), stack().children(panel)).key("tabs"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::az::{StateInfo, TypeInfo};

    fn item(id: u64, kind: &str, state: &str, category: &str, parent: Option<u64>, who: Option<&str>) -> BoardItem {
        BoardItem {
            id,
            rev: 1,
            title: format!("Item {id}"),
            kind: kind.into(),
            state: state.into(),
            category: category.into(),
            assignee: who.map(str::to_owned),
            login: who.map(|w| format!("{w}@x")),
            parent,
            tags: vec![],
            blocked: false,
            blocked_by: None,
            comments: 0,
            prs: None,
            checks: vec![],
            iteration: None,
        }
    }

    fn snapshot() -> Snapshot {
        let state = |name: &str, category: &str| StateInfo { name: name.into(), category: category.into(), color: "#112233".into() };
        let workflow = TypeInfo { color: "#009ccc".into(), states: vec![state("New", "Proposed"), state("Active", "InProgress"), state("Closed", "Completed")] };
        Snapshot { checked_at: String::new(), sprint: crate::check::Sprint { name: "S".into(), path: String::new(), start: None, finish: None }, items: vec![], types: [("Task".to_owned(), workflow)].into() }
    }

    #[test]
    fn states_come_in_workflow_order_by_category_then_their_place_in_the_type() {
        let items = [item(1, "Task", "Closed", "Completed", None, None), item(2, "Task", "New", "Proposed", None, None), item(3, "Task", "Active", "InProgress", None, None), item(4, "Task", "Active", "InProgress", None, None)];
        let refs: Vec<&BoardItem> = items.iter().collect();
        let groups = group_by_state(&refs, &snapshot());
        assert_eq!(groups.iter().map(|g| (g.state.as_str(), g.items.len(), g.color.as_str())).collect::<Vec<_>>(), [("New", 1, "#112233"), ("Active", 2, "#112233"), ("Closed", 1, "#112233")]);
    }

    #[test]
    fn the_filters_pick_a_person_a_type_and_a_search_and_mine_is_whoever_az_is_signed_in_as() {
        let (a, b) = (item(10, "Task", "New", "Proposed", None, Some("Ada")), item(11, "Bug", "New", "Proposed", None, None));
        assert!(matches(&a, "all", "", "", "") && matches(&b, "all", "", "", ""));
        assert!(matches(&a, "p:Ada", "", "", "") && !matches(&b, "p:Ada", "", "", ""));
        assert!(matches(&b, "none", "", "", "") && !matches(&a, "none", "", "", ""));
        assert!(matches(&a, "mine", "", "", "ada@x") && !matches(&a, "mine", "", "", "") && !matches(&a, "mine", "", "", "bob@x"));
        assert!(matches(&b, "all", "Bug", "", "") && !matches(&a, "all", "Bug", "", ""));
        assert!(matches(&a, "all", "", "10", "") && matches(&a, "all", "", "item 1", "") && !matches(&a, "all", "", "zzz", ""));
    }

    #[test]
    fn a_saved_person_or_type_the_board_no_longer_has_filters_by_everyone_and_all_types() {
        let view = View { who: "p:Gone".into(), kind: "Epic".into(), ..View::default() };
        assert_eq!(filters(&view, &["Ada".into()], &["Task".into()]), ("all".to_owned(), String::new()));
        let kept = View { who: "mine".into(), kind: "Task".into(), ..View::default() };
        assert_eq!(filters(&kept, &[], &["Task".into()]), ("mine".to_owned(), "Task".to_owned()));
    }

    #[test]
    fn groups_and_parents_start_open_or_closed_and_a_toggle_flips_them() {
        let mut view = View::default();
        assert!(is_open(&view, "s:Active", true) && !is_open(&view, "p:1", false));
        view.toggled = vec!["s:Active".into(), "p:1".into()];
        assert!(!is_open(&view, "s:Active", true) && is_open(&view, "p:1", false));
    }

    #[test]
    fn the_most_telling_pull_request_is_the_open_one_then_the_completed_one() {
        assert_eq!((pr_tone("active"), pr_tone("completed"), pr_tone("abandoned")), (Some("info"), Some("success"), None));
    }
}
