// Azure DevOps attachments, fetched by Wings with the token main keeps and shown as data URLs. A page can't load them
// itself: they need a sign-in its sandboxed frame doesn't have.

import { ch, TOKEN_SECRET } from "../lib/messages";

/** The attachments kept, newest last. They're base64 of up to 10 MB each. */
const KEEP = 24;
const kept = new Map<string, Promise<string | null>>();

async function fetchImage(url: string) {
  await ch.ask("image-auth");
  const res = await wings.fetch(url, { bearer: TOKEN_SECRET, binary: true });
  const type = res.contentType?.split(";")[0].trim() ?? "";
  return res.status === 200 && /^image\/[\w.+-]+$/.test(type) ? `data:${type};base64,${res.body}` : null;
}

/** The image as a data URL, or null when it can't be loaded. Each attachment is fetched once while it stays kept. */
export function loadImage(url: string) {
  let image = kept.get(url);
  if (!image) {
    image = fetchImage(url).catch(() => null);
    kept.set(url, image);
    void image.then((data) => data === null && kept.delete(url));
    if (kept.size > KEEP) kept.delete(kept.keys().next().value!);
  }
  return image;
}
