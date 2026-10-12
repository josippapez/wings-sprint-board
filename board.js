// @ts-check
/// <reference path="./wings.d.ts" />

// The board view of the sidebar: the sprint's items grouped by state with their children nested, filters, and an
// item's details and comments. The list comes from the snapshot main.js keeps in storage after each board check,
// so it costs no az calls. An item's details, comments and pull requests are read when it's opened, and kept
// until the board shows a newer revision of it. Text from Azure DevOps goes into the page only as text nodes.

/**
 * @typedef {{ id: number, rev: number, title: string, type: string, state: string, category: string, assignee: string | null,
 *   login: string | null, parent: number | null, tags: string[], blocked: boolean, blockedBy: string | null, comments: number,
 *   prs: { id: number, status: string }[] | null, checks: string[] }} BoardItem
 * @typedef {{ checkedAt: string, sprint: { name: string, start: string | null, finish: string | null }, items: BoardItem[],
 *   types: Record<string, { color: string, states: { name: string, category: string, color: string }[] }> }} Snapshot
 */

/** @type {Snapshot | null} */
let snapshot = null;
/** Filters, tab and which groups are flipped from their default, kept in storage. */
let view = { tab: "board", who: "all", type: "", q: "", toggled: /** @type {string[]} */ ([]) };
/** Items opened, the last one on screen. @type {number[]} */
let opened = [];
let listScroll = 0;
/** The signed-in az account, to filter "Mine". @type {string | null} */
let meLogin = null;

/** @typedef {{ rev: number, item?: any, comments?: any[], prs: Map<number, any>, error?: string, loading: boolean }} Detail */
/** @type {Map<number, Detail>} */
const details = new Map();

const CATEGORY_ORDER = ["Proposed", "InProgress", "Resolved", "Completed", "Removed"];

async function loadView() {
  try {
    const saved = await wings.storage.get("view");
    if (saved && typeof saved === "object") view = { ...view, ...saved };
  } catch {
    // The defaults do; storage only remembers filters.
  }
}

let saveTimer = 0;
function saveView() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void wings.storage.set("view", view).catch(() => {}), 400);
}

/** Reads the board main.js stored, and drops cached details whose item changed. */
async function loadSnapshot() {
  const next = /** @type {Snapshot | null} */ (await wings.storage.get("board"));
  if (!next || next.checkedAt === snapshot?.checkedAt) return;
  snapshot = next;
  const revs = new Map(next.items.map((i) => [i.id, i.rev]));
  for (const [id, d] of details) {
    if (revs.has(id) && revs.get(id) !== d.rev) {
      details.delete(id);
      if (opened.at(-1) === id) void openItem(id, false);
    }
  }
  render();
}

// ---------- small pieces ----------

const settingsOf = () => /** @type {Record<string, any>} */ (main?.settings ?? {});
const workItemUrl = (/** @type {number} */ id) => `${String(settingsOf().org ?? "").replace(/\/+$/, "")}/${encodeURIComponent(settingsOf().project ?? "")}/_workitems/edit/${id}`;
const byId = () => new Map((snapshot?.items ?? []).map((i) => [i.id, i]));
const typeColor = (/** @type {string} */ type) => snapshot?.types[type]?.color ?? "#888888";
const stateInfo = (/** @type {string} */ type, /** @type {string} */ state) => snapshot?.types[type]?.states.find((s) => s.name === state);

/** @param {string} color @param {string} [title] */
const dot = (color, title) => h("span", { class: "dot", style: `background:${/^#[0-9a-f]{6}$/i.test(color) ? color : "#888888"}`, title: title ?? null, "aria-hidden": title ? null : true });

/** Initials in a circle whose colour comes from the name. @param {string | null} name */
function avatar(name) {
  if (!name) return h("span", { class: "avatar empty", title: "Unassigned" }, "–");
  const initials = name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return h("span", { class: "avatar", style: `background:hsl(${Math.abs(hash) % 360} 45% 38%)`, title: name }, initials);
}

const SVG = "http://www.w3.org/2000/svg";
/** @param {string} d */
function icon(d) {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 12 12", fill: "none", stroke: "currentColor", "stroke-width": "1.2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
const CARET = "M4.5 3L7.5 6L4.5 9";

/** "5m ago", "3h ago", "2d ago", or the date. @param {string} iso */
function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  if (m < 60 * 24 * 7) return `${Math.round(m / 1440)}d ago`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

/** The most telling of an item's pull requests: an open one, else a completed one. @param {BoardItem} i */
function prChip(i) {
  if (!i.prs?.length) return null;
  const pr = i.prs.find((p) => p.status === "active") ?? i.prs.find((p) => p.status === "completed") ?? i.prs[0];
  return h("span", { class: `chip pr ${pr.status}`, title: i.prs.map((p) => `PR !${p.id} ${p.status}`).join("\n") }, "PR");
}

/** Whether a group or parent is open: groups of done work and parents start closed. @param {string} key @param {boolean} openByDefault */
const isOpen = (key, openByDefault) => openByDefault !== view.toggled.includes(key);
function toggle(/** @type {string} */ key) {
  view.toggled = view.toggled.includes(key) ? view.toggled.filter((k) => k !== key) : [...view.toggled, key];
  saveView();
  render();
}

// ---------- the list ----------

/** @param {BoardItem} i @param {{ child?: boolean, kids?: BoardItem[] }} [o] @returns {HTMLElement} */
function itemRow(i, o = {}) {
  const kids = o.kids ?? [];
  const open = kids.length > 0 && isOpen(`p:${i.id}`, false);
  const done = kids.filter((k) => k.category === "Completed").length;
  const row = h(
    "div",
    { class: `item-row${o.child ? " child" : ""}` },
    kids.length
      ? h("button", { class: `twisty${open ? " open" : ""}`, type: "button", "aria-expanded": String(open), "aria-label": `${open ? "Hide" : "Show"} ${kids.length} children`, title: `${done}/${kids.length} done`, onclick: () => toggle(`p:${i.id}`) }, icon(CARET))
      : h("span", { class: "twisty-space" }),
    h(
      "button",
      { class: "item-main", type: "button", title: `${i.type} ${i.id}: ${i.title}`, onclick: () => void openItem(i.id) },
      dot(typeColor(i.type), i.type),
      h("span", { class: "item-id" }, String(i.id)),
      h("span", { class: "item-title" }, i.title),
      o.child ? h("span", { class: "chip state", title: i.state }, i.state) : null,
      kids.length ? h("span", { class: "chip count", title: `${done} of ${kids.length} children done` }, `${done}/${kids.length}`) : null,
      i.blocked ? h("span", { class: "chip blocked", title: `Blocked by ${i.blockedBy ?? ""}` }, "Blocked") : null,
      prChip(i),
      i.checks.length ? h("span", { class: "chip check", title: i.checks.join("\n") }, "!") : null,
      i.comments ? h("span", { class: "chip talk", title: `${i.comments} comment${i.comments > 1 ? "s" : ""}` }, String(i.comments)) : null,
      avatar(i.assignee),
    ),
  );
  if (!open) return row;
  return h("div", { class: "family" }, row, ...kids.map((k) => itemRow(k, { child: true })));
}

/** States in workflow order: by category, then by their place in their type's workflow. @param {BoardItem[]} items */
function groupByState(items) {
  /** @type {Map<string, { rank: number, color: string, category: string, items: BoardItem[] }>} */
  const groups = new Map();
  for (const i of items) {
    const states = snapshot?.types[i.type]?.states ?? [];
    const at = states.findIndex((s) => s.name === i.state);
    const rank = Math.max(0, CATEGORY_ORDER.indexOf(i.category)) * 1000 + Math.max(0, at);
    const g = groups.get(i.state) ?? { rank, color: stateInfo(i.type, i.state)?.color ?? "#888888", category: i.category, items: [] };
    g.rank = Math.min(g.rank, rank);
    g.items.push(i);
    groups.set(i.state, g);
  }
  return [...groups.entries()].sort((a, b) => a[1].rank - b[1].rank);
}

function filterBar() {
  const items = snapshot?.items ?? [];
  const people = [...new Set(items.map((i) => i.assignee).filter((a) => !!a))].map(String).sort();
  const types = [...new Set(items.map((i) => i.type))].sort();
  const set = (/** @type {Partial<typeof view>} */ patch) => {
    Object.assign(view, patch);
    saveView();
    render();
  };
  return h(
    "div",
    { class: "filters" },
    h("input", {
      id: "board-search",
      type: "search",
      placeholder: "Search id or title",
      autocomplete: "off",
      spellcheck: "false",
      value: view.q,
      "aria-label": "Search id or title",
      oninput: (/** @type {Event} */ e) => set({ q: /** @type {HTMLInputElement} */ (e.target).value }),
    }),
    h(
      "div",
      { class: "row" },
      h(
        "select",
        { id: "board-who", "aria-label": "Assigned to", onchange: (/** @type {Event} */ e) => set({ who: /** @type {HTMLSelectElement} */ (e.target).value }) },
        h("option", { value: "all", selected: view.who === "all" }, "Everyone"),
        h("option", { value: "mine", selected: view.who === "mine" }, "Mine"),
        h("option", { value: "none", selected: view.who === "none" }, "Unassigned"),
        ...people.map((p) => h("option", { value: `p:${p}`, selected: view.who === `p:${p}` }, p)),
      ),
      h(
        "select",
        { id: "board-type", "aria-label": "Type", onchange: (/** @type {Event} */ e) => set({ type: /** @type {HTMLSelectElement} */ (e.target).value }) },
        h("option", { value: "", selected: !view.type }, "All types"),
        ...types.map((t) => h("option", { value: t, selected: view.type === t }, t)),
      ),
    ),
  );
}

function renderList() {
  if (!snapshot) return [h("div", { class: "row muted" }, spinner(), "Reading the sprint board…")];
  if (view.who === "mine" && meLogin === null) void need("me", meOf()).then((me) => ((meLogin = me.toLowerCase()), render()), () => ((meLogin = ""), render()));
  const q = view.q.trim().toLowerCase();
  const match = (/** @type {BoardItem} */ i) =>
    (view.who === "all" ||
      (view.who === "mine" && !!meLogin && i.login?.toLowerCase() === meLogin) ||
      (view.who === "none" && !i.assignee) ||
      (view.who.startsWith("p:") && i.assignee === view.who.slice(2))) &&
    (!view.type || i.type === view.type) &&
    (!q || String(i.id).includes(q) || i.title.toLowerCase().includes(q));
  const filtered = view.who !== "all" || !!view.type || !!q;
  const items = snapshot.items;
  const ids = new Set(items.map((i) => i.id));
  /** @type {Map<number, BoardItem[]>} */
  const kids = new Map();
  for (const i of items) if (i.parent && ids.has(i.parent)) kids.set(i.parent, [...(kids.get(i.parent) ?? []), i]);
  // Filtering lists matching items on their own; otherwise children sit under their story, as on the backlog.
  const top = filtered ? items.filter(match) : items.filter((i) => !(i.parent && ids.has(i.parent)));
  const groups = groupByState(top);
  if (!groups.length) return [filterBar(), h("p", { class: "muted note empty" }, filtered ? "Nothing matches." : "The sprint has no items.")];
  return [
    filterBar(),
    ...groups.map(([state, g]) => {
      const key = `s:${state}`;
      const open = isOpen(key, g.category !== "Completed" && g.category !== "Removed");
      return h(
        "section",
        { class: "group" },
        h(
          "button",
          { class: `group-head${open ? " open" : ""}`, type: "button", "aria-expanded": String(open), onclick: () => toggle(key) },
          icon(CARET),
          dot(g.color),
          h("span", { class: "group-name" }, state),
          h("span", { class: "group-count" }, String(g.items.length)),
        ),
        open ? h("div", { class: "group-items" }, ...g.items.map((i) => itemRow(i, { kids: filtered ? [] : (kids.get(i.id) ?? []) }))) : null,
      );
    }),
  ];
}

// ---------- an item ----------

/** Opens an item in the sidebar and reads what the board doesn't have. @param {number} id */
async function openItem(id, push = true) {
  if (push) {
    if (!opened.length) listScroll = document.scrollingElement?.scrollTop ?? 0;
    if (opened.at(-1) !== id) opened.push(id);
    render();
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  }
  const known = byId().get(id);
  const cached = details.get(id);
  if (cached && (cached.loading || (cached.item && !cached.error && (!known || known.rev === cached.rev)))) return;
  const s = settingsOf();
  /** @type {Detail} */
  const d = { rev: known?.rev ?? 0, prs: new Map(), loading: true };
  details.set(id, d);
  render();
  try {
    const [item, comments] = await Promise.all([
      az(["boards", "work-item", "show", "--id", String(id), "--expand", "relations"], s.org),
      invoke(s.org, "comments", [`project=${s.project}`, `workItemId=${id}`], ["order=asc"], "wit", "7.1-preview"),
    ]);
    d.item = item;
    d.rev = item?.rev ?? d.rev;
    d.comments = comments?.comments ?? [];
    d.loading = false;
    render();
    // Pull requests last: the item is already on screen.
    const prIds = (item?.relations ?? [])
      .filter((/** @type {any} */ r) => r.rel === "ArtifactLink" && /^vstfs:\/\/\/Git\/PullRequestId\//i.test(r.url))
      .map((/** @type {any} */ r) => Number(decodeURIComponent(r.url).split("/").at(-1)))
      .filter((/** @type {number} */ n) => Number.isInteger(n) && n > 0);
    await Promise.all(
      prIds.map(async (/** @type {number} */ pr) => {
        try {
          d.prs.set(pr, await az(["repos", "pr", "show", "--id", String(pr), "--detect", "false"], s.org));
        } catch (error) {
          d.prs.set(pr, { error: String(/** @type {any} */ (error)?.message ?? error) });
        }
        render();
      }),
    );
  } catch (error) {
    d.error = String(/** @type {any} */ (error)?.message ?? error);
    d.loading = false;
    render();
  }
}

function back() {
  opened.pop();
  render();
  if (!opened.length && document.scrollingElement) document.scrollingElement.scrollTop = listScroll;
}

/** An item link that opens it here. @param {number} id */
function itemLinkHere(id) {
  const known = byId().get(id);
  return h(
    "button",
    { class: "inline-item", type: "button", title: known ? `${known.type}: ${known.title}` : `#${id}`, onclick: () => void openItem(id) },
    known ? dot(typeColor(known.type)) : null,
    h("span", { class: "item-id" }, String(id)),
    h("span", { class: `item-title${known || details.get(id)?.item ? "" : " muted"}` }, known?.title ?? details.get(id)?.item?.fields?.["System.Title"] ?? "Outside this sprint"),
    known ? h("span", { class: "chip state" }, known.state) : null,
  );
}

/**
 * Azure DevOps rich text as safe page nodes. The HTML is parsed into an inert document, which runs no scripts and
 * loads nothing, and only its text and a few structural tags are copied out: never the parsed nodes themselves.
 * @param {string} html
 */
function richText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = h("div", { class: "rich" });
  /** @param {Node} from @param {HTMLElement} to */
  const walk = (from, to) => {
    for (const node of from.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.append(node.textContent ?? "");
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = /** @type {Element} */ (node);
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "template", "iframe", "object", "noscript"].includes(tag)) continue;
      if (tag === "br") to.append(h("br"));
      else if (tag === "img") to.append(h("span", { class: "muted" }, "[image]"));
      else if (tag === "a") {
        const href = el.getAttribute("href") ?? "";
        const text = (el.textContent ?? "").trim() || href;
        if (/^https:\/\/dev\.azure\.com\//.test(href)) to.append(h("button", { class: "inline-link", type: "button", title: href, onclick: () => void wings.openUrl(href) }, text));
        else to.append(text, href && href !== text && /^https?:/.test(href) ? h("span", { class: "muted" }, ` (${href})`) : "");
      } else {
        const map = /** @type {Record<string, string>} */ ({ p: "p", div: "p", ul: "ul", ol: "ol", li: "li", strong: "strong", b: "strong", em: "em", i: "em", code: "code", pre: "pre", h1: "p", h2: "p", h3: "p", h4: "p", h5: "p", h6: "p", tr: "p", blockquote: "blockquote" });
        const target = map[tag] ? h(map[tag], /^h\d$/.test(tag) ? { class: "heading" } : {}) : null;
        if (target) {
          walk(el, target);
          if (target.textContent?.trim() || target.querySelector("br, .muted")) to.append(target);
        } else {
          walk(el, to);
          if (tag === "td" || tag === "th") to.append(" ");
        }
      }
    }
  };
  walk(doc.body, out);
  return out;
}

/** A link as richText draws one: Azure DevOps links open, other web links show their address. @param {string} text @param {string} href */
const linkNode = (text, href) =>
  /^https:\/\/dev\.azure\.com\//.test(href)
    ? h("button", { class: "inline-link", type: "button", title: href, onclick: () => void wings.openUrl(href) }, text)
    : h("span", {}, text, /^https?:/.test(href) && href !== text ? h("span", { class: "muted" }, ` (${href})`) : "");

const mdInline = /!\[([^\]]*)\]\([^)\s]*\)|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;

/** Inline code, bold, italics and links as nodes. An image shows as [image], like in rich text. @param {string} src */
function markdownInline(src) {
  /** @type {(Node | string)[]} */
  const out = [];
  let at = 0;
  for (const m of src.matchAll(mdInline)) {
    if (m.index > at) out.push(src.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[0].startsWith("!")) out.push(h("span", { class: "muted" }, "[image]"));
    else if (m[2] !== undefined) out.push(linkNode(m[2], m[3]));
    else if (m[4] !== undefined) out.push(h("code", {}, m[4]));
    else if (m[5] !== undefined) out.push(h("strong", {}, ...markdownInline(m[5])));
    else out.push(h("em", {}, m[6]));
  }
  if (at < src.length) out.push(src.slice(at));
  return out;
}

/**
 * Azure DevOps markdown fields as page nodes: headings, paragraphs, lists, fenced code, quotes and rules, built as
 * new elements from the text. Raw HTML in it shows as text, never as markup.
 * @param {string} src
 */
function markdownText(src) {
  const out = h("div", { class: "rich" });
  // Azure DevOps keeps <, >, " and & in markdown fields as HTML entities. Decoded to text, they stay text.
  const named = /** @type {Record<string, string>} */ ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", nbsp: " " });
  const text = src.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1].toLowerCase() === "x" ? 2 : 1), e[1].toLowerCase() === "x" ? 16 : 10) || 0xfffd) : (named[e.toLowerCase()] ?? m),
  );
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  /** @type {string[]} */
  let para = [];
  /** @type {HTMLElement | null} */
  let list = null;
  const flush = () => {
    if (para.length) out.append(h("p", {}, ...markdownInline(para.join(" "))));
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
      out.append(h("pre", {}, h("code", {}, code.join("\n"))));
    } else if (!line.trim()) flush();
    else if (/^#{1,6}\s/.test(line)) {
      flush();
      out.append(h("p", { class: "heading" }, ...markdownInline(line.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, ""))));
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.append(h("hr"));
    } else if (item) {
      flush();
      const tag = item[1] ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) out.append((list = h(tag)));
      list.append(h("li", {}, ...markdownInline(item[2])));
    } else if (line.startsWith(">")) {
      flush();
      out.append(h("blockquote", {}, ...markdownInline(line.replace(/^>\s?/, ""))));
    } else para.push(line.trim());
  }
  flush();
  return out;
}

/** Whether a long-text field holds markdown: `az boards work-item show` says so in multilineFieldsFormat. @param {any} d @param {string} field */
const isMarkdown = (d, field) => String(d?.item?.multilineFieldsFormat?.[field] ?? "").toLowerCase() === "markdown";

/** Sections shown in full, by item and name; long ones start cut short. @type {Set<string>} */
const unclamped = new Set();

/** Text cut to a few lines with "Show all" when it's long. @param {string} key @param {HTMLElement} body */
function clampable(key, body) {
  const long = (body.textContent ?? "").length > 600;
  if (long && !unclamped.has(key)) body.classList.add("clamp");
  const more = long ? h("button", { class: "ghost more", type: "button", onclick: () => (unclamped.has(key) ? unclamped.delete(key) : unclamped.add(key), render()) }, unclamped.has(key) ? "Show less" : "Show all") : null;
  return [body, more];
}

/** @param {number} id @param {string} name @param {string} text @param {boolean} [markdown] the field holds markdown, not HTML */
const richSection = (id, name, text, markdown = false) =>
  h("section", { class: "detail-section" }, h("h2", {}, name), ...clampable(`${id}:${name}`, markdown ? markdownText(text) : richText(text)));

/** A comment's body, as rich text or markdown. @param {any} c */
const commentBody = (c) => (c.format === "markdown" ? markdownText(String(c.text ?? "")) : richText(String(c.renderedText || c.text || "")));

/** @param {string} label @param {Node | string | null} value */
const meta = (label, value) => (value ? h("div", { class: "meta-row" }, h("span", { class: "meta-label" }, label), h("div", { class: "meta-value" }, value)) : null);
const lastPart = (/** @type {string} */ path) => path.split("\\").at(-1) ?? path;

function renderDetail() {
  const id = /** @type {number} */ (opened.at(-1));
  const known = byId().get(id);
  const d = details.get(id);
  const f = d?.item?.fields ?? {};
  const title = f["System.Title"] ?? known?.title ?? `#${id}`;
  const type = f["System.WorkItemType"] ?? known?.type ?? "";
  const state = f["System.State"] ?? known?.state ?? "";
  const assignee = f["System.AssignedTo"]?.displayName ?? known?.assignee ?? null;
  const tags = f["System.Tags"] !== undefined ? String(f["System.Tags"]).split(";").map((t) => t.trim()).filter(Boolean) : (known?.tags ?? []);
  const rels = /** @type {any[]} */ (d?.item?.relations ?? []);
  const relIds = (/** @type {string} */ rel) => rels.filter((r) => r.rel === rel).map((r) => Number(String(r.url).split("/").at(-1))).filter(Number.isInteger);
  const parent = d?.item ? relIds("System.LinkTypes.Hierarchy-Reverse")[0] : known?.parent;
  const children = d?.item ? relIds("System.LinkTypes.Hierarchy-Forward") : (snapshot?.items ?? []).filter((i) => i.parent === id).map((i) => i.id);
  const blockedBy = known?.blockedBy ?? (main?.settings?.blockedByField ? f[main.settings.blockedByField] : null);
  const lead = blockedBy ? (String(blockedBy).match(/^\s*#?\d+(\s*[,;]?\s*#?\d+)*/)?.[0] ?? "") : "";
  const blockerIds = (lead.match(/\d+/g) ?? []).map(Number);
  // What's written after the ticket numbers, like a note on what has no ticket yet.
  const blockedNote = blockedBy ? String(blockedBy).slice(lead.length).replace(/^[\s,;]+/, "") : "";
  const info = stateInfo(type, state);
  const prRows = [...(d?.prs.entries() ?? [])].map(([pr, p]) => {
    const web = String(p?.repository?.webUrl ?? "");
    const url = /^https:\/\/dev\.azure\.com\//.test(web) ? `${web}/pullrequest/${pr}` : null;
    return h(
      "button",
      { class: "inline-item", type: "button", disabled: !url, title: url ? "Open the pull request" : (p?.error ?? ""), onclick: () => url && void wings.openUrl(url) },
      h("span", { class: "item-id" }, `!${pr}`),
      h("span", { class: "item-title" }, p?.title ?? (p?.error ? "Couldn't read it" : "")),
      p?.status ? h("span", { class: `chip pr ${p.status}` }, p.isDraft && p.status === "active" ? "draft" : p.status) : null,
    );
  });
  const comments = d?.comments ?? [];

  return [
    h(
      "div",
      { class: "row detail-bar" },
      h("button", { class: "ghost", type: "button", onclick: back }, "‹ Back"),
      h("span", { class: "grow" }),
      h("button", { class: "ghost", type: "button", onclick: () => void wings.openUrl(workItemUrl(id)) }, "Open in Azure DevOps"),
    ),
    h("div", { class: "detail-type" }, dot(typeColor(type)), `${type} ${id}`),
    h("h1", { class: "detail-title" }, title),
    h(
      "div",
      { class: "props" },
      meta("State", h("span", { class: "row tight" }, dot(info?.color ?? "#888888"), state)),
      meta("Assigned", h("span", { class: "row tight" }, avatar(assignee), assignee ?? "Unassigned")),
      meta("Iteration", f["System.IterationPath"] ? h("span", { title: f["System.IterationPath"] }, lastPart(f["System.IterationPath"])) : null),
      meta("Area", f["System.AreaPath"] ? h("span", { title: f["System.AreaPath"] }, lastPart(f["System.AreaPath"])) : null),
      meta("Tags", tags.length ? h("span", { class: "tags" }, ...tags.map((t) => h("span", { class: "chip tag" }, t))) : null),
      meta("Parent", parent ? itemLinkHere(parent) : null),
      meta("Children", children.length ? h("div", { class: "stack tight" }, ...children.map(itemLinkHere)) : null),
      meta("Blocked by", blockedBy ? h("div", { class: "stack tight" }, ...blockerIds.map(itemLinkHere), blockedNote ? h("span", {}, blockedNote) : null) : null),
      meta("Pull requests", prRows.length ? h("div", { class: "stack tight" }, ...prRows) : null),
    ),
    d?.loading ? h("div", { class: "row muted" }, spinner(), "Loading details and comments…") : null,
    d?.error ? h("p", { class: "error", role: "alert" }, `Couldn't read the item: ${d.error}`) : null,
    f["System.Description"] ? richSection(id, "Description", String(f["System.Description"]), isMarkdown(d, "System.Description")) : null,
    f["Microsoft.VSTS.Common.AcceptanceCriteria"]
      ? richSection(id, "Acceptance criteria", String(f["Microsoft.VSTS.Common.AcceptanceCriteria"]), isMarkdown(d, "Microsoft.VSTS.Common.AcceptanceCriteria"))
      : null,
    d?.item
      ? h(
          "section",
          { class: "detail-section" },
          h("h2", {}, `Discussion · ${comments.length}`),
          comments.length
            ? h(
                "ol",
                { class: "comments" },
                ...comments.map((/** @type {any} */ c) =>
                  h(
                    "li",
                    { class: "comment" },
                    h("div", { class: "row tight comment-head" }, avatar(c.createdBy?.displayName ?? null), h("span", { class: "comment-author" }, c.createdBy?.displayName ?? "Someone"), h("span", { class: "muted", title: c.createdDate ?? "" }, ago(String(c.createdDate ?? "")))),
                    ...clampable(`${id}:comment:${c.id}`, commentBody(c)),
                  ),
                ),
              )
            : h("p", { class: "muted note" }, "No comments."),
        )
      : null,
  ];
}

// ---------- the main view ----------

function renderMain() {
  if (opened.length) return renderDetail();
  const r = main?.result;
  const running = !!main?.running;
  const findings = r?.findings?.length ?? 0;
  return [
    h(
      "div",
      { class: "row sprint" },
      h(
        "div",
        { class: "grow sprint-name" },
        h("h1", {}, r?.sprint?.name ?? snapshot?.sprint.name ?? "Sprint"),
        h("div", { class: "dates muted" }, r ? `${day(r.sprint.start)} – ${day(r.sprint.finish)} · ${running ? "checking…" : `checked ${time(r.checkedAt)}`}` : ""),
      ),
      h("button", { class: "ghost", type: "button", disabled: running, title: "Read the board again", onclick: () => void wings.broadcast({ type: "refresh" }) }, running ? spinner() : null, "Refresh"),
      h("button", { class: "ghost", type: "button", onclick: () => openSettings() }, "Settings"),
    ),
    main?.error ? h("p", { class: "error", role: "alert" }, `Last refresh failed: ${main.error}`) : null,
    h(
      "div",
      { class: "tabs", role: "tablist" },
      ...[
        ["board", `Board${snapshot ? ` · ${snapshot.items.length}` : ""}`],
        ["checks", `Checks · ${findings}`],
      ].map(([tab, label]) =>
        h("button", { class: `tab${view.tab === tab ? " active" : ""}`, type: "button", role: "tab", "aria-selected": String(view.tab === tab), onclick: () => ((view.tab = tab), saveView(), render()) }, label),
      ),
    ),
    ...(view.tab === "checks" ? renderChecks() : renderList()),
  ];
}
