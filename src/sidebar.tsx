// The Sprint board sidebar. main.js reads the board and sends its state here with wings.broadcast; this
// page picks the view and runs the az sign-in. lib/setup.ts detects and edits the settings, the board components
// draw the board and an item. Everything read from Azure DevOps is
// untrusted, so it only ever goes into the page as text.

import { Fragment, type ReactNode } from "react";
import { Button, Card, Row, Text, Title } from "wings-plugin-ui";

import { errorLine, spinner } from "./components/bits";
import { renderMain } from "./components/Main";
import { renderDetecting, renderSettings } from "./components/Settings";
import { board, loadSnapshot, loadView } from "./lib/board";
import { mount, page, render } from "./lib/page";
import { detect, maybeDetect, onPanes, openSettings, setup } from "./lib/setup";
import type { StateMessage } from "./lib/types";
import "./sidebar.css";

// ---------- the board ----------

async function signIn() {
  page.signingIn = true;
  render();
  try {
    // az opens the browser itself.
    const out = await wings.exec("az", ["login", "--allow-no-subscriptions", "--output", "none"], { timeoutMs: 5 * 60_000 });
    page.localError = out.code === 0 ? null : out.stderr.trim().split("\n").at(-1) || "Sign-in failed";
  } finally {
    page.signingIn = false;
  }
  render();
  if (page.localError) return;
  if (page.main?.phase === "setup") void detect();
  else void wings.broadcast({ type: "refresh" });
}

function signInCard() {
  const main = page.main;
  return (
    <Card key="sign-in" as="section">
      <Title>Sign in to Azure DevOps</Title>
      <Text as="p" tone="muted">The board is read with the az command line, which isn't signed in. Signing in opens your browser.</Text>
      <Row>
        <Button variant="default" busy={page.signingIn} onClick={() => void signIn()}>
          {page.signingIn ? "Finish in your browser…" : "Sign in"}
        </Button>
        <Button variant="ghost" onClick={() => void (main?.phase === "setup" ? detect() : wings.broadcast({ type: "refresh" }))}>Try again</Button>
      </Row>
    </Card>
  );
}

function refreshButton() {
  const running = !!page.main?.running;
  return (
    <Button variant="ghost" busy={running} onClick={() => void wings.broadcast({ type: "refresh" })}>
      {running ? "Checking…" : "Refresh"}
    </Button>
  );
}

/** What the sidebar shows. */
function view() {
  const main = page.main;
  const parts: ReactNode[] = [];
  // The last check's board shows while the first check after a start runs.
  const stored = !!board.snapshot && !!main?.settings?.org && main.phase !== "setup" && main.phase !== "signed-out";
  if (!main || (!stored && (main.phase === "loading" || (main.phase !== "setup" && main.running && !main.result)))) {
    parts.push(<Row key="reading">{spinner()}<Text tone="muted">Reading the sprint board…</Text></Row>);
  } else if (setup.detecting || (main.phase === "setup" && !setup.draft)) {
    parts.push(renderDetecting());
  } else if (main.phase === "setup" || setup.draft) {
    parts.push(renderSettings());
    if (setup.detectError && /signed in/.test(setup.detectError)) parts.push(signInCard());
  } else if (main.phase === "signed-out") {
    parts.push(signInCard());
  } else if (main.phase === "error" && !stored) {
    parts.push(
      <Card key="error" as="section">
        <Title>Couldn't read the board</Title>
        {errorLine(main.error ?? "Unknown error")}
        <Row>
          {refreshButton()}
          <Button variant="ghost" onClick={() => openSettings()}>Settings</Button>
        </Row>
      </Card>,
    );
  } else {
    parts.push(<Fragment key="main">{renderMain()}</Fragment>);
  }
  if (page.localError && !setup.draft) parts.push(errorLine(page.localError, "local-error"));
  return parts;
}

wings.onPanes(onPanes);

wings.onBroadcast((message) => {
  const m = message as StateMessage | null;
  if (m?.type !== "state") return;
  page.main = m.state;
  render();
  maybeDetect();
  // A finished check stored a new board.
  if (m.state.result?.checkedAt && m.state.result.checkedAt !== board.snapshot?.checkedAt) void loadSnapshot();
});

mount(view);
render();
// The board from the last check shows at once, while main.js answers.
void loadView().then(loadSnapshot).finally(() => void wings.broadcast({ type: "hello" }));
