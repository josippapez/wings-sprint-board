//! The board check: reads a team's current sprint with `az` and checks the board's hygiene for the team's own scope.
//! Read-only: it never changes a work item. Each finding carries a proposed fix for a person to apply.

use crate::{
    az::{self, Failure, Item, PREDECESSOR, PullRequestRef, RELATED, Relation, StateInfo, TypeInfo, az as az_call, linked, pull_request_ids, pull_request_refs, query, text},
    settings::{Settings, has_ci, item_url, list, quote, validate},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    pin::Pin,
};
use wings_plugin::{
    format::{iso_of, parse_time},
    host,
    task::{join, join_all},
};

const NOT_COVERED: &str = "Blocked but not marked: it needs comments read and judged, so it's left to you.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    pub id: u64,
    pub title: String,
    pub url: String,
    pub check: String,
    pub problem: String,
    pub fix: String,
    pub dependency: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sprint {
    pub name: String,
    #[serde(default)]
    pub path: String,
    pub start: Option<String>,
    pub finish: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonItem {
    pub id: u64,
    pub title: String,
    pub url: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub state: String,
    pub goal: bool,
    pub blocked: bool,
    pub blocked_by: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LowPriority {
    pub meets: bool,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub items: Vec<PersonItem>,
    pub low_priority: Option<LowPriority>,
}

/// The check without its board, which the sidebar has as a query of its own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub sprint: Sprint,
    pub checked_at: String,
    pub findings: Vec<Finding>,
    pub people: Vec<Person>,
    pub goal_tag: Option<String>,
    pub not_covered: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PrStatus {
    pub id: u64,
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardItem {
    pub id: u64,
    pub rev: u64,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub state: String,
    pub category: String,
    pub assignee: Option<String>,
    pub login: Option<String>,
    pub parent: Option<u64>,
    pub tags: Vec<String>,
    pub blocked: bool,
    pub blocked_by: Option<String>,
    pub comments: u64,
    pub prs: Option<Vec<PrStatus>>,
    pub checks: Vec<String>,
    /// The sprint path, set only on items found outside the sprint.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub iteration: Option<String>,
}

/// The board as the last check read it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub checked_at: String,
    pub sprint: Sprint,
    pub items: Vec<BoardItem>,
    pub types: BTreeMap<String, TypeInfo>,
}

#[derive(Clone, Debug)]
pub struct Checked {
    pub report: Report,
    pub snapshot: Snapshot,
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Weekdays after `iso`'s day up to and including today, in UTC.
pub fn working_days_since(iso: &str, now_ms: f64) -> u32 {
    let Some(start) = parse_time(iso) else { return 0 };
    let (first, today) = ((start / 86_400_000.0).floor() as i64, (now_ms / 86_400_000.0).floor() as i64);
    // Day 0 is a Thursday.
    (first + 1..=today).filter(|day| !matches!((day + 4).rem_euclid(7), 0 | 6)).count() as u32
}

/// Ticket numbers at the start of a Blocked By value, like "123, 456, no ticket: x", and the note after them.
pub fn blocked_by_parts(text: &str) -> (Vec<u64>, String) {
    let chars: Vec<char> = text.chars().collect();
    let skip = |mut at: usize| {
        while chars.get(at).is_some_and(|c| c.is_whitespace()) {
            at += 1;
        }
        at
    };
    // `#?\d+` from `at`: where the digits end.
    let number = |at: usize| {
        let at = if chars.get(at) == Some(&'#') { at + 1 } else { at };
        let end = (at..chars.len()).find(|i| !chars[*i].is_ascii_digit()).unwrap_or(chars.len());
        (end > at).then_some(end)
    };
    let mut end = 0;
    if let Some(first) = number(skip(0)) {
        end = first;
        loop {
            let mut at = skip(end);
            if matches!(chars.get(at), Some(',' | ';')) {
                at += 1;
            }
            match number(skip(at)) {
                Some(next) => end = next,
                None => break,
            }
        }
    }
    let lead: String = chars[..end].iter().collect();
    let mut ids = Vec::new();
    let mut digits = String::new();
    for c in lead.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_digit() {
            digits.push(c);
        } else if !digits.is_empty() {
            ids.push(digits.parse().unwrap_or(u64::MAX));
            digits.clear();
        }
    }
    let rest = chars[end..].iter().collect::<String>().trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ';').to_owned();
    (ids, rest)
}

/// `/^no\b.*\bticket\b/i`: a short note that what's missing has no ticket yet.
fn no_ticket_note(rest: &str) -> bool {
    let chars: Vec<char> = rest.to_lowercase().chars().collect();
    if chars.len() < 2 || chars[0] != 'n' || chars[1] != 'o' || chars.get(2).is_some_and(|c| is_word(*c)) {
        return false;
    }
    (2..chars.len().saturating_sub(5)).any(|at| {
        chars[at..at + 6].iter().collect::<String>() == "ticket"
            && !is_word(chars[at - 1])
            && !chars.get(at + 6).is_some_and(|c| is_word(*c))
            && !chars[2..at].iter().any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
    })
}

/// `/\bspike\b/i`.
fn has_spike(title: &str) -> bool {
    let chars: Vec<char> = title.to_lowercase().chars().collect();
    (0..chars.len().saturating_sub(4)).any(|at| {
        chars[at..at + 5].iter().collect::<String>() == "spike" && (at == 0 || !is_word(chars[at - 1])) && !chars.get(at + 5).is_some_and(|c| is_word(*c))
    })
}

/// Items by id, in the order they came.
struct Ordered<V> {
    order: Vec<u64>,
    map: HashMap<u64, V>,
}

impl<V> Ordered<V> {
    fn new() -> Self {
        Self { order: Vec::new(), map: HashMap::new() }
    }

    fn insert(&mut self, id: u64, value: V) {
        if self.map.insert(id, value).is_none() {
            self.order.push(id);
        }
    }

    fn get(&self, id: u64) -> Option<&V> {
        self.map.get(&id)
    }

    fn has(&self, id: u64) -> bool {
        self.map.contains_key(&id)
    }

    fn values(&self) -> impl Iterator<Item = &V> {
        self.order.iter().map(|id| &self.map[id])
    }

    fn ids(&self) -> impl Iterator<Item = u64> + '_ {
        self.order.iter().copied()
    }
}

fn ids_text(ids: &[u64]) -> String {
    ids.iter().map(|x| format!("#{x}")).collect::<Vec<_>>().join(", ")
}

fn prs_text(ids: &[u64]) -> String {
    ids.iter().map(|x| format!("!{x}")).collect::<Vec<_>>().join(", ")
}

type Links = Pin<Box<dyn Future<Output = Result<(u64, Vec<Relation>), Failure>>>>;

/// The links of `ids`, asked together so they go out as one call.
async fn links_of(ids: Vec<u64>, s: &Settings) -> Result<Vec<(u64, Vec<Relation>)>, Failure> {
    let asked: Vec<Links> = ids
        .into_iter()
        .map(|id| {
            let relations = az::relations(id, s);
            Box::pin(async move { Ok((id, relations.await?)) }) as Links
        })
        .collect();
    join_all(asked).await.into_iter().collect()
}

/// A team's iteration, as `az boards iteration team list` has it.
fn sprint_of(iteration: &Value) -> Sprint {
    Sprint {
        name: text(&iteration["name"]),
        path: text(&iteration["path"]),
        start: iteration["attributes"]["startDate"].as_str().map(str::to_owned),
        finish: iteration["attributes"]["finishDate"].as_str().map(str::to_owned),
    }
}

/// Runs the whole board check.
pub async fn board_check(s: &Settings) -> Result<Checked, Failure> {
    validate(s)?;
    let now_ms = host::now();
    let now = iso_of(now_ms);

    // 1. The current sprint, and every item in it and the team's area.
    let area_path = s.area_path.trim();
    let (iterations, area) = join(
        az_call(&["boards", "iteration", "team", "list", "--team", &s.team, "--timeframe", "current", "--project", &s.project], s),
        async { if area_path.is_empty() { az_call(&["boards", "area", "team", "list", "--team", &s.team, "--project", &s.project], s).await } else { Ok(Value::Null) } },
    )
    .await;
    let (iterations, area) = (iterations?, area?);
    let Some(iteration) = iterations.as_array().and_then(|list| list.first()) else {
        return Err(format!("{} has no current sprint.", s.team).into());
    };
    let sprint = sprint_of(iteration);
    // A team's area is a set of paths, each with or without its children, like the team's own board.
    let areas: Vec<String> = if area_path.is_empty() {
        area["values"].as_array().into_iter().flatten().map(|v| format!("[System.AreaPath] {} {}", if v["includeChildren"] == true { "UNDER" } else { "=" }, quote(&text(&v["value"])))).collect()
    } else {
        vec![format!("[System.AreaPath] = {}", quote(area_path))]
    };
    if areas.is_empty() {
        return Err(format!("{} has no areas. Set the area path in Settings.", s.team).into());
    }
    let board = query(
        &format!("[System.TeamProject] = {} AND [System.IterationPath] = {} AND ({}) AND [System.State] <> 'Removed'", quote(&s.project), quote(&sprint.path), areas.join(" OR ")),
        s,
    )
    .await?;
    // Every item read, by id.
    let mut items: Ordered<Item> = Ordered::new();
    for i in &board {
        items.insert(i.id, i.clone());
    }
    let on_board = |id: u64| board.iter().any(|i| i.id == id);

    // 2. The team's scope. az boards query runs only flat queries, so instead of a WorkItemLinks query the
    // stories' children are read by their Parent field.
    let stories: Vec<&Item> = board.iter().filter(|i| has_ci(&s.story_types, &i.kind)).collect();
    let mut child_types = s.scope_child_types.clone();
    for t in &s.child_types {
        if !child_types.contains(t) {
            child_types.push(t.clone());
        }
    }
    let children = if !stories.is_empty() && !child_types.is_empty() {
        query(&format!("[System.WorkItemType] IN ({}) AND [System.Parent] IN ({})", list(&child_types), stories.iter().map(|i| i.id.to_string()).collect::<Vec<_>>().join(", ")), s).await?
    } else {
        Vec::new()
    };
    for c in &children {
        if !items.has(c.id) {
            items.insert(c.id, c.clone());
        }
    }
    let scope_story_ids: Vec<u64> = if s.scope_child_types.is_empty() {
        stories.iter().map(|i| i.id).collect()
    } else {
        children.iter().filter(|c| has_ci(&s.scope_child_types, &c.kind)).filter_map(|c| c.parent).collect()
    };
    let in_scope_story = |id: u64| scope_story_ids.contains(&id);
    let scope_stories: Vec<&Item> = stories.iter().copied().filter(|i| in_scope_story(i.id)).collect();
    let story_children: Vec<&Item> = children.iter().filter(|c| c.state != "Removed" && has_ci(&s.child_types, &c.kind) && c.parent.is_some_and(in_scope_story)).collect();
    let is_member = |name: &Option<String>| name.as_deref().is_some_and(|n| !n.is_empty() && has_ci(&s.members, n));
    let prefixed = |title: &str| s.title_prefixes.iter().any(|p| !p.is_empty() && title.trim_start().to_lowercase().starts_with(&p.to_lowercase()));
    let other_items: Vec<&Item> = board.iter().filter(|i| has_ci(&s.item_types, &i.kind) && !in_scope_story(i.id) && (is_member(&i.assignee) || prefixed(&i.title))).collect();
    let mut scoped: Ordered<&Item> = Ordered::new();
    for i in scope_stories.iter().chain(&story_children).chain(&other_items) {
        scoped.insert(i.id, i);
    }

    // What the scope depends on: Blocked By tickets now; Predecessor and Related links once links are read.
    let mut dep_ids: Vec<u64> = Vec::new();
    let add_dep = |dep_ids: &mut Vec<u64>, id: u64| {
        if !dep_ids.contains(&id) {
            dep_ids.push(id);
        }
    };
    for i in scoped.values() {
        for id in blocked_by_parts(&i.blocked_by).0 {
            add_dep(&mut dep_ids, id);
        }
    }

    let states = az::load_states(s).await?;
    let category = |i: &Item| states.category(&i.kind, &i.state).to_owned();
    let is_review = |i: &Item| has_ci(&s.code_review_states, &i.state);
    let is_done = |i: &Item| category(i) == "Completed";
    let is_closed = |i: &Item| matches!(category(i).as_str(), "Completed" | "Removed") || i.state == "Removed";
    let is_active = |i: &Item| matches!(category(i).as_str(), "InProgress" | "Resolved");
    let pr_decides = |i: &Item| is_review(i) || is_done(i);

    // Links: in-scope stories and other items always; children only when a PR decides their check.
    let needs_links: Vec<u64> = scope_stories.iter().chain(&other_items).copied().chain(story_children.iter().copied().filter(|i| pr_decides(i))).map(|i| i.id).collect();
    let mut rels: Ordered<Vec<Relation>> = Ordered::new();
    for (id, r) in links_of(needs_links, s).await? {
        rels.insert(id, r);
    }
    for story in &scope_stories {
        let r = rels.get(story.id).cloned().unwrap_or_default();
        for id in linked(&r, PREDECESSOR).into_iter().chain(linked(&r, RELATED)) {
            add_dep(&mut dep_ids, id);
        }
    }
    dep_ids.retain(|id| !scoped.has(*id));
    // Blockers of every board item are read too, so the board can show what's blocked. Only the scope's are checked.
    let mut unread: Vec<u64> = Vec::new();
    for id in dep_ids.iter().copied().chain(board.iter().flat_map(|i| blocked_by_parts(&i.blocked_by).0)) {
        if !items.has(id) && !unread.contains(&id) {
            unread.push(id);
        }
    }
    for chunk in unread.chunks(200) {
        for d in query(&format!("[System.Id] IN ({})", chunk.iter().map(u64::to_string).collect::<Vec<_>>().join(", ")), s).await? {
            items.insert(d.id, d);
        }
    }
    let deps: Vec<&Item> = dep_ids.iter().filter_map(|id| items.get(*id)).filter(|d| d.state != "Removed").collect();
    let dep_links: Vec<u64> = deps.iter().filter(|d| pr_decides(d) && !rels.has(d.id)).map(|d| d.id).collect();
    for (id, r) in links_of(dep_links, s).await? {
        rels.insert(id, r);
    }

    // Pull requests of everything whose state a PR decides.
    let mut pr_refs: Vec<PullRequestRef> = Vec::new();
    for id in rels.ids() {
        if items.get(id).is_some_and(pr_decides) {
            for pr in pull_request_refs(rels.get(id).map_or(&[][..], Vec::as_slice)) {
                match pr_refs.iter_mut().find(|p| p.id == pr.id) {
                    Some(known) => *known = pr,
                    None => pr_refs.push(pr),
                }
            }
        }
    }
    let prs = az::pull_requests(&pr_refs, s).await?;

    // 3. Checks.
    let mut findings: Vec<Finding> = Vec::new();
    let mut add = |item: &Item, check: &str, problem: String, fix: String, dependency: bool| {
        let fix = if dependency {
            let mut chars = fix.chars();
            let first: String = chars.next().into_iter().flat_map(char::to_lowercase).collect();
            format!("Ask {}: {first}{}", item.assignee.as_deref().filter(|a| !a.is_empty()).unwrap_or("the owner"), chars.as_str())
        } else {
            fix
        };
        findings.push(Finding { id: item.id, title: item.title.clone(), url: item_url(&s.org, &s.project, item.id), check: check.to_owned(), problem, fix, dependency });
    };
    let resolved = |id: u64| items.get(id).is_some_and(is_closed);
    let sprint_start = sprint.start.as_deref().and_then(parse_time);
    let after_start = |created: &str| sprint_start.is_some_and(|start| parse_time(created).is_some_and(|c| c > start));

    // Blocked By and PR checks, which dependencies get too.
    let shared_checks = |item: &Item, dependency: bool, add: &mut dyn FnMut(&Item, &str, String, String, bool)| {
        if !item.blocked_by.is_empty() {
            let (blockers, rest) = blocked_by_parts(&item.blocked_by);
            // A short "no ... ticket" note is fine on its own: it says what's missing has no ticket yet.
            if blockers.is_empty() && !no_ticket_note(&rest) {
                let preds = linked(rels.get(item.id).map_or(&[][..], Vec::as_slice), PREDECESSOR);
                add(
                    item,
                    "Blocked By not a ticket",
                    format!("Blocked By is \"{}\", not a ticket number.", item.blocked_by),
                    format!(
                        "Put the blocking ticket number first, or a short \"no ticket: <what is missing>\" note.{} If no single ticket matches, ask the owner.",
                        if preds.is_empty() { String::new() } else { format!(" Its Predecessor links: {}.", ids_text(&preds)) }
                    ),
                    dependency,
                );
            } else if !blockers.is_empty() {
                let closed: Vec<u64> = blockers.iter().copied().filter(|id| resolved(*id)).collect();
                if closed.len() == blockers.len() && rest.is_empty() {
                    let named = blockers.iter().map(|id| format!("#{id} ({})", items.get(*id).map_or("undefined", |i| i.state.as_str()))).collect::<Vec<_>>().join(", ");
                    add(item, "Blocked By resolved", format!("Blocked By names {named}, all closed."), "Clear Blocked By.".into(), dependency);
                } else if !closed.is_empty() {
                    add(
                        item,
                        "Blocked By resolved",
                        format!("{} in Blocked By {} closed.", ids_text(&closed), if closed.len() > 1 { "are" } else { "is" }),
                        format!("Remove {} from Blocked By.", ids_text(&closed)),
                        dependency,
                    );
                }
            }
        }
        struct Linked {
            id: u64,
            status: String,
            title: String,
        }
        let linked_prs: Vec<Linked> = pull_request_ids(rels.get(item.id).map_or(&[][..], Vec::as_slice))
            .into_iter()
            .map(|id| {
                let (status, title) = prs.get(&id).cloned().unwrap_or_default();
                Linked { id, status, title }
            })
            .collect();
        // A PR parked on purpose takes the item out of this check.
        if !s.parked_pr_prefix.is_empty() && linked_prs.iter().any(|p| p.title.to_lowercase().starts_with(&s.parked_pr_prefix.to_lowercase())) {
            return;
        }
        let ahead = "Status ahead of the PR";
        if is_review(item) {
            if linked_prs.is_empty() {
                add(item, ahead, format!("{} with no linked pull request.", item.state), "Link the PR, or move it back to the working state.".into(), dependency);
            } else if !linked_prs.iter().any(|p| p.status == "active") {
                let merged: Vec<u64> = linked_prs.iter().filter(|p| p.status == "completed").map(|p| p.id).collect();
                let all: Vec<u64> = linked_prs.iter().map(|p| p.id).collect();
                add(
                    item,
                    ahead,
                    if merged.is_empty() { format!("{}, but PR {} is abandoned.", item.state, prs_text(&all)) } else { format!("{}, but PR {} is completed.", item.state, prs_text(&merged)) },
                    if merged.is_empty() { "Link the new PR, or move it back to the working state.".into() } else { "Move it on to the state after review.".into() },
                    dependency,
                );
            }
        } else if is_done(item) {
            let open: Vec<u64> = linked_prs.iter().filter(|p| p.status == "active").map(|p| p.id).collect();
            if !open.is_empty() {
                add(item, ahead, format!("{}, but PR {} is still active.", item.state, prs_text(&open)), "Complete or abandon the PR, or move the item back to review.".into(), dependency);
            }
        }
    };

    for item in scoped.values().copied() {
        shared_checks(item, false, &mut add);
        if in_scope_story(item.id) {
            let kids: Vec<&Item> = story_children.iter().copied().filter(|c| c.parent == Some(item.id)).collect();
            let started: Vec<&Item> = kids.iter().copied().filter(|c| is_active(c) || is_done(c)).collect();
            if category(item) == "Proposed" && !started.is_empty() {
                add(
                    item,
                    "Status behind the work",
                    format!("{}, but {}.", item.state, started.iter().map(|c| format!("#{} is {}", c.id, c.state)).collect::<Vec<_>>().join(", ")),
                    format!("Move the story to {}.", states.first_of(&item.kind, "InProgress").unwrap_or("in progress")),
                    false,
                );
            } else if states.first_of(&item.kind, "InProgress") == Some(item.state.as_str()) && !kids.is_empty() && kids.iter().all(|c| is_done(c)) {
                add(item, "Status behind the work", format!("{}, but all {} of its tasks are done.", item.state, kids.len()), "Move the story on, or add the task that's still open.".into(), false);
            }
        }
        if is_active(item) && item.assignee.as_deref().is_none_or(str::is_empty) {
            add(item, "In progress, nobody on it", format!("{} with nobody assigned.", item.state), "Assign whoever is working on it, or move it back.".into(), false);
        }
        let idle = working_days_since(&item.changed, now_ms);
        if is_active(item) && idle >= s.stale_days {
            add(item, "Stale", format!("{}, no change in {idle} working days.", item.state), "Report only.".into(), false);
        }
        let top_level = !item.parent.is_some_and(on_board);
        if top_level && after_start(&item.created) {
            let missing: Vec<&String> = s.added_tags.iter().filter(|t| !t.is_empty() && !has_ci(&item.tags, t)).collect();
            if !missing.is_empty() {
                add(
                    item,
                    "Added without tags",
                    format!("Created after the sprint started, without {}.", missing.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(" or ")),
                    format!("Add {}.", missing.iter().map(|t| t.as_str()).collect::<Vec<_>>().join("; ")),
                    false,
                );
            }
            // Spikes are sized by time, not points.
            if has_ci(&s.point_types, &item.kind) && !s.point_fields.is_empty() && !has_spike(&item.title) {
                let values = &item.points;
                let distinct: HashSet<Option<u64>> = values.iter().map(|v| v.map(f64::to_bits)).collect();
                if values.iter().any(|v| v.is_none_or(|v| v == 0.0)) || distinct.len() > 1 {
                    let shown = s
                        .point_fields
                        .iter()
                        .enumerate()
                        .map(|(i, f)| format!("{} {}", f.rsplit('.').next().unwrap_or(f), values.get(i).copied().flatten().map_or("empty".to_owned(), |v| v.to_string())))
                        .collect::<Vec<_>>()
                        .join(", ");
                    add(item, "Missing points", format!("{shown}."), if s.point_fields.len() > 1 { "Set them to the same number." } else { "Set the points." }.into(), false);
                }
            }
        }
    }
    for d in &deps {
        shared_checks(d, true, &mut add);
    }

    // 4 and 5. Who is working on what, and who is blocked with only lower-priority work.
    let goal = s.goal_tag.trim();
    let is_goal = |i: &Item| !goal.is_empty() && [Some(i), i.parent.and_then(|p| items.get(p))].into_iter().flatten().any(|x| has_ci(&x.tags, goal));
    let is_blocked = |i: &Item| {
        if i.blocked_by.is_empty() {
            return false;
        }
        let (blockers, rest) = blocked_by_parts(&i.blocked_by);
        !rest.is_empty() || blockers.iter().any(|id| !resolved(*id))
    };
    let pickable: Vec<u64> = scoped
        .values()
        .copied()
        .filter(|i| !has_ci(&s.story_types, &i.kind) && i.assignee.as_deref().is_none_or(str::is_empty) && !is_closed(i) && is_goal(i) && !is_blocked(i))
        .map(|i| i.id)
        .collect();
    let people: Vec<Person> = s
        .members
        .iter()
        .map(|name| {
            let open: Vec<PersonItem> = items
                .values()
                .filter(|i| i.iteration == sprint.path && i.assignee.as_deref().is_some_and(|a| a.to_lowercase() == name.to_lowercase()) && !is_closed(i))
                .map(|i| PersonItem {
                    id: i.id,
                    title: i.title.clone(),
                    url: item_url(&s.org, &s.project, i.id),
                    kind: i.kind.clone(),
                    state: i.state.clone(),
                    goal: is_goal(i),
                    blocked: is_blocked(i),
                    blocked_by: Some(i.blocked_by.clone()).filter(|b| !b.is_empty()),
                })
                .collect();
            if goal.is_empty() {
                return Person { name: name.clone(), items: open, low_priority: None };
            }
            let low_only = open.iter().all(|i| i.blocked || !i.goal);
            let reason = if !low_only {
                format!("Has unblocked goal work: {}.", ids_text(&open.iter().filter(|i| !i.blocked && i.goal).map(|i| i.id).collect::<Vec<_>>()))
            } else if !pickable.is_empty() {
                format!("Only blocked or non-goal work, but unassigned goal work is free to pick up: {}.", ids_text(&pickable))
            } else {
                format!("{}, and no unassigned goal work is left. Worth escalating.", if open.is_empty() { "No open items" } else { "Every open item is blocked or not goal work" })
            };
            Person { name: name.clone(), items: open, low_priority: Some(LowPriority { meets: low_only && pickable.is_empty(), reason }) }
        })
        .collect();

    // The board as the sidebar lists it: every sprint item in the team's areas, with what the check learned.
    let mut flagged: HashMap<u64, Vec<String>> = HashMap::new();
    for f in &findings {
        flagged.entry(f.id).or_default().push(f.check.clone());
    }
    let board_items: Vec<BoardItem> = board
        .iter()
        .map(|i| BoardItem {
            id: i.id,
            rev: i.rev,
            title: i.title.chars().take(300).collect(),
            kind: i.kind.clone(),
            state: i.state.clone(),
            category: category(i),
            assignee: i.assignee.clone(),
            login: i.login.clone(),
            parent: i.parent.filter(|p| on_board(*p)),
            tags: i.tags.clone(),
            blocked: is_blocked(i),
            blocked_by: Some(i.blocked_by.clone()).filter(|b| !b.is_empty()),
            comments: i.comments,
            prs: rels.has(i.id).then(|| pull_request_ids(rels.get(i.id).map_or(&[][..], Vec::as_slice)).into_iter().map(|id| PrStatus { id, status: prs.get(&id).map_or(String::new(), |p| p.0.clone()) }).collect()),
            checks: flagged.get(&i.id).cloned().unwrap_or_default(),
            iteration: None,
        })
        .collect();
    let mut shown_types = BTreeMap::new();
    for i in &board {
        shown_types.entry(i.kind.clone()).or_insert_with(|| states.types.get(&i.kind).cloned().unwrap_or(TypeInfo { color: "#888888".into(), states: Vec::<StateInfo>::new() }));
    }
    let snapshot = Snapshot { checked_at: now.clone(), sprint: sprint.clone(), items: board_items, types: shown_types };
    let mut not_covered = vec![NOT_COVERED.to_owned()];
    if goal.is_empty() {
        not_covered.push("Blocked with only lower-priority work: set a goal tag to run it.".into());
    }
    let report = Report { sprint, checked_at: now, findings, people, goal_tag: Some(goal.to_owned()).filter(|g| !g.is_empty()), not_covered };
    Ok(Checked { report, snapshot })
}

/// The check as plain text, for Claude.
pub fn as_text(r: &Report) -> String {
    let day = |iso: &Option<String>| iso.as_deref().map_or("?".to_owned(), |i| i.chars().take(10).collect());
    let mut lines = vec![format!("Sprint {} ({} to {}), checked {}. Read-only: nothing was changed, the fixes are proposals.", r.sprint.name, day(&r.sprint.start), day(&r.sprint.finish), r.checked_at), String::new()];
    if r.findings.is_empty() {
        lines.push("Board is clean.".into());
    } else {
        lines.push(format!("Findings ({}):", r.findings.len()));
        for f in &r.findings {
            lines.push(format!("- #{} {}{} [{}] {} Proposed fix: {} {}", f.id, f.title, if f.dependency { " (dependency)" } else { "" }, f.check, f.problem, f.fix, f.url));
        }
    }
    lines.extend([String::new(), "Who is working on what:".into()]);
    for p in &r.people {
        let items: Vec<String> = p
            .items
            .iter()
            .map(|i| format!("#{} {} ({}{}{})", i.id, i.title, i.state, if i.goal { ", goal" } else { "" }, if i.blocked { format!(", blocked: {}", i.blocked_by.as_deref().unwrap_or("")) } else { String::new() }))
            .collect();
        lines.push(format!("- {}: {}", p.name, if items.is_empty() { "no open items".to_owned() } else { items.join("; ") }));
    }
    if r.goal_tag.is_some() {
        lines.extend([String::new(), "Blocked with only lower-priority work:".into()]);
        for p in &r.people {
            lines.push(format!("- {}: {}. {}", p.name, if p.low_priority.as_ref().is_some_and(|l| l.meets) { "yes" } else { "no" }, p.low_priority.as_ref().map_or("", |l| l.reason.as_str())));
        }
    }
    lines.extend([String::new(), format!("Not covered: {}", r.not_covered.join(" "))]);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::testing::{answering, settings};
    use wings_plugin::task::block_on;

    fn run(s: Settings) -> Result<Checked, Failure> {
        block_on(async move { board_check(&s).await })
    }

    #[test]
    fn blocked_by_is_ticket_numbers_then_a_note() {
        assert_eq!(blocked_by_parts("123, 456, no ticket: x"), (vec![123, 456], "no ticket: x".to_owned()));
        assert_eq!(blocked_by_parts(" #12 ; #13"), (vec![12, 13], String::new()));
        assert_eq!(blocked_by_parts("12 abc"), (vec![12], "abc".to_owned()));
        assert_eq!(blocked_by_parts("waiting on 5"), (vec![], "waiting on 5".to_owned()));
        assert_eq!(blocked_by_parts(""), (vec![], String::new()));
    }

    #[test]
    fn a_short_no_ticket_note_is_fine_and_other_text_is_not() {
        assert!(no_ticket_note("no ticket yet"));
        assert!(no_ticket_note("No design ticket: asked"));
        assert!(!no_ticket_note("not a ticket"));
        assert!(!no_ticket_note("no tickets"));
        assert!(!no_ticket_note("no\nticket"));
        assert!(has_spike("Spike: auth") && has_spike("do a SPIKE") && !has_spike("spikes"));
    }

    #[test]
    fn working_days_skip_weekends_and_count_up_to_today() {
        // 2026-11-12 is a Thursday; 2026-11-13 a Friday.
        let friday = parse_time("2026-11-13T12:00:00Z").unwrap();
        assert_eq!(working_days_since("2026-11-12T08:00:00.000Z", friday), 1);
        assert_eq!(working_days_since("2026-11-06T23:00:00Z", friday), 5);
        assert_eq!(working_days_since("2026-11-13T01:00:00Z", friday), 0);
        assert_eq!(working_days_since("not a date", friday), 0);
        let monday = parse_time("2026-11-16T12:00:00Z").unwrap();
        assert_eq!(working_days_since("2026-11-13T12:00:00Z", monday), 1);
    }

    #[test]
    fn the_check_finds_what_the_board_gets_wrong_and_proposes_each_fix() {
        answering();
        let checked = run(settings()).unwrap();
        let found: Vec<(u64, &str)> = checked.report.findings.iter().map(|f| (f.id, f.check.as_str())).collect();
        assert_eq!(
            found,
            [(1, "Status ahead of the PR"), (1, "Stale"), (3, "Blocked By resolved"), (3, "Stale"), (4, "Status ahead of the PR"), (4, "Stale"), (2, "In progress, nobody on it"), (2, "Stale")],
        );
        let by = |id: u64, check: &str| checked.report.findings.iter().find(|f| f.id == id && f.check == check).unwrap().clone();
        assert_eq!(by(1, "Status ahead of the PR").problem, "Code Review with no linked pull request.");
        assert_eq!(by(2, "Stale").problem, "Active, no change in 9 working days.");
        assert_eq!(by(3, "Blocked By resolved").problem, "Blocked By names #9 (Closed), all closed.");
        assert_eq!(by(3, "Blocked By resolved").fix, "Clear Blocked By.");
        assert_eq!(by(4, "Status ahead of the PR").problem, "Code Review, but PR !77 is completed.");
        assert_eq!(by(4, "Status ahead of the PR").url, "https://dev.azure.com/acme/Web/_workitems/edit/4");
    }

    #[test]
    fn the_board_keeps_each_items_checks_pull_requests_and_the_types_it_shows() {
        answering();
        let snapshot = run(settings()).unwrap().snapshot;
        let item = |id: u64| snapshot.items.iter().find(|i| i.id == id).unwrap();
        assert_eq!(snapshot.items.iter().map(|i| i.id).collect::<Vec<_>>(), [1, 3, 4]);
        assert_eq!((item(4).category.as_str(), item(4).prs.clone(), item(4).checks.clone()), ("InProgress", Some(vec![PrStatus { id: 77, status: "completed".into() }]), vec!["Status ahead of the PR".to_owned(), "Stale".to_owned()]));
        assert_eq!((item(3).blocked, item(3).blocked_by.as_deref()), (false, Some("#9")));
        assert_eq!((item(1).prs.clone(), snapshot.types.keys().cloned().collect::<Vec<_>>()), (Some(vec![]), vec!["User Story".to_owned()]));
        assert_eq!(snapshot.types["User Story"].color, "#009ccc");
    }

    #[test]
    fn who_is_working_on_what_and_whether_only_lower_priority_work_is_left() {
        answering();
        let report = run(settings()).unwrap().report;
        let ada = &report.people[0];
        assert_eq!(ada.items.iter().map(|i| i.id).collect::<Vec<_>>(), [1, 3, 4]);
        assert!(ada.items.iter().all(|i| i.goal));
        assert_eq!(ada.low_priority, Some(LowPriority { meets: false, reason: "Has unblocked goal work: #1, #3, #4.".into() }));
        let text = as_text(&report);
        assert!(text.starts_with("Sprint Sprint 1 (2026-10-30 to 2026-11-20), checked 2026-11-13T12:00:00.000Z."));
        assert!(text.contains("- #3 Item 3 [Blocked By resolved] Blocked By names #9 (Closed), all closed. Proposed fix: Clear Blocked By. https://dev.azure.com/acme/Web/_workitems/edit/3"));
        assert!(text.contains("- Ada: #1 Item 1 (Code Review, goal); #3 Item 3 (Active, goal); #4 Item 4 (Code Review, goal)"));
        assert!(text.ends_with("Not covered: Blocked but not marked: it needs comments read and judged, so it's left to you."));
    }

    #[test]
    fn without_a_goal_tag_the_lower_priority_test_is_off_and_says_so() {
        answering();
        let report = run(Settings { goal_tag: String::new(), ..settings() }).unwrap().report;
        assert_eq!(report.people[0].low_priority, None);
        assert_eq!(report.not_covered.len(), 2);
        assert!(!as_text(&report).contains("Blocked with only lower-priority work:\n"));
    }

    #[test]
    fn a_team_without_a_current_sprint_or_a_bad_setting_stops_before_any_az_call() {
        host::testing::answer(|_, _| Ok(json!({ "code": 0, "stdout": "[]", "stderr": "" })));
        assert_eq!(run(settings()).unwrap_err().message, "Web Team has no current sprint.");
        host::testing::answer(|_, _| panic!("no call"));
        assert_eq!(run(Settings { org: "x".into(), ..settings() }).unwrap_err().message, "Organization must look like https://dev.azure.com/<name>.");
    }

    #[test]
    fn a_signed_out_az_is_told_apart_from_a_failure() {
        host::testing::answer(|_, _| Ok(json!({ "code": 1, "stdout": "", "stderr": "ERROR: Please run 'az login' to setup account." })));
        let error = run(settings()).unwrap_err();
        assert!(error.signed_out);
        host::testing::answer(|_, _| Ok(json!({ "code": 1, "stdout": "", "stderr": "ERROR: boom" })));
        assert!(!run(settings()).unwrap_err().signed_out);
    }
}
