import type { HTMLAttributes } from "react";
import { Button, Chip, ListButton, Row, Stack, Text } from "wings-plugin-ui";

import type { PlainButtonProps } from "./layout";

/** An em space a level: the native app has no padding to give a row. */
const INDENT = " ";

export function Layout({ tag, className = "", children }: HTMLAttributes<HTMLElement> & { tag: string }) {
  const classes = className.split(" ");
  // The sprint's state bar: the legend under it says the same in words.
  if (classes.includes("bar")) return null;
  if (classes.includes("twisty-space")) return <Text>{INDENT}</Text>;
  if (classes.includes("item-row"))
    return (
      <Row gap="none">
        {classes.includes("child") ? <Text>{INDENT}</Text> : null}
        {children}
      </Row>
    );
  if (classes.includes("preview-child"))
    return (
      <Row gap="none">
        <Text>{INDENT}</Text>
        {children}
      </Row>
    );
  if (classes.includes("dots")) return <Row gap="xs" wrap>{children}</Row>;
  if (tag === "span" || tag === "p" || tag === "li") return <Text size={tag === "li" ? "small" : undefined} tone={classes.includes("muted") || classes.includes("id") ? "muted" : undefined}>{children}</Text>;
  return <Stack gap={classes.includes("rich") ? "s" : "xs"}>{children}</Stack>;
}

export function PlainButton({ className = "", onClick, disabled, children, ...props }: PlainButtonProps) {
  const classes = className.split(" ");
  if (classes.includes("step-dot"))
    return (
      <Chip pressed={classes.includes("current")} disabled={disabled} aria-label={props["aria-label"]} onClick={onClick}>
        {children}
      </Chip>
    );
  // A twisty or the image link: a small button.
  if (!classes.includes("link"))
    return (
      <Button variant="ghost" size="xs" disabled={disabled} aria-label={props["aria-label"]} onClick={onClick}>
        {children}
      </Button>
    );
  return (
    <ListButton disabled={disabled} title={props.title} onClick={onClick}>
      {children}
    </ListButton>
  );
}
