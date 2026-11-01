// Azure DevOps text as the item view draws it, with made-up content: a table, images and the rest of a comment.
// The stub has no `wings.fetch`, so the fixture answers it: the first attachment is a made-up picture, the second one fails.
import { Heading, Stack } from "wings-plugin-ui";
import "../src/pages/sidebar.css";
import { markdownText, richText } from "../src/ui/richText";

export const page = { place: "sidebar" } as const;

const picture = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAwIiBoZWlnaHQ9IjQwMCIgdmlld0JveD0iMCAwIDEyMDAgNDAwIj48cmVjdCB3aWR0aD0iMTIwMCIgaGVpZ2h0PSI0MDAiIGZpbGw9IiMyYjNhNTUiLz48cmVjdCB4PSI0MCIgeT0iNDAiIHdpZHRoPSIxMTIwIiBoZWlnaHQ9IjYwIiByeD0iOCIgZmlsbD0iIzRkN2NjNyIvPjxyZWN0IHg9IjQwIiB5PSIxMzAiIHdpZHRoPSI3MDAiIGhlaWdodD0iMzAiIHJ4PSI2IiBmaWxsPSIjOGFhNGQ2Ii8+PHJlY3QgeD0iNDAiIHk9IjE4MCIgd2lkdGg9IjUyMCIgaGVpZ2h0PSIzMCIgcng9IjYiIGZpbGw9IiM4YWE0ZDYiLz48Y2lyY2xlIGN4PSIxMDAwIiBjeT0iMjYwIiByPSI4MCIgZmlsbD0iI2UwYjM0MSIvPjwvc3ZnPg==";
const fetchStub = async (url: string) =>
  url.endsWith("0002?fileName=image.png") ? { status: 404, contentType: "application/json", body: "" } : { status: 200, contentType: "image/svg+xml", body: picture };


const table = `## Plan

An **index** per operation, see [the item](https://dev.azure.com/example/Web/_workitems/edit/12).

| Operation | Kind | Purpose | Serves |
| ---------- | :-----: | -------: | ------ |
| \`list\` | read | Show every \`row\` | #123 |
| \`save\` | write | Keep one \\| row | #124 |
| \`synchronize\` | read | Reads every remote record and merges the differences into the local copy | #125, #126 |

- after the table
![Screenshot](https://dev.azure.com/example/00000000-0000-0000-0000-000000000000/_apis/wit/attachments/00000000-0000-0000-0000-000000000001?fileName=image.png)`;

const html = `<div>The page after sign-in:</div><img src="https://dev.azure.com/example/00000000-0000-0000-0000-000000000000/_apis/wit/attachments/00000000-0000-0000-0000-000000000001?fileName=image.png" alt="Image"><div>and <img src="https://example.com/a.png"> elsewhere.</div><div>One that can't load: <img src="https://dev.azure.com/example/00000000-0000-0000-0000-000000000000/_apis/wit/attachments/00000000-0000-0000-0000-000000000002?fileName=image.png"></div>`;

export const answers = { "image-auth": () => undefined };

export default function Rich() {
  (window as unknown as { wings: { fetch: typeof fetchStub } }).wings.fetch = fetchStub;
  return (
    <Stack gap="m">
      <Stack as="section" gap="s" className="detail-section"><Heading>Description</Heading>{richText(html)}</Stack>
      <Stack as="section" gap="s" className="detail-section"><Heading>Discussion</Heading>{markdownText(table)}</Stack>
    </Stack>
  );
}
