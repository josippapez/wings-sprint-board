// An item's details and comments in the sidebar. Text from Azure DevOps goes into the page only as text nodes.

import type { ReactElement, ReactNode } from "react";
import { Badge, Button, Heading, ListButton, Properties, Row, Stack, Text, Title } from "wings-plugin-ui";

import { back, board, byId, details, openItem, stateInfo, typeColor, workItemUrl, type CommentJson, type Detail } from "./board";
import { ago } from "../lib/format";
import { page, render } from "./page";
import { markdownText, richText, textOf } from "./richText";
import { avatar, dot, errorLine, spinner } from "./bits";
import { prTone } from "./BoardList";

/** An item link that opens it here. */
function itemLinkHere(id: number) {
  const known = byId().get(id);
  return (
    <ListButton key={id} title={known ? `${known.type}: ${known.title}` : `#${id}`} onClick={() => void openItem(id)}>
      {known ? dot(typeColor(known.type)) : null}
      <Text mono size="tiny" tone="muted" numeric>{String(id)}</Text>
      <Text truncate grow tone={known || details.get(id)?.item ? undefined : "muted"}>{known?.title ?? details.get(id)?.item?.fields?.["System.Title"] ?? "Outside this sprint"}</Text>
      {known ? <Badge variant="outline" className="state">{known.state}</Badge> : null}
    </ListButton>
  );
}

/** Whether a long-text field holds markdown: `az boards work-item show` says so in multilineFieldsFormat. */
const isMarkdown = (d: Detail | undefined, field: string) => String(d?.item?.multilineFieldsFormat?.[field] ?? "").toLowerCase() === "markdown";

/** Sections shown in full, by item and name; long ones start cut short. */
const unclamped = new Set<string>();

/** Text cut to a few lines with "Show all" when it's long. */
function clampable(key: string, body: ReactElement<{ className?: string; children?: ReactNode }>) {
  const long = textOf(body).length > 600;
  const clamped = long && !unclamped.has(key) ? <div className={`${body.props.className} clamp`}>{body.props.children}</div> : body;
  const more = long ? (
    <Row>
      <Button variant="ghost" size="sm" onClick={() => (unclamped.has(key) ? unclamped.delete(key) : unclamped.add(key), render())}>{unclamped.has(key) ? "Show less" : "Show all"}</Button>
    </Row>
  ) : null;
  return (
    <>
      {clamped}
      {more}
    </>
  );
}

const richSection = (id: number, name: string, text: string, markdown = false) => (
  <Stack as="section" gap="s" className="detail-section">
    <Heading>{name}</Heading>
    {clampable(`${id}:${name}`, markdown ? markdownText(text) : richText(text))}
  </Stack>
);

/** A comment's body, as rich text or markdown. */
const commentBody = (c: CommentJson) => (c.format === "markdown" ? markdownText(String(c.text ?? "")) : richText(String(c.renderedText || c.text || "")));

/** The item's fields that have a value, as label and value pairs. */
const meta = (rows: [string, ReactNode][]) => rows.filter(([, value]) => !!value).map(([label, value]) => ({ label, value }));
const lastPart = (path: string) => path.split("\\").at(-1) ?? path;

export function renderDetail() {
  const id = board.opened.at(-1) as number;
  const known = byId().get(id);
  const d = details.get(id);
  const f = d?.item?.fields ?? {};
  const main = page.main;
  const title = f["System.Title"] ?? known?.title ?? `#${id}`;
  const type = f["System.WorkItemType"] ?? known?.type ?? "";
  const state = f["System.State"] ?? known?.state ?? "";
  const assignee = f["System.AssignedTo"]?.displayName ?? known?.assignee ?? null;
  const tags = f["System.Tags"] !== undefined ? String(f["System.Tags"]).split(";").map((t) => t.trim()).filter(Boolean) : (known?.tags ?? []);
  const rels = d?.item?.relations ?? [];
  const relIds = (rel: string) => rels.filter((r) => r.rel === rel).map((r) => Number(String(r.url).split("/").at(-1))).filter(Number.isInteger);
  const parent = d?.item ? relIds("System.LinkTypes.Hierarchy-Reverse")[0] : known?.parent;
  const children = d?.item ? relIds("System.LinkTypes.Hierarchy-Forward") : (board.snapshot?.items ?? []).filter((i) => i.parent === id).map((i) => i.id);
  const blockedBy = known?.blockedBy ?? (main?.settings?.blockedByField ? f[main.settings.blockedByField] : null);
  const lead = blockedBy ? (String(blockedBy).match(/^\s*#?\d+(\s*[,;]?\s*#?\d+)*/)?.[0] ?? "") : "";
  const blockerIds = (lead.match(/\d+/g) ?? []).map(Number);
  // What's written after the ticket numbers, like a note on what has no ticket yet.
  const blockedNote = blockedBy ? String(blockedBy).slice(lead.length).replace(/^[\s,;]+/, "") : "";
  const info = stateInfo(type, state);
  const prRows = [...(d?.prs.entries() ?? [])].map(([pr, p]) => {
    const web = String(p?.repository?.webUrl ?? "");
    const url = /^https:\/\/dev\.azure\.com\//.test(web) ? `${web}/pullrequest/${pr}` : null;
    return (
      <ListButton key={pr} disabled={!url} title={url ? "Open the pull request" : (p?.error ?? "")} onClick={() => url && void wings.openUrl(url)}>
        <Text mono size="tiny" tone="muted" numeric>{`!${pr}`}</Text>
        <Text truncate grow>{p?.title ?? (p?.error ? "Couldn't read it" : "")}</Text>
        {p?.status ? <Badge tone={prTone(p.status)}>{p.isDraft && p.status === "active" ? "draft" : p.status}</Badge> : null}
      </ListButton>
    );
  });
  const comments = d?.comments ?? [];

  return (
    <>
      <Row>
        <Button variant="ghost" onClick={back}>‹ Back</Button>
        <Text grow />
        <Button variant="ghost" onClick={() => void wings.openUrl(workItemUrl(id))}>Open in Azure DevOps</Button>
      </Row>
      <Row gap="s">
        {dot(typeColor(type))}
        <Text tone="muted" size="small">{`${type} ${id}`}</Text>
      </Row>
      <Title size="large">{title}</Title>
      <Properties
        items={meta([
          ["State", <Row gap="s">{dot(info?.color ?? "#888888")}{state}</Row>],
          ["Assigned", <Row gap="s">{avatar(assignee)}{assignee ?? "Unassigned"}</Row>],
          ["Iteration", f["System.IterationPath"] ? <span title={f["System.IterationPath"]}>{lastPart(f["System.IterationPath"])}</span> : null],
          ["Area", f["System.AreaPath"] ? <span title={f["System.AreaPath"]}>{lastPart(f["System.AreaPath"])}</span> : null],
          ["Tags", tags.length ? <Row gap="s" wrap>{tags.map((t, n) => <Badge variant="outline" key={n}>{t}</Badge>)}</Row> : null],
          ["Parent", parent ? itemLinkHere(parent) : null],
          ["Children", children.length ? <Stack gap="none">{children.map(itemLinkHere)}</Stack> : null],
          ["Blocked by", blockedBy ? <Stack gap="none">{blockerIds.map(itemLinkHere)}{blockedNote ? <span>{blockedNote}</span> : null}</Stack> : null],
          ["Pull requests", prRows.length ? <Stack gap="none">{prRows}</Stack> : null],
        ])}
      />
      {d?.loading ? <Row>{spinner()}<Text tone="muted">Loading details and comments…</Text></Row> : null}
      {d?.error ? errorLine(`Couldn't read the item: ${d.error}`) : null}
      {f["System.Description"] ? richSection(id, "Description", String(f["System.Description"]), isMarkdown(d, "System.Description")) : null}
      {f["Microsoft.VSTS.Common.AcceptanceCriteria"]
        ? richSection(id, "Acceptance criteria", String(f["Microsoft.VSTS.Common.AcceptanceCriteria"]), isMarkdown(d, "Microsoft.VSTS.Common.AcceptanceCriteria"))
        : null}
      {d?.item ? (
        <Stack as="section" gap="s" className="detail-section">
          <Heading>{`Discussion · ${comments.length}`}</Heading>
          {comments.length ? (
            <Stack as="ol" gap="l">
              {comments.map((c, n) => (
                <Stack key={n} as="li" gap="s" className="comment">
                  <Row gap="s">
                    {avatar(c.createdBy?.displayName ?? null)}
                    <Text size="small" weight="medium" truncate>{c.createdBy?.displayName ?? "Someone"}</Text>
                    <Text size="small" tone="muted" title={c.createdDate ?? ""}>{ago(String(c.createdDate ?? ""))}</Text>
                  </Row>
                  {clampable(`${id}:comment:${c.id}`, commentBody(c))}
                </Stack>
              ))}
            </Stack>
          ) : (
            <Text as="p" tone="muted" size="small">No comments.</Text>
          )}
        </Stack>
      ) : null}
    </>
  );
}
