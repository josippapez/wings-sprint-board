//! The pieces every view of the sidebar draws, as the nodes `wings-plugin-ui/native` makes of its components.

use serde_json::{Value, json};
use wings_plugin::ui::{self, Node, row, stack, text};

/// A level of the app's width: an em space, as the native app has no padding to give a row.
const EM: &str = "\u{2003}";

pub fn gap(node: Node, gap: &str) -> Node {
    node.prop("gap", gap)
}

pub fn em_space() -> Node {
    text(EM)
}

pub fn muted_small(label: impl Into<String>) -> Node {
    ui::muted(label).prop("size", "small")
}

/// An error the page shows in a line of its own.
pub fn error_line(label: impl Into<String>) -> Node {
    text(label).prop("tone", "danger").prop("size", "small")
}

pub fn strong(label: impl Into<String>) -> Node {
    ui::title(label)
}

pub fn title_large(label: impl Into<String>) -> Node {
    Node::new("Text").prop("weight", "strong").prop("size", "large").text(label)
}

pub fn spinner() -> Node {
    ui::spinner().prop("size", "large")
}

/// A spinner and what is being read.
pub fn reading(label: &str) -> Node {
    row().child(spinner()).child(ui::muted(label))
}

pub fn heading(label: impl Into<String>) -> Node {
    Node::new("Heading").text(label)
}

/// A work item type's colour, as Azure Boards shows it.
pub fn dot(color: &str) -> Node {
    Node::new("Dot").prop("color", rgb_of(color))
}

/// The colour of `#rrggbb`, grey for anything else.
fn rgb_of(color: &str) -> u32 {
    color.strip_prefix('#').filter(|hex| hex.len() == 6).and_then(|hex| u32::from_str_radix(hex, 16).ok()).unwrap_or(0x88_88_88)
}

/// The assignee's avatar, or a dash for nobody.
pub fn avatar(name: Option<&str>) -> Node {
    match name.filter(|n| !n.is_empty()) {
        Some(name) => Node::new("Avatar").prop("name", name).prop("size", "small"),
        None => ui::muted("–"),
    }
}

/// A badge: outlined, or filled with a tone.
pub fn badge(label: impl Into<String>, tone: Option<&str>) -> Node {
    ui::badge(label, tone)
}

/// A box around related content, its parts one under the other.
pub fn card_of(content: Vec<Node>) -> Node {
    ui::card().child(gap(stack(), "m").children(content))
}

/// A labelled field with a hint under it.
pub fn field(label: &str, control: Node, hint: Option<&str>) -> Node {
    let name = text(label).prop("weight", "medium").prop("size", "field");
    gap(stack(), "s").key(label).child(name).child(control).maybe(hint.map(|h| ui::muted(h).prop("size", "field")))
}

/// Several controls under one label, with a hint under them.
pub fn field_group(label: &str, control: Node, hint: Option<&str>) -> Node {
    let name = text(label).prop("weight", "medium").prop("size", "field");
    gap(stack(), "m").key(label).child(name).child(control).maybe(hint.map(|h| ui::muted(h).prop("size", "field")))
}

/// Label and value pairs, one per line.
pub fn properties(items: Vec<(&str, Node)>) -> Node {
    gap(stack(), "s").children(items.into_iter().map(|(label, value)| {
        gap(row(), "m").key(label).prop("align", "baseline").child(ui::muted(label).prop("size", "small")).child(value.prop("grow", true))
    }))
}

/// A one-line value of `properties`.
pub fn value(label: impl Into<String>) -> Node {
    text(label).prop("size", "small")
}

/// Tabs that pick one of `items` over the panel they show: labels with a line under the picked one.
pub fn tabs(label: &str, items: &[(String, String)], value: &str, on_change: impl Fn(&str) + 'static, panel: Node) -> Node {
    let options: Vec<Value> = items.iter().map(|(value, label)| json!({ "value": value, "label": label })).collect();
    gap(stack(), "m").child(Node::new("Chips").prop("label", label).prop("options", options).prop("value", value).prop("line", true).on("onChange", move |event| on_change(event["value"].as_str().unwrap_or_default()))).child(panel)
}

/// A button of the size `sm` or `xs`.
pub fn small_button(label: impl Into<String>, variant: &str, size: &str, busy: bool, on_click: impl Fn() + 'static) -> Node {
    ui::button(label, variant, busy, on_click).prop("size", size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_type_colour_is_its_rgb_and_anything_else_is_grey() {
        assert_eq!((rgb_of("#009ccc"), rgb_of("blue"), rgb_of("#12")), (0x00_9c_cc, 0x88_88_88, 0x88_88_88));
    }
}
