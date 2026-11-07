// The HTML Azure DevOps keeps for a description or a comment, read without a DOM for the native app: a short tokenizer
// reads the tags, and about the same short list of tags as ui/richText.tsx becomes lines of text with their looks.
// The Work item plugin in the Wings repo reads it the same way (plugins/work-item/src/lib/html.ts).
// Attributes aren't kept, except a link's `href` to an Azure DevOps address.

/** Tags dropped with everything inside them. */
const DROP = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "noscript", "form", "button", "select", "textarea", "head", "title"]);
/** Tags that start a new line of their own. */
const BLOCK = new Set(["p", "div", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "thead", "tbody", "section"]);
const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "wbr", "col"]);
/** What `permissions.openUrl` allows, so a link to anywhere else stays text. */
const OPENABLE = "https://dev.azure.com/";
const MAX_DEPTH = 40;

interface El {
  tag: string;
  attrs: string;
  children: (El | string)[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? all;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });

/** The tags of `html` as a tree. A close tag with no open one is ignored, and one closes every tag opened inside it. */
export function parseHtml(html: string): El {
  const root: El = { tag: "#root", attrs: "", children: [] };
  const open = [root];
  for (const [token, close, name, attrs] of html.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)([^>]*)>|[^<]+|</g)) {
    if (token.startsWith("<!--")) continue;
    if (!name) {
      open[open.length - 1].children.push(decode(token));
      continue;
    }
    const tag = name.toLowerCase();
    if (close) {
      const at = open.findLastIndex((el) => el.tag === tag);
      if (at > 0) open.length = at;
      continue;
    }
    const el: El = { tag, attrs, children: [] };
    open[open.length - 1].children.push(el);
    if (!VOID.has(tag) && !attrs.trimEnd().endsWith("/") && open.length < MAX_DEPTH) open.push(el);
  }
  return root;
}

export type Look = { strong?: boolean; mono?: boolean; muted?: boolean; href?: string };
export type Span = Look & { text: string };
export type Block = { kind: "text" | "heading" | "item" | "code"; spans: Span[]; depth: number; marker?: string };

function hrefOf(attrs: string): string | undefined {
  const raw = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  try {
    const url = new URL(decode(raw?.[1] ?? raw?.[2] ?? raw?.[3] ?? ""));
    return url.protocol === "https:" && url.href.startsWith(OPENABLE) ? url.href : undefined;
  } catch {
    // Not a URL: a mention's "#", or a relative link.
    return undefined;
  }
}

/** The lines of `root`, each with the looks of its parts. */
export function blocksOf(root: El): Block[] {
  const blocks: Block[] = [];
  let line: Block = { kind: "text", spans: [], depth: 0 };
  const end = (next: Block = { kind: "text", spans: [], depth: line.depth }) => {
    if (line.spans.some((s) => s.text.trim()) || line.kind === "code") blocks.push(line);
    line = next;
  };
  const walk = (node: El | string, look: Look, depth: number, pre: boolean) => {
    if (typeof node === "string") {
      const text = pre ? node : node.replace(/\s+/g, " ");
      if (text) line.spans.push({ ...look, text });
      return;
    }
    const { tag } = node;
    if (DROP.has(tag)) return;
    if (tag === "br") return pre ? line.spans.push({ ...look, text: "\n" }) : end();
    if (tag === "img") {
      const alt = /\balt\s*=\s*"([^"]*)"/i.exec(node.attrs)?.[1];
      return void line.spans.push({ muted: true, text: `[image${alt ? `: ${decode(alt)}` : ""}]` });
    }
    if (tag === "pre") {
      end({ kind: "code", spans: [], depth });
      node.children.forEach((child) => walk(child, look, depth, true));
      return end();
    }
    if (tag === "ul" || tag === "ol") {
      end();
      let n = 0;
      for (const child of node.children) {
        if (typeof child !== "string" && child.tag === "li") {
          n += 1;
          end({ kind: "item", spans: [], depth: depth + 1, marker: tag === "ol" ? `${n}.` : "•" });
          child.children.forEach((part) => walk(part, look, depth + 1, pre));
          end({ kind: "text", spans: [], depth });
        } else walk(child, look, depth, pre);
      }
      return end({ kind: "text", spans: [], depth });
    }
    const next: Look = { ...look };
    if (["b", "strong", "th"].includes(tag)) next.strong = true;
    if (tag === "code") next.mono = true;
    if (["s", "strike", "del"].includes(tag)) next.muted = true;
    if (tag === "a") next.href = hrefOf(node.attrs);
    const heading = /^h[1-6]$/.test(tag);
    if (BLOCK.has(tag) || tag === "li") end(heading ? { kind: "heading", spans: [], depth } : undefined);
    if ((tag === "td" || tag === "th") && line.spans.length) line.spans.push({ text: " · " });
    node.children.forEach((child) => walk(child, next, depth, pre));
    if (BLOCK.has(tag) || tag === "li") end();
  };
  root.children.forEach((child) => walk(child, {}, 0, false));
  end();
  return blocks;
}
