//! What the board view reads when asked: an item's details, comments and pull requests, kept until the board shows a
//! newer revision of it, and the items outside the sprint, or in another one, which the list shows.

use super::{Sidebar, lists::invoke, with};
use crate::{
    az::{Relation, az_json, pull_request_ids, text},
    check::BoardItem,
    settings::quote,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use wings_plugin::{host, task::{join, spawn}};

/// An item's details, as the item view has them.
#[derive(Default)]
pub struct Detail {
    pub rev: u64,
    /// `az boards work-item show --expand relations`.
    pub item: Option<Value>,
    pub comments: Vec<Value>,
    /// Each pull request as `az repos pr show` printed it, or `{ error }`, as it was read.
    pub prs: Vec<(u64, Value)>,
    pub error: Option<String>,
    pub loading: bool,
}

/// How many items a search of the whole project, or of no sprint, lists. A picked sprint lists all of its items.
const OUTSIDE_LIMIT: usize = 50;

/// No sprint: items on the project's root iteration, the backlog.
pub const NO_SPRINT: &str = "none";

/// Items read for the list beyond the board: with `sprint` empty, the project's items that match the search but aren't
/// on the board; otherwise the picked sprint's items (or no sprint's), matching the search if there is one.
#[derive(Default)]
pub struct Outside {
    pub key: String,
    pub items: Vec<BoardItem>,
    pub more: bool,
    pub loading: bool,
    pub error: Option<String>,
}

/// Drops cached details whose item the board now shows at a newer revision, and reads the one on screen again.
pub fn drop_stale_details() {
    let reopen = with(|s| {
        let revs: HashMap<u64, u64> = s.snapshot.as_ref()?.items.iter().map(|i| (i.id, i.rev)).collect();
        let stale: Vec<u64> = s.details.iter().filter(|(id, d)| revs.get(id).is_some_and(|rev| *rev != d.rev)).map(|(id, _)| *id).collect();
        for id in &stale {
            s.details.remove(id);
        }
        s.opened.last().copied().filter(|id| stale.contains(id))
    });
    if let Some(id) = reopen {
        open_item(id, false);
    }
}

/// Opens an item in the sidebar and reads what the board doesn't have.
pub fn open_item(id: u64, push: bool) {
    let settings = with(|s| {
        if push && s.opened.last() != Some(&id) {
            s.opened.push(id);
        }
        let known = s.by_id(id).map(|i| i.rev);
        if let Some(cached) = s.details.get(&id)
            && (cached.loading || (cached.item.is_some() && cached.error.is_none() && known.is_none_or(|rev| rev == cached.rev)))
        {
            return None;
        }
        s.details.insert(id, Detail { rev: known.unwrap_or(0), loading: true, ..Detail::default() });
        Some(s.settings())
    });
    if let Some(settings) = settings {
        spawn(load_detail(id, settings));
    }
}

fn relations_of(item: &Value) -> Vec<Relation> {
    item["relations"].as_array().into_iter().flatten().map(|r| Relation { rel: text(&r["rel"]), url: text(&r["url"]) }).collect()
}

async fn load_detail(id: u64, s: crate::settings::Settings) {
    let org = s.org.as_str();
    let (item, comments) = join(
        az_json(&["boards", "work-item", "show", "--id", &id.to_string(), "--expand", "relations"], Some(org)),
        invoke(org, "comments", &[format!("project={}", s.project), format!("workItemId={id}")], &["order=asc"], "wit", "7.1-preview"),
    )
    .await;
    let (item, comments) = match (item, comments) {
        (Ok(item), Ok(comments)) => (item, comments),
        (Err(error), _) | (_, Err(error)) => {
            with(|s| {
                if let Some(d) = s.details.get_mut(&id) {
                    d.error = Some(error.line());
                    d.loading = false;
                }
            });
            return;
        }
    };
    let relations = relations_of(&item);
    with(|s| {
        if let Some(d) = s.details.get_mut(&id) {
            d.rev = item["rev"].as_u64().unwrap_or(d.rev);
            d.item = Some(item).filter(|i| !i.is_null());
            d.comments = comments["comments"].as_array().cloned().unwrap_or_default();
            d.loading = false;
        }
    });
    // Pull requests last: the item is already on screen.
    for pr in pull_request_ids(&relations) {
        let org = s.org.clone();
        spawn(async move {
            let read = az_json(&["repos", "pr", "show", "--id", &pr.to_string(), "--detect", "false"], Some(&org)).await;
            let read = read.unwrap_or_else(|error| json!({ "error": error.line() }));
            with(|s| {
                if let Some(d) = s.details.get_mut(&id) {
                    d.prs.push((pr, read));
                }
            });
        });
    }
}

pub fn back() {
    with(|s| s.opened.pop());
}

/// A search that is all digits, as an item's id.
fn id_of(q: &str) -> Option<u64> {
    q.chars().all(|c| c.is_ascii_digit()).then(|| q.parse().ok()).flatten().filter(|id| *id > 0)
}

/// The WIQL of the list beyond the board.
pub fn outside_wiql(project: &str, sprint: &str, q: &str) -> String {
    let id = id_of(q);
    let by_text = if q.is_empty() { String::new() } else { std::iter::once(format!("[System.Title] CONTAINS {}", quote(q))).chain(id.map(|id| format!("[System.Id] = {id}"))).collect::<Vec<_>>().join(" OR ") };
    let mut wher = vec![format!("[System.TeamProject] = {}", quote(project))];
    if !sprint.is_empty() {
        wher.push(format!("[System.IterationPath] = {}", quote(if sprint == NO_SPRINT { project } else { sprint })));
        wher.push("[System.State] <> 'Removed'".to_owned());
    }
    if !by_text.is_empty() {
        wher.push(format!("({by_text})"));
    }
    format!(
        "SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.AssignedTo], [System.Parent], [System.IterationPath], [System.Rev], [System.CommentCount] FROM WorkItems WHERE {} ORDER BY [System.ChangedDate] DESC",
        wher.join(" AND ")
    )
}

/// A row of that query as a board item.
fn outside_item(row: &Value, category: impl Fn(&str, &str) -> String) -> BoardItem {
    let f = &row["fields"];
    let (kind, state) = (text(&f["System.WorkItemType"]), text(&f["System.State"]));
    let who = |key: &str| f["System.AssignedTo"][key].as_str().map(str::to_owned);
    BoardItem {
        id: row["id"].as_u64().unwrap_or(0),
        rev: f["System.Rev"].as_u64().or_else(|| row["rev"].as_u64()).unwrap_or(0),
        title: text(&f["System.Title"]),
        category: category(&kind, &state),
        kind,
        state,
        assignee: who("displayName"),
        login: who("uniqueName"),
        parent: f["System.Parent"].as_u64(),
        tags: Vec::new(),
        blocked: false,
        blocked_by: None,
        comments: f["System.CommentCount"].as_u64().unwrap_or(0),
        prs: None,
        checks: Vec::new(),
        iteration: Some(text(&f["System.IterationPath"])),
    }
}

/// Reads `outside` a moment after typing stops. Searching the whole project needs two characters, or an id.
pub fn search_outside(s: &mut Sidebar, typed: &str, sprint: &str) {
    // A picked sprint is read whole and the list filters it; no sprint can be too long for that.
    let q = if !sprint.is_empty() && sprint != NO_SPRINT { "" } else { typed.trim().strip_prefix('#').unwrap_or(typed.trim()) };
    let key = format!("{sprint}|{q}");
    if key == s.outside.key {
        return;
    }
    s.outside = Outside { key: key.clone(), ..Outside::default() };
    if sprint.is_empty() && id_of(q).is_none() && q.chars().count() < 2 {
        return;
    }
    s.outside.loading = true;
    let (q, sprint) = (q.to_owned(), sprint.to_owned());
    spawn(async move {
        host::sleep(400).await;
        read_outside(key, sprint, q).await;
    });
}

/// Reads the list beyond the board for a search, unless another one has come since.
async fn read_outside(key: String, sprint: String, q: String) {
    {
        let settings = with(|s| s.settings());
        let wiql = outside_wiql(&settings.project, &sprint, &q);
        let rows = az_json(&["boards", "query", "--wiql", &wiql, "--project", &settings.project], Some(&settings.org)).await;
        with(|s| {
            if s.outside.key != key {
                return;
            }
            match rows {
                Ok(rows) => {
                    let found: Vec<&Value> = rows.as_array().into_iter().flatten().filter(|r| !sprint.is_empty() || s.by_id(r["id"].as_u64().unwrap_or(0)).is_none()).collect();
                    let limit = if !sprint.is_empty() && sprint != NO_SPRINT { found.len() } else { OUTSIDE_LIMIT };
                    s.outside.more = found.len() > limit;
                    let category = |kind: &str, state: &str| s.snapshot.as_ref().and_then(|b| b.types.get(kind)).and_then(|t| t.states.iter().find(|x| x.name == state)).map_or(String::new(), |x| x.category.clone());
                    let items: Vec<BoardItem> = found.iter().take(limit).map(|r| outside_item(r, category)).collect();
                    s.outside.items = items;
                }
                Err(error) => s.outside.error = Some(error.line()),
            }
            s.outside.loading = false;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::check::Snapshot;
    use wings_plugin::task::block_on;

    #[test]
    fn the_search_beyond_the_board_asks_for_the_title_or_the_id_in_the_sprint_or_the_project() {
        assert_eq!(
            outside_wiql("Web", "", "42"),
            "SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.AssignedTo], [System.Parent], [System.IterationPath], [System.Rev], [System.CommentCount] FROM WorkItems WHERE [System.TeamProject] = 'Web' AND ([System.Title] CONTAINS '42' OR [System.Id] = 42) ORDER BY [System.ChangedDate] DESC"
        );
        assert!(outside_wiql("Web", "none", "").contains("AND [System.IterationPath] = 'Web' AND [System.State] <> 'Removed' ORDER"));
        assert!(outside_wiql("Web", "Web\\Sprint 3", "o'k").contains("[System.IterationPath] = 'Web\\Sprint 3' AND [System.State] <> 'Removed' AND ([System.Title] CONTAINS 'o''k') ORDER"));
    }

    fn sidebar_with_board() {
        with(|s| {
            s.main = Some(crate::state::Published { phase: crate::state::Phase::Ready, settings: crate::testing::settings(), missing: Vec::new(), result: None, error: None, running: false });
            s.snapshot = Some(Snapshot { checked_at: String::new(), sprint: crate::check::Sprint { name: "S".into(), path: String::new(), start: None, finish: None }, items: vec![board_item(1, 5)], types: Default::default() });
        });
    }

    fn board_item(id: u64, rev: u64) -> BoardItem {
        BoardItem { id, rev, title: "T".into(), kind: "Task".into(), state: "New".into(), category: "Proposed".into(), assignee: None, login: None, parent: None, tags: vec![], blocked: false, blocked_by: None, comments: 0, prs: None, checks: vec![], iteration: None }
    }

    /// `az` for one work item with a linked pull request, and its comments.
    fn answering(rev: u64) {
        host::testing::answer(move |_, params| {
            let args: Vec<&str> = params["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
            let ok = |v: Value| Ok(json!({ "code": 0, "stdout": v.to_string(), "stderr": "" }));
            match (args[0], args[1]) {
                ("boards", "work-item") => ok(json!({ "rev": rev, "fields": { "System.Title": "T" }, "relations": [{ "rel": "ArtifactLink", "url": "vstfs:///Git/PullRequestId/p%2Fr%2F9" }] })),
                ("devops", "invoke") => ok(json!({ "comments": [{ "id": 1, "text": "hi" }] })),
                ("repos", "pr") => ok(json!({ "status": "active", "title": "A PR" })),
                _ => Err("unexpected".into()),
            }
        });
    }

    #[test]
    fn an_item_reads_its_details_comments_and_pull_requests_once_and_again_when_the_board_has_a_newer_revision() {
        sidebar_with_board();
        answering(5);
        open_item(1, true);
        block_on(async {});
        with(|s| {
            let d = &s.details[&1];
            assert_eq!((d.loading, d.rev, d.comments.len(), d.prs.len(), s.opened.clone()), (false, 5, 1, 1, vec![1]));
            assert_eq!(d.prs[0].1["title"], "A PR");
        });
        // A newer revision on the board drops it and, as it is on screen, reads it again.
        answering(6);
        with(|s| s.snapshot.as_mut().unwrap().items[0].rev = 6);
        drop_stale_details();
        block_on(async {});
        with(|s| assert_eq!((s.details[&1].rev, s.details[&1].loading), (6, false)));
    }

    #[test]
    fn a_detail_that_failed_says_why_and_is_read_again_when_opened() {
        sidebar_with_board();
        host::testing::answer(|_, _| Ok(json!({ "code": 1, "stdout": "", "stderr": "WARNING: w\nERROR: no access" })));
        open_item(1, true);
        block_on(async {});
        with(|s| assert_eq!((s.details[&1].error.clone(), s.details[&1].loading), (Some("ERROR: no access".to_owned()), false)));
        answering(5);
        open_item(1, true);
        block_on(async {});
        with(|s| assert_eq!((s.details[&1].error.clone(), s.details[&1].item.is_some()), (None, true)));
    }

    #[test]
    fn a_search_outside_the_sprint_lists_what_the_board_lacks_after_a_pause() {
        sidebar_with_board();
        host::testing::answer(|_, params| {
            if params["program"] != "az" {
                return Ok(Value::Null);
            }
            let rows = json!([
                { "id": 1, "fields": { "System.Title": "On the board", "System.WorkItemType": "Task", "System.State": "New" } },
                { "id": 77, "fields": { "System.Title": "Old one", "System.WorkItemType": "Bug", "System.State": "Active", "System.IterationPath": "Web\\Old", "System.AssignedTo": { "displayName": "Ada" }, "System.CommentCount": 2 } },
            ]);
            Ok(json!({ "code": 0, "stdout": rows.to_string(), "stderr": "" }))
        });
        let key = with(|s| {
            search_outside(s, "x", "");
            assert!(!s.outside.loading, "one character searches nothing");
            search_outside(s, "#old", "");
            assert!(s.outside.loading);
            s.outside.key.clone()
        });
        assert_eq!(key, "|old");
        block_on(read_outside(key, String::new(), "old".into()));
        with(|s| {
            assert_eq!(s.outside.items.iter().map(|i| (i.id, i.iteration.clone().unwrap(), i.comments)).collect::<Vec<_>>(), [(77, "Web\\Old".to_owned(), 2)]);
            assert!(!s.outside.loading && s.outside.error.is_none());
        });
    }
}
