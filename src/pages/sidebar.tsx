// The Sprint board sidebar. Main reads the board and serves its state and board as queries; this page picks the
// view and runs the az sign-in. ui/setup.ts detects and edits the settings, the board components draw the board and
// an item. Everything read from Azure DevOps is untrusted, so it only ever goes into the page as text.

import { Fragment, useEffect, useReducer, useRef, type ReactNode } from "react";
import { useQuery } from "wings-plugin-sdk/react";
import { Button, Card, Row, Text, Title } from "wings-plugin-ui";

import { azCli, failure } from "../lib/azure";
import { ch } from "../lib/messages";
import type { Published } from "../lib/types";
import { errorLine, spinner } from "../ui/bits";
import { board, dropStaleDetails, loadView } from "../ui/board";
import { renderMain } from "../ui/Main";
import { onRender, page as shared, render } from "../ui/page";
import { renderDetecting, renderSettings } from "../ui/Settings";
import { detect, maybeDetect, onPanes, openSettings, setup } from "../ui/setup";
import "./sidebar.css";

export const page = { place: "sidebar" };

async function signIn() {
  shared.signingIn = true;
  render();
  try {
    // az opens the browser itself.
    await azCli.signIn();
    shared.localError = null;
  } catch (error) {
    shared.localError = failure(error);
  } finally {
    shared.signingIn = false;
  }
  render();
  if (shared.localError) return;
  if (shared.main?.phase === "setup") void detect();
  else void ch.tell("refresh");
}

function signInCard() {
  const main = shared.main;
  return (
    <Card key="sign-in" as="section">
      <Title>Sign in to Azure DevOps</Title>
      <Text as="p" tone="muted">The board is read with the az command line, which isn't signed in. Signing in opens your browser.</Text>
      <Row>
        <Button variant="default" busy={shared.signingIn} onClick={() => void signIn()}>
          {shared.signingIn ? "Finish in your browser…" : "Sign in"}
        </Button>
        <Button variant="ghost" onClick={() => void (main?.phase === "setup" ? detect() : ch.tell("refresh"))}>Try again</Button>
      </Row>
    </Card>
  );
}

function refreshButton() {
  const running = !!shared.main?.running;
  return (
    <Button variant="ghost" busy={running} onClick={() => void ch.tell("refresh")}>
      {running ? "Checking…" : "Refresh"}
    </Button>
  );
}

/** What the sidebar shows. */
function view() {
  const main = shared.main;
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
  if (shared.localError && !setup.draft) parts.push(errorLine(shared.localError, "local-error"));
  return parts;
}

/** Runs `fn` once React has finished the commit that asked for it: render() flushes synchronously, which React refuses to do inside an effect. */
const afterCommit = (fn: () => void) => queueMicrotask(fn);

export default function Sidebar() {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const state = useQuery(ch, "state", undefined);
  const snapshot = useQuery(ch, "board", undefined);
  // The views below read these, so they are set before they draw. A save sets the state itself until main serves the new one.
  const served = useRef<Published | null>(null);
  if (state.data !== served.current) shared.main = served.current = state.data;
  if (snapshot.data) board.snapshot = snapshot.data;

  useEffect(() => onRender(redraw), []);
  useEffect(() => {
    // The panes say where Azure DevOps repos are open, for the setup steps.
    const stop = wings.onPanes(onPanes);
    void loadView().then(render);
    return stop;
  }, []);
  useEffect(() => afterCommit(maybeDetect), [state.data]);
  // A finished check brought a new board.
  useEffect(() => afterCommit(dropStaleDetails), [snapshot.data]);

  return <>{view()}</>;
}
