// Azure DevOps text as the item view draws it, with made-up content: a table, an image and the rest of a comment.
import { Heading, Stack } from "wings-plugin-ui";
import "../src/pages/sidebar.css";
import { markdownText, richText } from "../src/ui/richText";

export const page = { place: "sidebar" } as const;

const table = `## Plan

An **index** per operation, see [the item](https://dev.azure.com/example/Web/_workitems/edit/12).

| Operation | Kind | Purpose | Serves |
| ---------- | :-----: | -------: | ------ |
| \`list\` | read | Show every \`row\` | #123 |
| \`save\` | write | Keep one \\| row | #124 |

- after the table
![Screenshot](https://dev.azure.com/example/00000000-0000-0000-0000-000000000000/_apis/wit/attachments/00000000-0000-0000-0000-000000000001?fileName=image.png)`;

const html = `<div>The page after sign-in:</div><img src="https://dev.azure.com/example/00000000-0000-0000-0000-000000000000/_apis/wit/attachments/00000000-0000-0000-0000-000000000001?fileName=image.png" alt="Image"><div>and <img src="https://example.com/a.png"> elsewhere.</div>`;

export default function Rich() {
  return (
    <Stack gap="m">
      <Stack as="section" gap="s" className="detail-section"><Heading>Description</Heading>{richText(html)}</Stack>
      <Stack as="section" gap="s" className="detail-section"><Heading>Discussion</Heading>{markdownText(table)}</Stack>
    </Stack>
  );
}
