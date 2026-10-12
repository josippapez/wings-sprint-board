// The board's main view: the sprint, Refresh and Settings, and the Board and Checks tabs.

import { Button, Row, Stack, Tabs, Text, Title } from "wings-plugin-ui";

import { board, saveView } from "../lib/board";
import { day, time } from "../lib/format";
import { page, render } from "../lib/page";
import { openSettings } from "../lib/setup";
import { errorLine } from "./bits";
import { renderList } from "./BoardList";
import { renderChecks } from "./Checks";
import { renderDetail } from "./Detail";

export function renderMain() {
  if (board.opened.length) return renderDetail();
  const main = page.main;
  const view = board.view;
  const snapshot = board.snapshot;
  const r = main?.result;
  const running = !!main?.running;
  const findings = r?.findings?.length ?? 0;
  return (
    <>
      <Row>
        <Stack gap="none" grow>
          <Title truncate>{r?.sprint?.name ?? snapshot?.sprint.name ?? "Sprint"}</Title>
          <Text tone="muted" size="small" truncate>{r ? `${day(r.sprint.start)} – ${day(r.sprint.finish)} · ${running ? "checking…" : `checked ${time(r.checkedAt)}`}` : ""}</Text>
        </Stack>
        <Button variant="ghost" busy={running} title="Read the board again" onClick={() => void wings.broadcast({ type: "refresh" })}>
          Refresh
        </Button>
        <Button variant="ghost" onClick={() => openSettings()}>Settings</Button>
      </Row>
      {main?.error ? errorLine(`Last refresh failed: ${main.error}`) : null}
      <Tabs
        variant="line"
        label="Sprint board"
        items={[
          { value: "board", label: `Board${snapshot ? ` · ${snapshot.items.length}` : ""}` },
          { value: "checks", label: `Checks · ${findings}` },
        ]}
        value={view.tab}
        onChange={(tab) => ((view.tab = tab), saveView(), render())}
      >
        <Stack>{view.tab === "checks" ? renderChecks() : renderList()}</Stack>
      </Tabs>
    </>
  );
}
