// The HTML Azure DevOps keeps for a description or a comment, drawn in the native app, which has no DOM: the lines
// lib/html.ts reads from it, as paragraphs, list items and code of wings-plugin-ui.

import type { ReactNode } from "react";
import { CodeBlock, Row, Stack, Text } from "wings-plugin-ui";
import { blocksOf, parseHtml, type Span } from "../lib/html";

function spans(parts: Span[]): ReactNode[] {
  return parts.map(({ text, strong, mono, muted, href }, i) => {
    const open = href ? () => void wings.openUrl(href).catch(() => {}) : undefined;
    return strong || mono || muted || open ? (
      <Text key={i} weight={strong ? "strong" : undefined} mono={mono} tone={muted ? "muted" : undefined} onClick={open}>
        {text}
      </Text>
    ) : (
      text
    );
  });
}

export function Html({ html }: { html: string }) {
  return (
    <Stack gap="s">
      {blocksOf(parseHtml(html)).map((b, i) => {
        if (b.kind === "code") return <CodeBlock key={i} code={b.spans.map((s) => s.text).join("").replace(/^\n|\n$/g, "")} />;
        const text = <Text key={i} grow weight={b.kind === "heading" ? "strong" : undefined}>{spans(b.spans)}</Text>;
        if (b.kind !== "item" && !b.depth) return text;
        // List items indent by an em space a level, as the native app has no padding to give a row.
        return (
          <Row key={i} gap="s" align="start">
            <Text tone="muted">{"\u2003".repeat(b.depth - 1)}{b.kind === "item" ? b.marker : "\u2003"}</Text>
            {text}
          </Row>
        );
      })}
    </Stack>
  );
}
