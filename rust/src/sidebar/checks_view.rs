//! The board checks: findings, who is working on what, and the lower-priority test.

use super::{
    Sidebar,
    items::open_item,
    kit::{badge, card_of, gap, heading, muted_small},
};
use crate::check::{Finding, Person};
use wings_plugin::ui::{self, Node, card, muted, row, stack, text};

/// A work item's id and title, opening it in the sidebar.
pub fn item_link(id: u64, title: &str) -> Node {
    Node::new("ListButton").on("onClick", move |_| open_item(id, true)).child(muted(format!("#{id} "))).text(title)
}

/// A heading with a count on its right.
fn counted(label: &str, count: usize) -> Node {
    row().prop("justify", "between").prop("wrap", true).child(heading(label)).child(muted_small(count.to_string()))
}

fn finding(f: &Finding, n: usize) -> Node {
    card().key(n.to_string()).child(
        gap(stack(), "s")
            .child(row().child(badge(if f.dependency { format!("{} · dependency", f.check) } else { f.check.clone() }, Some("warn"))))
            .child(item_link(f.id, &f.title))
            .child(text(f.problem.as_str()))
            .child(Node::new("Text").prop("tone", "muted").prop("size", "small").child(text("Proposed fix: ").prop("weight", "medium")).text(f.fix.as_str())),
    )
}

fn person(p: &Person, n: usize) -> Node {
    let items = p.items.iter().map(|i| {
        let mut state = row().prop("wrap", true);
        state = gap(state, "s").child(muted_small(i.state.as_str()));
        if i.goal {
            state = state.child(badge("Goal", Some("info")));
        }
        if i.blocked {
            state = state.child(badge(format!("Blocked: {}", i.blocked_by.as_deref().unwrap_or_default()), Some("danger")));
        }
        ui::list_row(i.id.to_string(), gap(stack(), "xs").child(item_link(i.id, &i.title)).child(state))
    });
    card_of(vec![
        row().prop("justify", "between").child(super::kit::strong(p.name.as_str())).child(muted_small(format!("{} open", p.items.len()))),
        if p.items.is_empty() { muted_small("No open items in this sprint.") } else { ui::list().children(items) },
    ])
    .key(format!("person:{n}"))
}

/// The board checks: findings, who is working on what, and the lower-priority test.
pub fn render(s: &Sidebar) -> Vec<Node> {
    let Some(r) = s.main.as_ref().and_then(|m| m.result.as_ref()) else { return Vec::new() };
    let mut parts = vec![counted("Findings", r.findings.len())];
    parts.push(if r.findings.is_empty() { card().key("clean").child(text("Board is clean.").prop("tone", "success").prop("weight", "medium")) } else { stack().key("list").children(r.findings.iter().enumerate().map(|(n, f)| finding(f, n))) });
    parts.push(heading("Working on"));
    parts.extend(r.people.iter().enumerate().map(|(n, p)| person(p, n)));
    if r.goal_tag.is_some() {
        parts.push(heading("Blocked with only lower-priority work"));
        parts.extend(r.people.iter().enumerate().map(|(n, p)| {
            let low = p.low_priority.as_ref();
            let meets = low.is_some_and(|l| l.meets);
            let verdict = text(format!("{}: {}. ", p.name, if meets { "yes" } else { "no" })).prop("weight", "strong");
            card().key(format!("verdict:{n}")).child(Node::new("Text").child(if meets { verdict.prop("tone", "danger") } else { verdict }).text(low.map_or("", |l| l.reason.as_str())))
        }));
    }
    parts.push(muted_small(format!("Not covered: {}", r.not_covered.join(" "))).key("not-covered"));
    parts
}
