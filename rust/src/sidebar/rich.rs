//! The HTML and markdown Azure DevOps keeps for a description or a comment, drawn as the lines they hold: paragraphs, list
//! items and code. Text from Azure DevOps goes into the page only as text, and only Azure DevOps links open.

use super::kit::gap;
use crate::{
    html::{Block, Kind, blocks_of, decode},
    markdown::markdown,
};
use serde_json::json;
use wings_plugin::{
    host,
    ui::{Node, card, muted, row, stack, text},
};

/// A code block: a card of monospace lines.
fn code_block(code: &str) -> Node {
    let lines = code.split('\n').map(|line| gap(row(), "m").prop("align", "baseline").child(text(if line.is_empty() { " " } else { line }).prop("mono", true).prop("size", "small").prop("grow", true)));
    card().child(gap(stack(), "none").children(lines))
}

fn lines(blocks: &[Block]) -> Node {
    let nodes = blocks.iter().map(|block| {
        if block.kind == Kind::Code {
            let code = block.text();
            let code = code.strip_prefix('\n').unwrap_or(&code);
            return code_block(code.strip_suffix('\n').unwrap_or(code));
        }
        let mut line = Node::new("Text").prop("grow", true);
        if block.kind == Kind::Heading {
            line = line.prop("weight", "strong");
        }
        for span in &block.spans {
            let look = &span.look;
            if look.strong || look.mono || look.muted || look.href.is_some() {
                let mut part = Node::new("Text").text(span.text.as_str());
                if look.strong {
                    part = part.prop("weight", "strong");
                }
                if look.mono {
                    part = part.prop("mono", true);
                }
                if look.muted {
                    part = part.prop("tone", "muted");
                }
                if let Some(href) = look.href.clone() {
                    part = part.on("onClick", move |_| drop(host::call("openUrl", json!({ "url": href }))));
                }
                line = line.child(part);
            } else {
                line = line.text(span.text.as_str());
            }
        }
        if block.kind != Kind::Item && block.depth == 0 {
            return line;
        }
        // List items indent by an em space a level, as the native app has no padding to give a row.
        let marker = format!("{}{}", "\u{2003}".repeat(block.depth.saturating_sub(1)), if block.kind == Kind::Item { block.marker.as_deref().unwrap_or_default() } else { "\u{2003}" });
        gap(row(), "s").prop("align", "start").child(muted(marker)).child(line)
    });
    gap(stack(), "s").children(nodes)
}

/// Azure DevOps rich text.
pub fn rich_text(html: &str) -> Node {
    lines(&blocks_of(html))
}

/// An Azure DevOps markdown field. It keeps `<`, `>`, `"` and `&` as HTML entities, which are decoded to text.
pub fn markdown_text(src: &str) -> Node {
    gap(stack(), "s").child(markdown(&decode(src)))
}
