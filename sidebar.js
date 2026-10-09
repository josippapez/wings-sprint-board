// @ts-check
/// <reference path="./wings.d.ts" />

// The Sprint board sidebar. main.js reads the board and sends its state here with wings.broadcast; this page
// draws it and runs the az sign-in. setup.js, loaded first, detects and edits the settings. Everything read from Azure DevOps is
// untrusted, so it only ever goes into the page as text.

const app = /** @type {HTMLElement} */ (document.getElementById("app"));

/** @type {{ phase: string, settings: Record<string, any>, missing: string[], result: any, error: string | null, running: boolean } | null} */
let main = null;
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
  if (localError) return;
  if (main?.phase === "setup") void detect();
  else void wings.broadcast({ type: "refresh" });
}

function signInCard() {
  return h(
    "section",
    { class: "card settings" },
    h("h1", {}, "Sign in to Azure DevOps"),
    h("p", { class: "muted" }, "The board is read with the az command line, which isn't signed in. Signing in opens your browser."),
    h(
      "div",
      { class: "row" },
      h("button", { class: "primary", type: "button", disabled: signingIn, onclick: () => void signIn() }, signingIn ? spinner() : null, signingIn ? "Finish in your browser…" : "Sign in"),
      h("button", { class: "ghost", type: "button", onclick: () => void (main?.phase === "setup" ? detect() : wings.broadcast({ type: "refresh" })) }, "Try again"),
    ),
  );
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
  // Everything is rebuilt, so keep where the page and each scrolling list were.
  const page = document.scrollingElement?.scrollTop ?? 0;
  const lists = [...app.querySelectorAll(".scroll[id]")].map((el) => /** @type {const} */ ([el.id, el.scrollTop]));
  /** @type {(Node | null)[]} */
  const parts = [];
  if (!main || main.phase === "loading" || (main.phase !== "setup" && main.running && !main.result)) {
    parts.push(h("div", { class: "row muted" }, spinner(), "Reading the sprint board…"));
  } else if (detecting || (main.phase === "setup" && !draft)) {
    parts.push(renderDetecting());
  } else if (main.phase === "setup" || draft) {
    parts.push(renderSettings());
    if (detectError && /signed in/.test(detectError)) parts.push(signInCard());
  } else if (main.phase === "signed-out") {
    parts.push(signInCard());
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
  for (const [id, top] of lists) {
    const el = document.getElementById(id);
    if (el) el.scrollTop = top;
  }
  if (document.scrollingElement) document.scrollingElement.scrollTop = page;
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
  maybeDetect();
});

render();
void wings.broadcast({ type: "hello" });
