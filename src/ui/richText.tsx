import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";

/** The text a node shows, like an element's textContent. */
export function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** Whether a node holds a line break or a muted note, like `querySelector("br, .muted")`. */
function hasMark(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(hasMark);
  if (!isValidElement<{ children?: ReactNode; className?: string }>(node)) return false;
  return node.type === "br" || String(node.props.className ?? "").split(" ").includes("muted") || hasMark(node.props.children);
}

/**
 * Azure DevOps rich text as safe page nodes. The HTML is parsed into an inert document, which runs no scripts and
 * loads nothing, and only its text and a few structural tags are copied out: never the parsed nodes themselves.
 */
export function richText(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let key = 0;
  const walk = (from: Node): ReactNode[] => {
    const to: ReactNode[] = [];
    for (const node of from.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.push(node.textContent ?? "");
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "template", "iframe", "object", "noscript"].includes(tag)) continue;
      if (tag === "br") to.push(<br key={key++} />);
      else if (tag === "img") to.push(<span key={key++} className="muted">[image]</span>);
      else if (tag === "a") {
        const href = el.getAttribute("href") ?? "";
        const text = (el.textContent ?? "").trim() || href;
        if (/^https:\/\/dev\.azure\.com\//.test(href)) to.push(<button key={key++} className="inline-link" type="button" title={href} onClick={() => void wings.openUrl(href)}>{text}</button>);
        else to.push(text, href && href !== text && /^https?:/.test(href) ? <span key={key++} className="muted">{` (${href})`}</span> : "");
      } else {
        const map: Record<string, string> = { p: "p", div: "p", ul: "ul", ol: "ol", li: "li", strong: "strong", b: "strong", em: "em", i: "em", code: "code", pre: "pre", h1: "p", h2: "p", h3: "p", h4: "p", h5: "p", h6: "p", tr: "p", blockquote: "blockquote" };
        if (map[tag]) {
          const children = walk(el);
          const target = createElement(map[tag], { key: key++, ...(/^h\d$/.test(tag) ? { className: "heading" } : {}) }, ...children);
          if (textOf(children).trim() || hasMark(children)) to.push(target);
        } else {
          to.push(...walk(el));
          if (tag === "td" || tag === "th") to.push(" ");
        }
      }
    }
    return to;
  };
  return <div className="rich">{walk(doc.body)}</div>;
}

/** A link as richText draws one: Azure DevOps links open, other web links show their address. */
const linkNode = (text: string, href: string, key: number) =>
  /^https:\/\/dev\.azure\.com\//.test(href)
    ? <button key={key} className="inline-link" type="button" title={href} onClick={() => void wings.openUrl(href)}>{text}</button>
    : <span key={key}>{text}{/^https?:/.test(href) && href !== text ? <span className="muted">{` (${href})`}</span> : ""}</span>;

const mdInline = /!\[([^\]]*)\]\([^)\s]*\)|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;

/** Inline code, bold, italics and links as nodes. An image shows as [image], like in rich text. */
function markdownInline(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of src.matchAll(mdInline)) {
    if (m.index > at) out.push(src.slice(at, m.index));
    at = m.index + m[0].length;
    const key = out.length;
    if (m[0].startsWith("!")) out.push(<span key={key} className="muted">[image]</span>);
    else if (m[2] !== undefined) out.push(linkNode(m[2], m[3], key));
    else if (m[4] !== undefined) out.push(<code key={key}>{m[4]}</code>);
    else if (m[5] !== undefined) out.push(<strong key={key}>{markdownInline(m[5])}</strong>);
    else out.push(<em key={key}>{m[6]}</em>);
  }
  if (at < src.length) out.push(src.slice(at));
  return out;
}

/**
 * Azure DevOps markdown fields as page nodes: headings, paragraphs, lists, fenced code, quotes and rules, built as
 * new elements from the text. Raw HTML in it shows as text, never as markup.
 */
export function markdownText(src: string) {
  const out: (ReactElement | { tag: "ul" | "ol"; items: ReactElement[] })[] = [];
  // Azure DevOps keeps <, >, " and & in markdown fields as HTML entities. Decoded to text, they stay text.
  const named: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", nbsp: " " };
  const text = src.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1].toLowerCase() === "x" ? 2 : 1), e[1].toLowerCase() === "x" ? 16 : 10) || 0xfffd) : (named[e.toLowerCase()] ?? m),
  );
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: ReactElement[] } | null = null;
  const flush = () => {
    if (para.length) out.push(<p key={out.length}>{markdownInline(para.join(" "))}</p>);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line);
    if (!item && line.trim()) list = null;
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      const code = [];
      while (++i < lines.length && !/^\s*(```|~~~)/.test(lines[i])) code.push(lines[i]);
      out.push(<pre key={out.length}><code>{code.join("\n")}</code></pre>);
    } else if (!line.trim()) flush();
    else if (/^#{1,6}\s/.test(line)) {
      flush();
      out.push(<p key={out.length} className="heading">{markdownInline(line.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, ""))}</p>);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push(<hr key={out.length} />);
    } else if (item) {
      flush();
      const tag = item[1] ? "ul" : "ol";
      if (!list || list.tag !== tag) out.push((list = { tag, items: [] }));
      list.items.push(<li key={list.items.length}>{markdownInline(item[2])}</li>);
    } else if (line.startsWith(">")) {
      flush();
      out.push(<blockquote key={out.length}>{markdownInline(line.replace(/^>\s?/, ""))}</blockquote>);
    } else para.push(line.trim());
  }
  flush();
  return <div className="rich">{out.map((x, n) => ("tag" in x ? createElement(x.tag, { key: n }, x.items) : x))}</div>;
}
