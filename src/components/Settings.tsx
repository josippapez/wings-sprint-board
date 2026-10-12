// The setup stepper: Back/Next, Turn this check off, Use detected for the rest, and dots to jump to a step.

import { Button, Card, Disclosure, Row, Text, Title } from "wings-plugin-ui";

import { page, render } from "../lib/page";
import { context, detect, save, setup } from "../lib/setup";
import { errorLine, spinner } from "./bits";
import { STEPS } from "./Steps";

/** Moves to a step and puts focus on its question. */
function goTo(n: number) {
  setup.step = Math.max(0, Math.min(STEPS.length - 1, n));
  setup.focusAfterRender = "step-question";
  render();
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
}

export function renderSettings() {
  const c = context();
  const step = setup.step;
  const s = STEPS[step];
  const inSetup = page.main?.phase === "setup";
  const essentials = STEPS.slice(0, 3).every((x) => !x.ready || x.ready(c));
  const ready = !s.ready || s.ready(c);
  const last = step === STEPS.length - 1;
  const why = s.why(c);
  const { detection, detectError } = setup;
  return (
    <Card
      as="form"
      key="settings"
      // Browsers submit on Enter only from text fields; from the question, a checkbox or a select it goes on too.
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        const native = t instanceof HTMLButtonElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type !== "checkbox");
        if (e.key === "Enter" && !native && !e.defaultPrevented) {
          e.preventDefault();
          e.currentTarget.requestSubmit();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        if (last) void save();
        else goTo(step + 1);
      }}
    >
      <Row>
        <Text tone="muted" size="small" grow>{`${inSetup ? "Set up" : "Settings"} · step ${step + 1} of ${STEPS.length}`}</Text>
        {inSetup ? null : <Button variant="ghost" size="sm" onClick={() => ((setup.draft = null), (setup.detection = null), (page.localError = null), render())}>Close</Button>}
      </Row>
      <div className="dots" role="list">
        {STEPS.map((x, n) => (
          <button
            key={x.id}
            type="button"
            role="listitem"
            className={`step-dot${n === step ? " current" : n < step ? " done" : ""}`}
            aria-label={`Step ${n + 1}: ${x.question}`}
            aria-current={n === step ? "step" : undefined}
            title={x.question}
            // Later steps need the board picked first.
            disabled={n > step && !essentials}
            onClick={() => goTo(n)}
          />
        ))}
      </div>
      <Title id="step-question" size="large" tabIndex={-1}>{s.question}</Title>
      <Text as="p" tone="muted">{s.explain}</Text>
      {why ? <Text as="p" tone="info" size="small">{why}</Text> : null}
      {detectError && step === 0 ? errorLine(`Couldn't detect the settings: ${detectError}`) : null}
      {detection && step === 0 ? (
        <Disclosure summary={`What was detected (${detection.calls} calls, ${(detection.ms / 1000).toFixed(1)} s)`}>
          <ul className="detected">
            {detection.notes.map((n, i) => <li key={`n${i}`}>{n}</li>)}
            {detection.off.map((n, i) => <li key={`o${i}`} className="muted">{`Off: ${n}`}</li>)}
          </ul>
        </Disclosure>
      ) : null}
      {s.body(c)}
      {s.show(c)}
      {page.localError ? errorLine(page.localError) : null}
      <Row>
        {step > 0 ? <Button variant="ghost" onClick={() => goTo(step - 1)}>Back</Button> : null}
        <Text grow />
        {s.optional && s.off ? <Button variant="ghost" onClick={() => (s.off?.(c.d), last ? void save() : goTo(step + 1))}>Turn this check off</Button> : null}
        <Button type="submit" variant="default" disabled={!ready}>{last ? (inSetup ? "Finish" : "Save") : "Next"}</Button>
      </Row>
      <Row justify="end">
        <Button variant="ghost" size="sm" busy={!!setup.detecting} onClick={() => void detect()}>Detect again</Button>
        {essentials && !last ? <Button variant="ghost" size="sm" onClick={() => void save()}>{inSetup ? "Use detected for the rest" : "Save now"}</Button> : null}
      </Row>
    </Card>
  );
}

export function renderDetecting() {
  return (
    <Card key="detecting">
      <Title>Setting up your sprint board</Title>
      <Row>
        {spinner()}
        <Text tone="muted">{setup.detecting?.step ?? ""}</Text>
      </Row>
    </Card>
  );
}
