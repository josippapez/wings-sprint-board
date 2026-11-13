//! The HTML Azure DevOps keeps for a description or a comment, read without a DOM: a short tokenizer reads the tags, and
//! a short list of tags becomes lines of text with their looks. Attributes aren't kept, except a link's `href` to an
//! Azure DevOps address.

/// Tags dropped with everything inside them.
const DROP: [&str; 15] = ["script", "style", "iframe", "object", "embed", "svg", "math", "template", "noscript", "form", "button", "select", "textarea", "head", "title"];
/// Tags that start a new line of their own.
const BLOCK: [&str; 14] = ["p", "div", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "thead", "tbody", "section"];
const VOID: [&str; 8] = ["br", "img", "hr", "input", "meta", "link", "wbr", "col"];
/// What `permissions.openUrl` allows, so a link to anywhere else stays text.
const OPENABLE: &str = "https://dev.azure.com/";
const MAX_DEPTH: usize = 40;

struct El {
    tag: String,
    attrs: String,
    children: Vec<Node>,
}

enum Node {
    El(El),
    Text(String),
}

pub fn decode(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let entity = rest.find(';').map(|end| &rest[1..end]).filter(|name| !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'#'));
        let decoded = entity.and_then(|name| match name.strip_prefix('#') {
            None => match name.to_lowercase().as_str() {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => None,
            },
            Some(number) => {
                let code = match number.strip_prefix(['x', 'X']) {
                    Some(hex) if !hex.is_empty() => u32::from_str_radix(hex, 16).ok(),
                    Some(_) => None,
                    None => number.parse().ok(),
                };
                code.filter(|code| *code > 0).and_then(char::from_u32)
            }
        });
        match (decoded, entity) {
            (Some(c), Some(name)) => {
                out.push(c);
                rest = &rest[name.len() + 2..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

enum Token<'a> {
    Text(&'a str),
    Open { name: &'a str, attrs: &'a str },
    Close(&'a str),
}

/// The tags and text of `html`: a comment is skipped, and a `<` that starts no tag is text.
fn tokens(html: &str) -> Vec<Token<'_>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < html.len() {
        let rest = &html[at..];
        if !rest.starts_with('<') {
            let end = rest.find('<').unwrap_or(rest.len());
            out.push(Token::Text(&rest[..end]));
            at += end;
        } else if rest.starts_with("<!--") && let Some(end) = rest[4..].find("-->") {
            at += 4 + end + 3;
        } else if let Some((token, len)) = tag(rest) {
            out.push(token);
            at += len;
        } else {
            out.push(Token::Text("<"));
            at += 1;
        }
    }
    out
}

/// A tag at the start of `rest`, `<name attrs>` or `</name attrs>`, and its length.
fn tag(rest: &str) -> Option<(Token<'_>, usize)> {
    let end = rest.find('>')?;
    let inner = &rest[1..end];
    let (closing, inner) = match inner.strip_prefix('/') {
        Some(inner) => (true, inner),
        None => (false, inner),
    };
    if !inner.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    let name_len = inner.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(inner.len());
    let (name, attrs) = inner.split_at(name_len);
    Some((if closing { Token::Close(name) } else { Token::Open { name, attrs } }, end + 1))
}

/// The tags of `html` as a tree. A close tag with no open one is ignored, and one closes every tag opened inside it.
fn parse(html: &str) -> Vec<Node> {
    let mut open = vec![El { tag: "#root".into(), attrs: String::new(), children: Vec::new() }];
    // Closes the element on top of the stack into the one under it.
    fn close_top(open: &mut Vec<El>) {
        let el = open.pop().expect("an open element");
        open.last_mut().expect("the root").children.push(Node::El(el));
    }
    for token in tokens(html) {
        match token {
            Token::Text(text) => open.last_mut().unwrap().children.push(Node::Text(decode(text))),
            Token::Close(name) => {
                let name = name.to_lowercase();
                if let Some(at) = open.iter().rposition(|el| el.tag == name).filter(|at| *at > 0) {
                    while open.len() > at {
                        close_top(&mut open);
                    }
                }
            }
            Token::Open { name, attrs } => {
                let el = El { tag: name.to_lowercase(), attrs: attrs.to_owned(), children: Vec::new() };
                if !VOID.contains(&el.tag.as_str()) && !attrs.trim_end().ends_with('/') && open.len() < MAX_DEPTH {
                    open.push(el);
                } else {
                    open.last_mut().unwrap().children.push(Node::El(el));
                }
            }
        }
    }
    while open.len() > 1 {
        close_top(&mut open);
    }
    open.pop().unwrap().children
}

#[derive(Clone, Default, PartialEq, Debug)]
pub struct Look {
    pub strong: bool,
    pub mono: bool,
    pub muted: bool,
    pub href: Option<String>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Span {
    pub look: Look,
    pub text: String,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Text,
    Heading,
    Item,
    Code,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Block {
    pub kind: Kind,
    pub spans: Vec<Span>,
    pub depth: usize,
    pub marker: Option<String>,
}

impl Block {
    pub fn text(&self) -> String {
        self.spans.iter().map(|span| span.text.as_str()).collect()
    }
}

fn href_of(attrs: &str) -> Option<String> {
    // ASCII only: `to_lowercase` can change a letter's length, and `at` is used on `attrs` itself.
    let at = attrs.to_ascii_lowercase().find("href")?;
    let rest = attrs[at + 4..].trim_start().strip_prefix('=')?.trim_start();
    let raw = match rest.chars().next()? {
        quote @ ('"' | '\'') => rest[1..].split(quote).next()?,
        _ => rest.split(|c: char| c.is_whitespace() || c == '>').next()?,
    };
    let url = decode(raw);
    let url = url.trim();
    let path = url.get(OPENABLE.len()..).filter(|path| !path.is_empty())?;
    url.get(..OPENABLE.len())?.eq_ignore_ascii_case(OPENABLE).then(|| format!("{OPENABLE}{path}"))
}

fn alt_of(attrs: &str) -> Option<String> {
    let at = attrs.to_ascii_lowercase().find("alt")?;
    let rest = attrs[at + 3..].trim_start().strip_prefix('=')?.trim_start().strip_prefix('"')?;
    Some(decode(rest.split('"').next()?))
}

struct Walker {
    blocks: Vec<Block>,
    line: Block,
}

impl Walker {
    fn new_line(kind: Kind, depth: usize, marker: Option<String>) -> Block {
        Block { kind, spans: Vec::new(), depth, marker }
    }

    /// Ends the line, keeping it when it says something, and starts `next`, a text line of the same depth by default.
    fn end(&mut self, next: Option<Block>) {
        let next = next.unwrap_or_else(|| Self::new_line(Kind::Text, self.line.depth, None));
        let line = std::mem::replace(&mut self.line, next);
        if line.spans.iter().any(|span| !span.text.trim().is_empty()) || line.kind == Kind::Code {
            self.blocks.push(line);
        }
    }

    fn push(&mut self, look: &Look, text: String) {
        self.line.spans.push(Span { look: look.clone(), text });
    }

    fn walk(&mut self, node: &Node, look: &Look, depth: usize, pre: bool) {
        let el = match node {
            Node::Text(text) => {
                let text = if pre { text.clone() } else { collapse(text) };
                if !text.is_empty() {
                    self.push(look, text);
                }
                return;
            }
            Node::El(el) => el,
        };
        let tag = el.tag.as_str();
        if DROP.contains(&tag) {
            return;
        }
        if tag == "br" {
            return if pre { self.push(look, "\n".into()) } else { self.end(None) };
        }
        if tag == "img" {
            let alt = alt_of(&el.attrs).map(|alt| format!(": {alt}")).unwrap_or_default();
            return self.line.spans.push(Span { look: Look { muted: true, ..Look::default() }, text: format!("[image{alt}]") });
        }
        if tag == "pre" {
            self.end(Some(Self::new_line(Kind::Code, depth, None)));
            el.children.iter().for_each(|child| self.walk(child, look, depth, true));
            return self.end(None);
        }
        if tag == "ul" || tag == "ol" {
            self.end(None);
            let mut n = 0;
            for child in &el.children {
                match child {
                    Node::El(item) if item.tag == "li" => {
                        n += 1;
                        let marker = if tag == "ol" { format!("{n}.") } else { "•".to_owned() };
                        self.end(Some(Self::new_line(Kind::Item, depth + 1, Some(marker))));
                        item.children.iter().for_each(|part| self.walk(part, look, depth + 1, pre));
                        self.end(Some(Self::new_line(Kind::Text, depth, None)));
                    }
                    other => self.walk(other, look, depth, pre),
                }
            }
            return self.end(Some(Self::new_line(Kind::Text, depth, None)));
        }
        let mut next = look.clone();
        if ["b", "strong", "th"].contains(&tag) {
            next.strong = true;
        }
        if tag == "code" {
            next.mono = true;
        }
        if ["s", "strike", "del"].contains(&tag) {
            next.muted = true;
        }
        if tag == "a" {
            next.href = href_of(&el.attrs);
        }
        let heading = matches!(tag, "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
        let block = BLOCK.contains(&tag) || tag == "li";
        if block {
            self.end(heading.then(|| Self::new_line(Kind::Heading, depth, None)));
        }
        if (tag == "td" || tag == "th") && !self.line.spans.is_empty() {
            self.push(&Look::default(), " · ".into());
        }
        el.children.iter().for_each(|child| self.walk(child, &next, depth, pre));
        if block {
            self.end(None);
        }
    }
}

/// Runs of whitespace as one space.
fn collapse(text: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if std::mem::take(&mut space) {
            out.push(' ');
        }
        out.push(c);
    }
    if space {
        out.push(' ');
    }
    out
}

/// The lines of `html`, each with the looks of its parts.
pub fn blocks_of(html: &str) -> Vec<Block> {
    let mut walker = Walker { blocks: Vec::new(), line: Walker::new_line(Kind::Text, 0, None) };
    for node in parse(html) {
        walker.walk(&node, &Look::default(), 0, false);
    }
    walker.end(None);
    walker.blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(html: &str) -> Vec<(Kind, usize, Option<String>, String)> {
        blocks_of(html).iter().map(|b| (b.kind, b.depth, b.marker.clone(), b.text())).collect()
    }

    /// A description is someone else's text. Lowercasing with `to_lowercase` moved the byte offsets ("İ" grows by a
    /// byte), and a link was cut at a fixed byte, so text like this stopped the page.
    #[test]
    fn attributes_with_letters_that_change_length_in_lowercase_or_end_mid_letter_are_read_without_a_panic() {
        assert_eq!(href_of("title=\"İİİİé\" href=\"https://dev.azure.com/acme\""), Some("https://dev.azure.com/acme".to_owned()));
        assert_eq!(href_of("href=\"https://dev.azure.comé\""), None);
        assert_eq!(alt_of("title=\"İİİé\" alt=\"Chart\""), Some("Chart".to_owned()));
    }

    #[test]
    fn paragraphs_nested_lists_and_code_become_lines_and_entities_are_decoded() {
        assert_eq!(
            lines("<p>Fails on <code>503</code> &amp; retries</p><ol><li>Start<ul><li>Stop the API</li></ul></li></ol><pre><code>a\n  b</code></pre>"),
            [
                (Kind::Text, 0, None, "Fails on 503 & retries".to_owned()),
                (Kind::Item, 1, Some("1.".into()), "Start".into()),
                (Kind::Item, 2, Some("•".into()), "Stop the API".into()),
                (Kind::Code, 0, None, "a\n  b".into()),
            ]
        );
    }

    #[test]
    fn scripts_and_styles_are_dropped_and_only_an_azure_devops_link_is_kept_as_one() {
        let blocks = blocks_of("<script>alert(1)</script><p><a href=\"https://dev.azure.com/acme/x\">here</a> <a href=\"https://example.com\">there</a></p>");
        let spans: Vec<(String, Option<String>)> = blocks.iter().flat_map(|b| b.spans.iter()).map(|s| (s.text.clone(), s.look.href.clone())).collect();
        assert_eq!(spans, [("here".to_owned(), Some("https://dev.azure.com/acme/x".to_owned())), (" ".into(), None), ("there".into(), None)]);
    }

    #[test]
    fn looks_headings_breaks_images_tables_and_odd_markup() {
        let blocks = blocks_of("<h2>Plan</h2>Line one<br>Line two <b>bold</b> <s>old</s><img src=x alt=\"a\" alt=\"b\"><table><tr><td>a</td><td>b</td></tr></table>&#65;&#x42;&bogus; 1 < 2 <!-- gone --> <unclosed");
        assert_eq!(blocks[0].kind, Kind::Heading);
        assert_eq!(blocks[0].text(), "Plan");
        assert_eq!(blocks[1].text(), "Line one");
        assert!(blocks[2].spans.iter().any(|s| s.look.strong && s.text == "bold"));
        assert!(blocks[2].spans.iter().any(|s| s.look.muted && s.text == "old"));
        assert!(blocks.iter().any(|b| b.text().contains("a · b")));
        assert!(blocks.iter().any(|b| b.text().contains("AB&bogus; 1 < 2")), "{:?}", blocks.iter().map(Block::text).collect::<Vec<_>>());
    }

    #[test]
    fn a_close_tag_with_no_open_one_is_ignored_and_one_closes_what_was_opened_inside_it() {
        assert_eq!(lines("</b><div>a<span>b</div>c")[0].3, "ab");
        assert_eq!(lines("</b><div>a<span>b</div>c")[1].3, "c");
    }
}
