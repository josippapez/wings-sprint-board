//! Markdown as nodes, as `wings-plugin-ui/native`'s `Markdown` draws it from `markdown.js`'s parser. No HTML is parsed
//! beyond a comment (hidden) and `<details>` (a fold); images show as their alt text; only https links are links. Emoji
//! shortcodes stay as written.

use serde_json::json;
use wings_plugin::{
    host,
    ui::{Node, card, row, stack, text},
};

#[derive(Debug, PartialEq)]
pub enum Block {
    Heading(usize, String),
    Paragraph(String),
    List { ordered: bool, items: Vec<Item> },
    Code { lang: String, text: String },
    Quote(String),
    Rule,
    Table { head: Vec<String>, rows: Vec<Vec<String>> },
    Details { summary: String, blocks: Vec<Block> },
}

#[derive(Debug, PartialEq)]
pub struct Item {
    pub text: String,
    pub depth: usize,
    pub checked: Option<bool>,
}

const MAX_DETAILS_DEPTH: usize = 3;

/// A heading's text without its closing hashes (`## Title ##`).
fn heading_text(text: &str) -> &str {
    let t = text.trim_end();
    let without = t.trim_end_matches('#');
    if without.len() < t.len() && !without.is_empty() && without.ends_with(char::is_whitespace) { without.trim_end() } else { t }
}

fn heading_of(line: &str) -> Option<(usize, &str)> {
    let rest = line.trim_start_matches(' ');
    if line.len() - rest.len() > 3 {
        return None;
    }
    let level = rest.bytes().take_while(|b| *b == b'#').count();
    let after = rest.get(level..)?;
    ((1..=6).contains(&level) && after.starts_with(char::is_whitespace)).then(|| (level, heading_text(after.trim_start())))
}

fn fence_of(line: &str) -> Option<(&str, &str)> {
    let t = line.trim_start();
    let mark = if t.starts_with("```") { "```" } else if t.starts_with("~~~") { "~~~" } else { return None };
    let lang = t[3..].trim_start();
    let end = lang.find(|c: char| !(c.is_alphanumeric() || matches!(c, '_' | '+' | '-'))).unwrap_or(lang.len());
    Some((mark, &lang[..end]))
}

fn rule(line: &str) -> bool {
    let t: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    let first = t.chars().next();
    t.len() >= 3 && matches!(first, Some('-' | '*' | '_')) && t.chars().all(|c| Some(c) == first)
}

/// A list item: its indent in columns, whether it is numbered, and its text.
fn list_item(line: &str) -> Option<(usize, bool, &str)> {
    let t = line.trim_start();
    let indent = line.len() - t.len();
    let columns = line[..indent].replace('\t', "  ").len();
    if let Some(rest) = t.strip_prefix(['-', '*', '+']) {
        return rest.strip_prefix(char::is_whitespace).map(|rest| (columns, false, rest.trim_start()));
    }
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    let rest = t.get(digits..)?.strip_prefix(['.', ')'])?;
    (digits > 0).then_some(rest)?.strip_prefix(char::is_whitespace).map(|rest| (columns, true, rest.trim_start()))
}

fn ref_definition(line: &str) -> bool {
    let t = line.trim_start();
    if line.len() - t.len() > 3 || !t.starts_with('[') {
        return false;
    }
    match t.find("]:") {
        Some(at) if (2..=201).contains(&at) && !t[1..at].contains('\n') => t[at + 2..].trim_start().chars().next().is_some(),
        _ => false,
    }
}

/// The cells of a table row: split on `|` that isn't escaped as `\|`, outer pipes dropped.
fn split_row(line: &str) -> Vec<String> {
    let mut s = line.trim();
    s = s.strip_prefix('|').unwrap_or(s);
    if s.ends_with('|') && !s.ends_with("\\|") {
        s = &s[..s.len() - 1];
    }
    let (mut cells, mut cell, mut chars) = (Vec::new(), String::new(), s.chars().peekable());
    while let Some(c) = chars.next() {
        match (c, chars.peek()) {
            ('\\', Some('|')) => {
                cell.push('|');
                chars.next();
            }
            ('|', _) => cells.push(std::mem::take(&mut cell).trim().to_owned()),
            _ => cell.push(c),
        }
    }
    cells.push(cell.trim().to_owned());
    cells
}

fn delimiter_row(line: &str) -> Option<usize> {
    if !line.contains('-') || (!line.contains('|') && !line.trim().chars().all(|c| matches!(c, ':' | '-'))) {
        return None;
    }
    let cells = split_row(line);
    let ok = cells.iter().all(|c| {
        let t = c.trim_matches(':');
        !t.is_empty() && t.chars().all(|c| c == '-') && c.len() - t.len() <= 2
    });
    ok.then_some(cells.len())
}

fn count(haystack: &str, needle: &str) -> usize {
    haystack.to_lowercase().matches(needle).count()
}

pub fn parse_blocks(src: &str, depth: usize) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut lines: Vec<String> = src.replace("\r\n", "\n").replace('\r', "\n").split('\n').map(str::to_owned).collect();
    let mut paragraph: Vec<String> = Vec::new();
    let flush = |paragraph: &mut Vec<String>, blocks: &mut Vec<Block>| {
        if !paragraph.is_empty() {
            blocks.push(Block::Paragraph(paragraph.join(" ")));
        }
        paragraph.clear();
    };
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].clone();
        if let Some((mark, lang)) = fence_of(&line) {
            flush(&mut paragraph, &mut blocks);
            let mut code = Vec::new();
            i += 1;
            while i < lines.len() && lines[i].trim() != mark {
                code.push(lines[i].clone());
                i += 1;
            }
            blocks.push(Block::Code { lang: lang.to_owned(), text: code.join("\n") });
            i += 1;
            continue;
        }
        // An HTML comment shows nothing, not inside inline code. One left open hides the rest, as in HTML.
        if let Some(at) = line.find("<!--").filter(|at| line[..*at].matches('`').count() % 2 == 0) {
            let mut rest = line[at + 4..].to_owned();
            let mut j = i;
            while !rest.contains("-->") && j + 1 < lines.len() {
                j += 1;
                rest.push('\n');
                rest.push_str(&lines[j]);
            }
            let kept = rest.find("-->").map_or("", |close| &rest[close + 3..]);
            lines[j] = format!("{}{kept}", &line[..at]);
            i = j;
            continue;
        }
        if line.trim().is_empty() || ref_definition(&line) {
            flush(&mut paragraph, &mut blocks);
            i += 1;
            continue;
        }
        // ASCII only: `to_lowercase` can change a letter's length, and these offsets are used on the text itself.
        let lower = line.to_ascii_lowercase();
        let tag_at = if depth < MAX_DETAILS_DEPTH { lower.find("<details") } else { None };
        if let Some(at) = tag_at.filter(|at| *at > 0 && !line[..*at].trim().is_empty() && line[..*at].matches('`').count() % 2 == 0) {
            paragraph.push(line[..at].trim().to_owned());
            lines[i] = line[at..].to_owned();
            continue;
        }
        if depth < MAX_DETAILS_DEPTH && lower.trim_start().starts_with("<details") && lower.trim_start()[8..].starts_with(|c: char| c == '>' || c.is_whitespace()) {
            flush(&mut paragraph, &mut blocks);
            let first = &line[line.find('>').map_or(line.len(), |at| at + 1)..];
            let mut body = vec![first.to_owned()];
            let balance = |text: &str| count(text, "<details") as i64 - count(text, "</details>") as i64;
            let mut open = 1 + balance(first);
            while open > 0 && i + 1 < lines.len() {
                i += 1;
                body.push(lines[i].clone());
                open += balance(&lines[i]);
            }
            let mut inner = body.join("\n");
            if open <= 0
                && let Some(close) = inner.to_ascii_lowercase().rfind("</details>")
            {
                inner.truncate(close);
            }
            let low = inner.to_ascii_lowercase();
            let mut summary = "Details".to_owned();
            if let Some(start) = low.find("<summary").filter(|s| low[*s..].contains('>'))
                && let Some(end) = low[start..].find("</summary>")
            {
                let open_end = start + low[start..].find('>').unwrap() + 1;
                if open_end <= start + end {
                    let words = inner[open_end..start + end].split_whitespace().collect::<Vec<_>>().join(" ");
                    if !words.is_empty() {
                        summary = words;
                    }
                    inner.replace_range(start..start + end + "</summary>".len(), "");
                }
            }
            blocks.push(Block::Details { summary, blocks: parse_blocks(&inner, depth + 1) });
            i += 1;
            continue;
        }
        if line.contains('|')
            && let Some(next) = lines.get(i + 1)
            && let Some(columns) = delimiter_row(next)
        {
            let head = split_row(&line);
            if head.len() == columns {
                flush(&mut paragraph, &mut blocks);
                let mut rows = Vec::new();
                let mut j = i + 2;
                while j < lines.len() && !lines[j].trim().is_empty() && lines[j].contains('|') {
                    let cells = split_row(&lines[j]);
                    rows.push((0..columns).map(|c| cells.get(c).cloned().unwrap_or_default()).collect());
                    j += 1;
                }
                blocks.push(Block::Table { head, rows });
                i = j;
                continue;
            }
        }
        if let Some((level, text)) = heading_of(&line) {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Heading(level, text.to_owned()));
        } else if rule(&line) {
            flush(&mut paragraph, &mut blocks);
            blocks.push(Block::Rule);
        } else if let Some((columns, ordered, rest)) = list_item(&line) {
            flush(&mut paragraph, &mut blocks);
            let (checked, text) = match rest.get(..3).map(|t| t.to_owned()) {
                Some(t) if matches!(t.as_str(), "[ ]" | "[x]" | "[X]") && rest[3..].starts_with(char::is_whitespace) => (Some(t != "[ ]"), rest[3..].trim_start()),
                _ => (None, rest),
            };
            let item = Item { text: text.to_owned(), depth: (columns / 2).min(3), checked };
            match blocks.last_mut() {
                Some(Block::List { ordered: o, items }) if *o == ordered => items.push(item),
                _ => blocks.push(Block::List { ordered, items: vec![item] }),
            }
        } else if let Some(quote) = line.trim_start().strip_prefix('>') {
            flush(&mut paragraph, &mut blocks);
            let text = quote.strip_prefix(' ').unwrap_or(quote).to_owned();
            match blocks.last_mut() {
                Some(Block::Quote(last)) => {
                    last.push(' ');
                    last.push_str(&text);
                }
                _ => blocks.push(Block::Quote(text)),
            }
        } else {
            paragraph.push(line.trim().to_owned());
        }
        i += 1;
    }
    flush(&mut paragraph, &mut blocks);
    blocks
}

#[derive(Debug, PartialEq)]
pub enum Span {
    Text(String),
    Code(String),
    Strong(String),
    Em(String),
    Del(String),
    Link { text: String, href: String },
}

/// Only https links are ever opened.
fn safe_href(href: &str) -> bool {
    href.starts_with("https://") && href.len() > 8 && !href.chars().any(|c| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '`'))
}

/// `[text](target)` at the start of `s` with `open` as its first character: the text, the target and the bytes used.
fn bracketed(s: &str, max_text: usize) -> Option<(&str, &str, usize)> {
    let inner = s.strip_prefix('[')?;
    let close = inner.find(|c| matches!(c, ']' | '[' | '\n'))?;
    if !inner[close..].starts_with("](") || close > max_text {
        return None;
    }
    let rest = &inner[close + 2..];
    let end = rest.find(|c: char| c == ')' || c.is_whitespace())?;
    (rest[end..].starts_with(')') && end <= 2000).then(|| (&inner[..close], &rest[..end], 1 + close + 2 + end + 1))
}

/// Text between `mark`s at the start of `s`: the inside and the bytes used.
fn between<'a>(s: &'a str, mark: &str, stop: &[char]) -> Option<(&'a str, usize)> {
    let inner = s.strip_prefix(mark)?;
    let end = inner.find(|c| stop.contains(&c) || c == '\n')?;
    (end > 0 && inner[end..].starts_with(mark)).then(|| (&inner[..end], mark.len() * 2 + end))
}

pub fn parse_inline(src: &str) -> Vec<Span> {
    let mut out: Vec<Span> = Vec::new();
    let mut plain = String::new();
    let mut at = 0;
    let push_text = |out: &mut Vec<Span>, plain: &mut String| {
        if !plain.is_empty() {
            out.push(Span::Text(std::mem::take(plain)));
        }
    };
    while at < src.len() {
        let s = &src[at..];
        let mut used = 0;
        let mut span = None;
        // `[![alt](src)](href)`: a link whose text is the alt.
        if s.starts_with("[!")
            && let Some((alt, _, n)) = bracketed(&s[2..], 200)
            && let Some(rest) = s[2 + n..].strip_prefix("](")
            && let Some(end) = rest.find(')')
            && end >= 1
            && !rest[..end].contains(char::is_whitespace)
        {
            let href = &rest[..end];
            used = 2 + n + 2 + end + 1;
            span = Some(if safe_href(href) { Span::Link { text: if alt.is_empty() { href.to_owned() } else { alt.to_owned() }, href: href.to_owned() } } else { Span::Text(alt.to_owned()) });
        }
        if span.is_none()
            && let Some(rest) = s.strip_prefix('!')
            && let Some((alt, _, n)) = bracketed(rest, 200)
        {
            used = 1 + n;
            span = Some(Span::Text(alt.to_owned()));
        }
        if span.is_none()
            && let Some((label, href, n)) = bracketed(s, 200)
            && !label.is_empty()
            && !href.is_empty()
        {
            used = n;
            span = Some(if safe_href(href) { Span::Link { text: label.to_owned(), href: href.to_owned() } } else { Span::Text(label.to_owned()) });
        }
        if span.is_none()
            && let Some((code, n)) = between(s, "`", &['`'])
        {
            used = n;
            span = Some(Span::Code(code.to_owned()));
        }
        if span.is_none()
            && let Some((inner, n)) = between(s, "**", &['*'])
        {
            used = n;
            span = Some(Span::Strong(inner.to_owned()));
        }
        if span.is_none()
            && let Some((inner, n)) = between(s, "~~", &['~'])
        {
            used = n;
            span = Some(Span::Del(inner.to_owned()));
        }
        if span.is_none()
            && let Some(inner) = s.strip_prefix('*')
            && !inner.starts_with(char::is_whitespace)
            && let Some(end) = inner.find(['*', '\n'])
            && end > 0
            && inner[end..].starts_with('*')
        {
            used = end + 2;
            span = Some(Span::Em(inner[..end].to_owned()));
        }
        if span.is_none() && s.starts_with("https://") {
            let end = s.find(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '`' | ')' | ']')).unwrap_or(s.len());
            let url = s[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
            if url.len() > 8 {
                used = url.len();
                span = Some(if safe_href(url) { Span::Link { text: url.to_owned(), href: url.to_owned() } } else { Span::Text(url.to_owned()) });
            }
        }
        match span {
            Some(span) => {
                push_text(&mut out, &mut plain);
                out.push(span);
                at += used;
            }
            None => {
                let c = s.chars().next().unwrap();
                plain.push(c);
                at += c.len_utf8();
            }
        }
    }
    push_text(&mut out, &mut plain);
    out
}

fn open_link(href: String) -> impl Fn(&serde_json::Value) {
    move |_| drop(host::call("openUrl", json!({ "url": href })))
}

fn spans(source: &str) -> Node {
    let mut line = Node::new("Text").prop("grow", true);
    for span in parse_inline(source) {
        line = match span {
            Span::Text(t) | Span::Em(t) => line.text(t),
            Span::Code(t) => line.child(Node::new("Text").prop("mono", true).text(t)),
            Span::Strong(t) => line.child(Node::new("Text").prop("weight", "strong").text(t)),
            Span::Del(t) => line.child(Node::new("Text").prop("tone", "muted").text(t)),
            Span::Link { text, href } => line.child(Node::new("Text").on("onClick", open_link(href)).text(text)),
        };
    }
    line
}

/// Lines of code in a card, one monospace row each.
pub fn code_block(code: &str) -> Node {
    let rows = code.split('\n').map(|line| row().prop("gap", "m").prop("align", "baseline").child(text(if line.is_empty() { " " } else { line }).prop("mono", true).prop("size", "small").prop("grow", true)));
    card().child(stack().prop("gap", "none").children(rows))
}

fn node_of(block: &Block) -> Node {
    match block {
        Block::Heading(level, t) => Node::new("Text").prop("weight", "strong").prop("size", if *level <= 2 { "field" } else { "small" }).child(spans(t)),
        Block::Paragraph(t) => spans(t),
        Block::List { ordered, items } => stack().prop("gap", "xs").children(items.iter().enumerate().map(|(j, item)| {
            let mark = match item.checked {
                None if *ordered => format!("{}.", j + 1),
                None => "\u{2022}".to_owned(),
                Some(true) => "\u{2611}".to_owned(),
                Some(false) => "\u{2610}".to_owned(),
            };
            row()
                .prop("gap", "s")
                .prop("align", "start")
                .child(stack().prop("width", item.depth * 16))
                .child(text(mark).prop("tone", "muted"))
                .child(spans(&item.text))
        })),
        Block::Code { text: code, .. } => code_block(code),
        Block::Quote(t) => row().prop("gap", "s").prop("align", "start").child(text("\u{258e}").prop("tone", "muted")).child(spans(t).prop("tone", "muted")),
        Block::Rule => text("────────────────").prop("tone", "muted"),
        Block::Table { head, rows } => stack()
            .prop("gap", "xs")
            .child(row().prop("gap", "m").children(head.iter().map(|c| spans(c).prop("weight", "strong"))))
            .children(rows.iter().map(|r| row().prop("gap", "m").prop("align", "start").children(r.iter().map(|c| spans(c))))),
        Block::Details { summary, blocks } => {
            let body = stack().prop("gap", "m").children(blocks.iter().map(node_of));
            Node::new("Disclosure").child(Node::new("Slot").prop("name", "summary").child(spans(summary))).child(Node::new("Slot").prop("name", "body").child(body))
        }
    }
}

/// `source` as a column of blocks.
pub fn markdown(source: &str) -> Node {
    stack().prop("gap", "m").children(parse_blocks(source, 0).iter().map(node_of))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A description is someone else's text. A fold was looked for in a lowercased copy and cut in the original, and
    /// lowercasing can change a letter's length ("İ" grows by a byte), so text like this stopped the page.
    #[test]
    fn a_fold_after_letters_that_change_length_in_lowercase_is_read_without_a_panic() {
        assert_eq!(
            parse_blocks("İİİé <details><summary>İİ More</summary>\nBody é\n</details>", 0),
            [Block::Paragraph("İİİé".into()), Block::Details { summary: "İİ More".into(), blocks: vec![Block::Paragraph("Body é".into())] }]
        );
    }

    #[test]
    fn blocks_are_read_as_the_desktop_parser_reads_them() {
        let blocks = parse_blocks("# Title\n\nSome **bold** text\nsecond line\n\n- one\n- [x] two\n\n```rs\nlet a = 1;\n```\n<!-- hidden -->\n> quoted\n[KEY]: tracking\n", 0);
        assert_eq!(blocks[0], Block::Heading(1, "Title".into()));
        assert_eq!(blocks[1], Block::Paragraph("Some **bold** text second line".into()));
        assert!(matches!(&blocks[2], Block::List { ordered: false, items } if items.len() == 2 && items[1].checked == Some(true)));
        assert_eq!(blocks[3], Block::Code { lang: "rs".into(), text: "let a = 1;".into() });
        assert_eq!(blocks[4], Block::Quote("quoted".into()));
        assert_eq!(blocks.len(), 5);
    }

    #[test]
    fn a_table_and_a_fold_are_blocks_of_their_own() {
        let blocks = parse_blocks("| a | b |\n| - | - |\n| 1 | 2 |\n\n<details>\n<summary>More</summary>\n\nInside\n</details>", 0);
        assert_eq!(blocks[0], Block::Table { head: vec!["a".into(), "b".into()], rows: vec![vec!["1".into(), "2".into()]] });
        assert!(matches!(&blocks[1], Block::Details { summary, blocks } if summary == "More" && blocks == &[Block::Paragraph("Inside".into())]));
    }

    #[test]
    fn only_https_links_are_links_and_images_are_their_alt_text() {
        assert_eq!(
            parse_inline("see [docs](https://a.example/x) and [bad](javascript:alert) ![pic](https://a.example/p.png) `code` https://b.example/y."),
            [
                Span::Text("see ".into()),
                Span::Link { text: "docs".into(), href: "https://a.example/x".into() },
                Span::Text(" and ".into()),
                Span::Text("bad".into()),
                Span::Text(" ".into()),
                Span::Text("pic".into()),
                Span::Text(" ".into()),
                Span::Code("code".into()),
                Span::Text(" ".into()),
                Span::Link { text: "https://b.example/y".into(), href: "https://b.example/y".into() },
                Span::Text(".".into()),
            ]
        );
    }
}
