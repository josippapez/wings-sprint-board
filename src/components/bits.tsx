// Small pieces every view of the sidebar draws.

import { Dot, Spinner, Text } from "wings-plugin-ui";

export const spinner = () => <Spinner size="large" />;

/** An error the page shows in a line of its own. */
export const errorLine = (text: string, key?: string) => (
  <Text key={key} as="p" tone="danger" size="small" role="alert" className="wrap">
    {text}
  </Text>
);

/** A work item type's colour, as Azure Boards shows it. */
export const dot = (color: string, title?: string) => <Dot color={/^#[0-9a-f]{6}$/i.test(color) ? color : "#888888"} title={title} />;

/** Initials in a circle whose colour comes from the name. */
export function avatar(name: string | null) {
  if (!name) return <span className="avatar empty" title="Unassigned">–</span>;
  const initials = name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return <span className="avatar" style={{ background: `hsl(${Math.abs(hash) % 360} 45% 38%)` }} title={name}>{initials}</span>;
}

export function icon(d: string) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
export const CARET = "M4.5 3L7.5 6L4.5 9";
