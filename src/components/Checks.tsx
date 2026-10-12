// The board checks: findings, who is working on what, and the lower-priority test.

import { Badge, Card, Heading, List, ListItem, Row, Stack, Text, Title } from "wings-plugin-ui";

import { openItem } from "../lib/board";
import type { Finding } from "../lib/check";
import { page } from "../lib/page";
import type { Published } from "../lib/types";

type Person = NonNullable<Published["result"]>["people"][number];

/** A work item's id and title, opening it in the sidebar. */
const itemLink = (item: { id: number; title: string }) => (
  <button className="link" type="button" onClick={() => void openItem(item.id)}>
    <span className="id">{`#${item.id} `}</span>
    {item.title}
  </button>
);

const renderFinding = (f: Finding, n: number) => (
  <Card key={n} as="li">
    <Stack gap="s">
      <Row>
        <Badge tone="warn">{f.dependency ? `${f.check} · dependency` : f.check}</Badge>
      </Row>
      {itemLink(f)}
      <Text as="p" className="wrap">{f.problem}</Text>
      <Text as="p" tone="muted" size="small" className="wrap">
        <Text as="strong" weight="medium" className="fg">Proposed fix: </Text>
        {f.fix}
      </Text>
    </Stack>
  </Card>
);

const renderPerson = (p: Person, n: number) => (
  <Card key={`person:${n}`} as="section">
    <Row justify="between">
      <Title as="h2">{p.name}</Title>
      <Text tone="muted" size="small">{`${p.items.length} open`}</Text>
    </Row>
    {p.items.length ? (
      <List>
        {p.items.map((i) => (
          <ListItem key={i.id} align="start">
            <Stack gap="xs">
              {itemLink(i)}
              <Row gap="s" wrap>
                <Text tone="muted" size="small">{i.state}</Text>
                {i.goal ? <Badge tone="info">Goal</Badge> : null}
                {i.blocked ? <Badge tone="danger" title={i.blockedBy ?? ""}>{`Blocked: ${i.blockedBy}`}</Badge> : null}
              </Row>
            </Stack>
          </ListItem>
        ))}
      </List>
    ) : (
      <Text as="p" tone="muted" size="small">No open items in this sprint.</Text>
    )}
  </Card>
);

/** The board checks: findings, who is working on what, and the lower-priority test. */
export function renderChecks() {
  const r = page.main?.result;
  if (!r) return [];
  const parts = [
    <Heading key="findings" actions={<Text tone="muted" size="small">{String(r.findings.length)}</Text>}>Findings</Heading>,
    r.findings.length ? <Stack key="list" as="ul">{r.findings.map(renderFinding)}</Stack> : <Card key="clean"><Text tone="success" weight="medium">Board is clean.</Text></Card>,
    <Heading key="working">Working on</Heading>,
    ...r.people.map(renderPerson),
  ];
  if (r.goalTag) {
    parts.push(
      <Heading key="low">Blocked with only lower-priority work</Heading>,
      ...r.people.map((p, n) => (
        <Card key={`verdict:${n}`} compact>
          <p>
            <Text as="strong" weight="strong" tone={p.lowPriority!.meets ? "danger" : undefined}>{`${p.name}: ${p.lowPriority!.meets ? "yes" : "no"}. `}</Text>
            {p.lowPriority!.reason}
          </p>
        </Card>
      )),
    );
  }
  parts.push(<Text key="not-covered" as="p" tone="muted" size="small">{`Not covered: ${r.notCovered.join(" ")}`}</Text>);
  return parts;
}
