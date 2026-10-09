// @ts-check
/// <reference path="./wings.d.ts" />

// The Sprint board sidebar. main.js reads the board and sends its state here with wings.broadcast; this page
// draws it, edits the settings in wings.storage, and runs the az sign-in. Everything read from Azure DevOps is
// untrusted, so it only ever goes into the page as text.

const app = /** @type {HTMLElement} */ (document.getElementById("app"));

/** @typedef {{ key: string, label: string, kind: "text" | "list" | "lines" | "number", hint?: string, placeholder?: string, options?: "projects" | "teams" }} Field */
/** @type {Field[]} */
const MAIN_FIELDS = [
  { key: "org", label: "Organization URL", kind: "text", placeholder: "https://dev.azure.com/your-org" },
  { key: "project", label: "Project", kind: "text", options: "projects" },
  { key: "team", label: "Team", kind: "text", options: "teams" },
  { key: "areaPath", label: "Area path", kind: "text", hint: "Empty uses the team's default area." },
  { key: "members", label: "Team members", kind: "lines", hint: "Display names as in Azure DevOps, one per line." },
];
/** @type {Field[]} */
const RULE_FIELDS = [
  { key: "storyTypes", label: "Story types", kind: "list" },
  { key: "scopeChildTypes", label: "Scope child types", kind: "list", hint: "A story is in your team's scope when it has a child of one of these types. Empty puts every story in scope." },
  { key: "childTypes", label: "Child types checked", kind: "list", hint: "Children of an in-scope story that are checked too." },
  { key: "itemTypes", label: "Other item types", kind: "list", hint: "Sprint items of these types are in scope when assigned to a team member or titled with a prefix below." },
  { key: "titlePrefixes", label: "Title prefixes", kind: "list" },
  { key: "codeReviewStates", label: "Code review states", kind: "list", hint: "States whose linked pull request should be open." },
  { key: "blockedByField", label: "Blocked By field", kind: "text", placeholder: "Custom.Blocker", hint: "Reference name of a text field holding the blocking ticket number. Empty turns its checks off." },
  { key: "goalTag", label: "Goal tag", kind: "text", hint: "Tag on the sprint's priority work. Empty turns off the lower-priority test." },
  { key: "addedTags", label: "Added-during-sprint tags", kind: "list", hint: "Tags an item created after the sprint started must carry. Empty turns the check off." },
  { key: "pointTypes", label: "Types that need points", kind: "list", hint: "When added during the sprint. Titles with \"spike\" are exempt. Empty turns the check off." },
  { key: "pointFields", label: "Point fields", kind: "list", hint: "All must be set and equal." },
  { key: "parkedPrPrefix", label: "Parked PR title prefix", kind: "text", hint: "A linked PR whose title starts with this is parked on purpose, so its item skips the PR check." },
  { key: "staleDays", label: "Stale after (working days)", kind: "number" },
];

/** @type {{ phase: string, settings: Record<string, any>, missing: string[], result: any, error: string | null, running: boolean } | null} */
let main = null;
/** The settings form's values while it's open, as typed. @type {Record<string, string> | null} */
let draft = null;
/** @type {{ projects: string[], teams: string[], message: string | null }} */
const options = { projects: [], teams: [], message: null };
let signingIn = false;
/** @type {string | null} */
let localError = null;

// ---------- helpers ----------

/** A small element builder: strings become text, never HTML. @param {string} tag @param {Record<string, any>} [props] @param {...(Node | string | null | false | undefined)} children */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "value") /** @type {HTMLInputElement} */ (el).value = value;
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value != null) el.setAttribute(key, String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

const spinner = () => h("span", { class: "spinner", "aria-hidden": true });
/** "7 Oct" from an ISO date, read as a calendar day. @param {string | null} iso */
const day = (iso) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(iso)) : "?");
const time = (/** @type {string} */ iso) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** A work item's id and title as a link to it. @param {{ id: number, title: string, url: string }} item */
const itemLink = (item) =>
  h("button", { class: "link", type: "button", title: "Open in Azure DevOps", onclick: () => void wings.openUrl(item.url) }, h("span", { class: "id" }, `#${item.id} `), item.title);

// ---------- settings ----------

/** @param {Field} f @param {any} value */
const toText = (f, value) => (f.kind === "list" ? (value ?? []).join(", ") : f.kind === "lines" ? (value ?? []).join("\n") : String(value ?? ""));
/** @param {Field} f @param {string} text */
function fromText(f, text) {
  if (f.kind === "list") return text.split(",").map((v) => v.trim()).filter(Boolean);
  if (f.kind === "lines") return text.split("\n").map((v) => v.trim()).filter(Boolean);
  if (f.kind === "number") return Math.max(1, Math.round(Number(text) || 1));
  return text.trim();
}

function initDraft() {
  draft = Object.fromEntries([...MAIN_FIELDS, ...RULE_FIELDS].map((f) => [f.key, toText(f, main?.settings[f.key])]));
}

function openSettings() {
  initDraft();
  render();
  void loadProjects();
  void loadTeams();
}

async function save() {
  if (!draft) return;
  const values = /** @type {Record<string, string>} */ (draft);
  const settings = Object.fromEntries([...MAIN_FIELDS, ...RULE_FIELDS].map((f) => [f.key, fromText(f, values[f.key])]));
  try {
    await wings.storage.set("settings", settings);
  } catch (error) {
    localError = String(/** @type {any} */ (error)?.message ?? error);
    return render();
  }
  draft = null;
  localError = null;
  if (main) main = { ...main, phase: "loading", settings, error: null };
  render();
  await wings.broadcast({ type: "settings-changed" });
}

/** Read-only lists for the project and team fields, a convenience: typing a name works without them. */
async function azList(/** @type {string[]} */ args) {
  const out = await wings.exec("az", [...args, "--organization", (draft?.org ?? "").trim().replace(/\/+$/, ""), "-o", "json"]);
  if (out.code !== 0) throw new Error(out.stderr.trim().split("\n").filter((l) => l && !/^WARNING/.test(l)).at(-1) || "az failed");
  return JSON.parse(out.stdout);
}
const validOrg = () => /^https:\/\/dev\.azure\.com\/[\w.-]+\/?$/.test((draft?.org ?? "").trim());

async function loadProjects() {
  if (!validOrg()) return;
  try {
    const out = await azList(["devops", "project", "list", "--top", "500"]);
    options.projects = (out?.value ?? out ?? []).map((/** @type {any} */ p) => String(p.name)).sort();
    options.message = null;
  } catch (error) {
    options.message = `Couldn't list projects: ${/** @type {any} */ (error)?.message ?? error}`;
  }
  render();
}

async function loadTeams() {
  const project = (draft?.project ?? "").trim();
  if (!validOrg() || !project || /^[-@]/.test(project)) return;
  try {
    const out = await azList(["devops", "team", "list", "--project", project, "--top", "500"]);
    options.teams = (out ?? []).map((/** @type {any} */ t) => String(t.name)).sort();
    options.message = null;
  } catch (error) {
    options.message = `Couldn't list teams: ${/** @type {any} */ (error)?.message ?? error}`;
  }
  render();
}

/** @param {Field} f */
function field(f) {
  if (!draft) return null;
  const values = /** @type {Record<string, string>} */ (draft);
  const id = `f-${f.key}`;
  const oninput = (/** @type {Event} */ e) => (values[f.key] = /** @type {HTMLInputElement} */ (e.target).value);
  const control =
    f.kind === "lines"
      ? h("textarea", { id, rows: 3, value: values[f.key], oninput })
      : h("input", {
          id,
          type: f.kind === "number" ? "number" : "text",
          min: f.kind === "number" ? 1 : null,
          placeholder: f.placeholder ?? null,
          autocomplete: "off",
          spellcheck: "false",
          list: f.options ? `${id}-options` : null,
          value: values[f.key],
          oninput,
          onchange: f.key === "org" ? () => void loadProjects() : f.key === "project" ? () => void loadTeams() : null,
        });
  return h(
    "label",
    { for: id },
    f.label,
    control,
    f.options ? h("datalist", { id: `${id}-options` }, ...options[f.options].map((name) => h("option", { value: name }))) : null,
    f.hint ? h("span", { class: "hint" }, f.hint) : null,
  );
}

function renderSettings() {
  const setup = main?.phase === "setup";
  return h(
    "form",
    {
      class: "card settings",
      onsubmit: (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        void save();
      },
    },
    h("h1", {}, setup ? "Set up your sprint board" : "Settings"),
    setup ? h("p", { class: "muted" }, "Point it at your team's board. Settings stay in Wings on this computer, and the board is only ever read.") : null,
    ...MAIN_FIELDS.map(field),
    options.message ? h("p", { class: "note muted" }, options.message) : null,
    h("details", {}, h("summary", {}, "Scope and board rules"), ...RULE_FIELDS.map(field)),
    localError ? h("p", { class: "error", role: "alert" }, localError) : null,
    h(
      "div",
      { class: "row buttons" },
      setup ? null : h("button", { type: "button", class: "ghost", onclick: () => ((draft = null), (localError = null), render()) }, "Cancel"),
      h("button", { type: "submit", class: "primary" }, setup ? "Check the board" : "Save"),
    ),
  );
}

// ---------- the board ----------

async function signIn() {
  signingIn = true;
  render();
  try {
    // az opens the browser itself.
    const out = await wings.exec("az", ["login", "--allow-no-subscriptions", "--output", "none"], { timeoutMs: 5 * 60_000 });
    localError = out.code === 0 ? null : out.stderr.trim().split("\n").at(-1) || "Sign-in failed";
  } finally {
    signingIn = false;
  }
  render();
  if (!localError) void wings.broadcast({ type: "refresh" });
}

function refreshButton() {
  const running = !!main?.running;
  return h(
    "button",
    { class: "ghost", type: "button", disabled: running, onclick: () => void wings.broadcast({ type: "refresh" }) },
    running ? spinner() : null,
    running ? "Checking…" : "Refresh",
  );
}

/** @param {any} f */
const renderFinding = (f) =>
  h(
    "li",
    { class: "card finding" },
    h("span", { class: "check" }, f.dependency ? `${f.check} · dependency` : f.check),
    itemLink(f),
    h("p", { class: "problem" }, f.problem),
    h("p", { class: "fix" }, h("strong", {}, "Proposed fix: "), f.fix),
  );

/** @param {any} p */
const renderPerson = (p) =>
  h(
    "section",
    { class: "card person" },
    h("div", { class: "row" }, h("h2", { class: "grow" }, p.name), h("span", { class: "muted note" }, `${p.items.length} open`)),
    p.items.length
      ? h(
          "ul",
          { class: "list" },
          ...p.items.map((/** @type {any} */ i) =>
            h(
              "li",
              { class: "item" },
              itemLink(i),
              h(
                "div",
                { class: "meta" },
                h("span", {}, i.state),
                i.goal ? h("span", { class: "pill goal" }, "Goal") : null,
                i.blocked ? h("span", { class: "pill blocked", title: i.blockedBy ?? "" }, `Blocked: ${i.blockedBy}`) : null,
              ),
            ),
          ),
        )
      : h("p", { class: "muted note" }, "No open items in this sprint."),
  );

function renderBoard() {
  const r = main?.result;
  if (!r) return [];
  const parts = [
    h(
      "div",
      { class: "row sprint" },
      h("div", { class: "grow" }, h("h1", {}, r.sprint.name), h("div", { class: "dates muted" }, `${day(r.sprint.start)} – ${day(r.sprint.finish)} · checked ${time(r.checkedAt)}`)),
      refreshButton(),
      h("button", { class: "ghost", type: "button", onclick: openSettings }, "Settings"),
    ),
    h("div", { class: "section-title" }, h("span", {}, "Findings"), h("span", {}, String(r.findings.length))),
    r.findings.length ? h("ul", { class: "list" }, ...r.findings.map(renderFinding)) : h("div", { class: "card clean" }, "Board is clean."),
    h("div", { class: "section-title" }, h("span", {}, "Working on")),
    ...r.people.map(renderPerson),
  ];
  if (r.goalTag) {
    parts.push(
      h("div", { class: "section-title" }, h("span", {}, "Blocked with only lower-priority work")),
      ...r.people.map((/** @type {any} */ p) =>
        h("div", { class: `card verdict ${p.lowPriority.meets ? "yes" : ""}` }, h("strong", {}, `${p.name}: ${p.lowPriority.meets ? "yes" : "no"}. `), p.lowPriority.reason),
      ),
    );
  }
  parts.push(h("p", { class: "note muted" }, `Not covered: ${r.notCovered.join(" ")}`));
  return parts;
}

function render() {
  const active = document.activeElement;
  const focused = active?.id;
  const caret = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null;
  /** @type {(Node | null)[]} */
  const parts = [];
  if (!main || main.phase === "loading" || (main.phase !== "setup" && main.running && !main.result)) {
    parts.push(h("div", { class: "row muted" }, spinner(), "Reading the sprint board…"));
  } else if (main.phase === "setup" || draft) {
    if (!draft) initDraft();
    parts.push(renderSettings());
  } else if (main.phase === "signed-out") {
    parts.push(
      h(
        "section",
        { class: "card settings" },
        h("h1", {}, "Sign in to Azure DevOps"),
        h("p", { class: "muted" }, "The board is read with the az command line, which isn't signed in. Signing in opens your browser."),
        h(
          "div",
          { class: "row" },
          h("button", { class: "primary", type: "button", disabled: signingIn, onclick: () => void signIn() }, signingIn ? spinner() : null, signingIn ? "Finish in your browser…" : "Sign in"),
          h("button", { class: "ghost", type: "button", onclick: () => void wings.broadcast({ type: "refresh" }) }, "Try again"),
        ),
      ),
    );
  } else if (main.phase === "error") {
    parts.push(
      h(
        "section",
        { class: "card settings" },
        h("h1", {}, "Couldn't read the board"),
        h("p", { class: "error", role: "alert" }, main.error ?? "Unknown error"),
        h("div", { class: "row" }, refreshButton(), h("button", { class: "ghost", type: "button", onclick: openSettings }, "Settings")),
      ),
    );
  } else {
    parts.push(...renderBoard());
    // The last refresh failed, but the board from before is still worth showing.
    if (main.error) parts.splice(1, 0, h("p", { class: "error", role: "alert" }, `Last refresh failed: ${main.error}`));
  }
  if (localError && !draft) parts.push(h("p", { class: "error", role: "alert" }, localError));
  app.replaceChildren(...parts.filter((p) => !!p));
  if (focused) {
    const el = document.getElementById(focused);
    el?.focus();
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && caret != null && el.type !== "number") el.setSelectionRange(caret, caret);
  }
}

wings.onBroadcast((message) => {
  const m = /** @type {any} */ (message);
  if (m?.type !== "state") return;
  main = m.state;
  render();
});

render();
void wings.broadcast({ type: "hello" });
