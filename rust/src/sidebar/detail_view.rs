//! An item's details and comments in the sidebar. Text from Azure DevOps goes into the page only as text nodes.

use super::{
    Sidebar, board_view::pr_tone,
    items::{Detail, back, open_item},
    kit::{avatar, badge, dot, error_line, gap, heading, muted_small, properties, reading, title_large, value},
    rich::{markdown_text, rich_text},
    time::ago,
};
use crate::{az::text as az_text, check::blocked_by_parts};
use serde_json::Value;
use wings_plugin::{
    host,
    ui::{self, Node, muted, row, stack, text},
};

/// An item link that opens it here.
fn item_link_here(s: &Sidebar, id: u64) -> Node {
    let known = s.by_id(id);
    let fetched = s.details.get(&id).and_then(|d| d.item.as_ref()).and_then(|i| i["fields"]["System.Title"].as_str());
    let shown = known.map(|k| k.title.as_str()).or(fetched).unwrap_or("Outside this sprint");
    let mut parts = Vec::new();
    parts.extend(known.map(|k| dot(s.type_color(&k.kind))));
    parts.push(muted(id.to_string()).prop("mono", true).prop("size", "tiny"));
    parts.push(if known.is_some() || fetched.is_some() { text(shown) } else { muted(shown) }.prop("truncate", true).prop("grow", true));
    parts.extend(known.map(|k| badge(k.state.as_str(), None)));
    ui::list_button(parts, move || open_item(id, true)).prop("title", known.map_or(format!("#{id}"), |k| format!("{}: {}", k.kind, k.title))).key(id.to_string())
}

/// Whether a long-text field holds markdown: `az boards work-item show` says so in multilineFieldsFormat.
fn is_markdown(d: Option<&Detail>, field: &str) -> bool {
    d.and_then(|d| d.item.as_ref()).and_then(|i| i["multilineFieldsFormat"][field].as_str()).is_some_and(|f| f.eq_ignore_ascii_case("markdown"))
}

fn rich_section(name: &str, body: &str, markdown: bool) -> Node {
    gap(stack(), "s").key(name).child(heading(name)).child(if markdown { markdown_text(body) } else { rich_text(body) })
}

/// A comment's body, as rich text or markdown.
fn comment_body(c: &Value) -> Node {
    let source = |key: &str| az_text(&c[key]);
    if c["format"] == "markdown" {
        return markdown_text(&source("text"));
    }
    let (rendered, plain) = (source("renderedText"), source("text"));
    rich_text(if rendered.is_empty() { &plain } else { &rendered })
}

fn last_part(path: &str) -> &str {
    path.rsplit('\\').next().unwrap_or(path)
}

fn ids_of(relations: &[Value], rel: &str) -> Vec<u64> {
    relations.iter().filter(|r| r["rel"] == rel).filter_map(|r| r["url"].as_str()?.rsplit('/').next()?.parse().ok()).collect()
}

fn some_if(name: &str, node: Node, show: bool) -> Option<(&str, Node)> {
    show.then_some((name, node))
}

pub fn render(s: &Sidebar, id: u64) -> Vec<Node> {
    let known = s.by_id(id);
    let d = s.details.get(&id);
    let item = d.and_then(|d| d.item.as_ref());
    let f = item.map_or(&Value::Null, |i| &i["fields"]);
    let field = |name: &str| f[name].as_str().map(str::to_owned);
    let title = field("System.Title").or_else(|| known.map(|k| k.title.clone())).unwrap_or_else(|| format!("#{id}"));
    let kind = field("System.WorkItemType").or_else(|| known.map(|k| k.kind.clone())).unwrap_or_default();
    let state = field("System.State").or_else(|| known.map(|k| k.state.clone())).unwrap_or_default();
    let assignee = f["System.AssignedTo"]["displayName"].as_str().map(str::to_owned).or_else(|| known.and_then(|k| k.assignee.clone()));
    let tags: Vec<String> = if f["System.Tags"].is_null() { known.map(|k| k.tags.clone()).unwrap_or_default() } else { crate::az::tags_of(&f["System.Tags"]) };
    let relations: Vec<Value> = item.and_then(|i| i["relations"].as_array().cloned()).unwrap_or_default();
    let parent = if item.is_some() { ids_of(&relations, "System.LinkTypes.Hierarchy-Reverse").first().copied() } else { known.and_then(|k| k.parent) };
    let children: Vec<u64> = if item.is_some() { ids_of(&relations, "System.LinkTypes.Hierarchy-Forward") } else { s.snapshot.iter().flat_map(|b| &b.items).filter(|i| i.parent == Some(id)).map(|i| i.id).collect() };
    let settings = s.settings();
    let blocked_by = known.and_then(|k| k.blocked_by.clone()).or_else(|| (!settings.blocked_by_field.is_empty()).then(|| field(&settings.blocked_by_field)).flatten()).filter(|b| !b.is_empty());
    let (blockers, note) = blocked_by.as_deref().map_or((Vec::new(), String::new()), blocked_by_parts);
    let state_color = s.state_color(&kind, &state).unwrap_or("#888888");
    let pr_rows: Vec<Node> = d.map_or(Vec::new(), |d| {
        d.prs
            .iter()
            .map(|(pr, p)| {
                let web = az_text(&p["repository"]["webUrl"]);
                let url = web.starts_with("https://dev.azure.com/").then(|| format!("{web}/pullrequest/{pr}"));
                let label = p["title"].as_str().map(str::to_owned).unwrap_or_else(|| if p["error"].is_null() { String::new() } else { "Couldn't read it".to_owned() });
                let status = p["status"].as_str().filter(|st| !st.is_empty());
                let mut button = ui::list_button(
                    [muted(format!("!{pr}")).prop("mono", true).prop("size", "tiny"), text(label).prop("truncate", true).prop("grow", true)].into_iter().chain(status.map(|st| badge(if p["isDraft"] == true && st == "active" { "draft" } else { st }, pr_tone(st)))),
                    {
                        let url = url.clone();
                        move || {
                            if let Some(url) = &url {
                                host::open_url(url);
                            }
                        }
                    },
                )
                .key(pr.to_string())
                .prop("title", if url.is_some() { "Open the pull request".to_owned() } else { az_text(&p["error"]) });
                if url.is_none() {
                    button = button.prop("disabled", true);
                }
                button
            })
            .collect()
    });
    let comments: &[Value] = d.map_or(&[], |d| d.comments.as_slice());
    let rows: Vec<(&str, Node)> = [
        some_if("State", gap(row(), "s").child(dot(state_color)).child(value(state.as_str())), true),
        some_if("Assigned", gap(row(), "s").child(avatar(assignee.as_deref())).child(value(assignee.as_deref().unwrap_or("Unassigned"))), true),
        some_if("Iteration", value(last_part(&az_text(&f["System.IterationPath"]))), !f["System.IterationPath"].as_str().unwrap_or_default().is_empty()),
        some_if("Area", value(last_part(&az_text(&f["System.AreaPath"]))), !f["System.AreaPath"].as_str().unwrap_or_default().is_empty()),
        some_if("Tags", gap(row(), "s").prop("wrap", true).children(tags.iter().enumerate().map(|(n, t)| badge(t.as_str(), None).key(n.to_string()))), !tags.is_empty()),
        some_if("Parent", parent.map_or_else(|| value(""), |p| item_link_here(s, p)), parent.is_some_and(|p| p > 0)),
        some_if("Children", gap(stack(), "none").children(children.iter().map(|c| item_link_here(s, *c))), !children.is_empty()),
        some_if(
            "Blocked by",
            gap(stack(), "none").children(blockers.iter().map(|b| item_link_here(s, *b))).maybe((!note.is_empty()).then(|| value(note.as_str()))),
            blocked_by.is_some(),
        ),
        some_if("Pull requests", gap(stack(), "none").children(pr_rows), d.is_some_and(|d| !d.prs.is_empty())),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut out = vec![
        gap(row(), "m")
            .prop("wrap", true)
            .key("bar")
            .child(ui::button("‹ Back", "ghost", false, back))
            .child(text("").prop("grow", true))
            .child({
                let url = s.work_item_url(id);
                ui::button("Open in Azure DevOps", "ghost", false, move || host::open_url(&url))
            }),
        gap(row(), "s").key("kind").child(dot(s.type_color(&kind))).child(muted_small(format!("{kind} {id}"))),
        title_large(title).key("title"),
        properties(rows).key("properties"),
    ];
    if d.is_some_and(|d| d.loading) {
        out.push(reading("Loading details and comments…").key("loading"));
    }
    out.extend(d.and_then(|d| d.error.as_deref()).map(|e| error_line(format!("Couldn't read the item: {e}")).key("error")));
    for (field, label) in [("System.Description", "Description"), ("Microsoft.VSTS.Common.AcceptanceCriteria", "Acceptance criteria")] {
        if let Some(body) = f[field].as_str().filter(|b| !b.is_empty()) {
            out.push(rich_section(label, body, is_markdown(d, field)));
        }
    }
    if item.is_some() {
        let list = if comments.is_empty() {
            muted_small("No comments.")
        } else {
            gap(stack(), "l").children(comments.iter().enumerate().map(|(n, c)| {
                let who = c["createdBy"]["displayName"].as_str();
                gap(stack(), "s")
                    .key(n.to_string())
                    .child(
                        gap(row(), "s")
                            .child(avatar(who))
                            .child(text(who.unwrap_or("Someone")).prop("size", "small").prop("weight", "medium").prop("truncate", true))
                            .child(muted_small(ago(&az_text(&c["createdDate"])))),
                    )
                    .child(comment_body(c))
            }))
        };
        out.push(gap(stack(), "s").key("discussion").child(heading(format!("Discussion · {}", comments.len()))).child(list));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn links_are_the_work_item_ids_a_relation_of_that_kind_points_to() {
        let relations = [json!({ "rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://x/_apis/wit/workItems/4" }), json!({ "rel": "System.LinkTypes.Hierarchy-Forward", "url": "https://x/_apis/wit/workItems/7" }), json!({ "rel": "System.LinkTypes.Hierarchy-Forward", "url": "https://x/_apis/wit/workItems/8" }), json!({ "rel": "ArtifactLink", "url": "vstfs:///x" })];
        let relations: Vec<Value> = relations.into();
        assert_eq!((ids_of(&relations, "System.LinkTypes.Hierarchy-Reverse"), ids_of(&relations, "System.LinkTypes.Hierarchy-Forward")), (vec![4], vec![7, 8]));
        assert_eq!(last_part("Web\\Sprint 3"), "Sprint 3");
    }

    #[test]
    fn a_field_is_markdown_when_the_item_says_so() {
        let d = Detail { item: Some(json!({ "multilineFieldsFormat": { "System.Description": "markdown", "Other": "html" } })), ..Detail::default() };
        assert!(is_markdown(Some(&d), "System.Description") && !is_markdown(Some(&d), "Other") && !is_markdown(None, "System.Description"));
    }
}
