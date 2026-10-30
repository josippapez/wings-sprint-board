// The token Azure DevOps images are fetched with. `az` gives main one; main keeps it as a Wings secret, which
// `wings.fetch` sends as the bearer and nothing can read back, so it never reaches a page.

import { azCli } from "../lib/azure";
import { TOKEN_SECRET } from "../lib/messages";

/** The Azure DevOps application id, which the token is for. */
const RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
/** A token with less than this left is replaced. */
const MARGIN_MS = 5 * 60_000;

let expiresAt = 0;
let pending: Promise<void> | null = null;

async function store() {
  const token = await azCli.json<{ accessToken: string; expires_on?: number; expiresOn?: string } | null>(
    ["account", "get-access-token", "--resource", RESOURCE, "-o", "json"],
    { timeoutMs: 30_000, empty: null },
  );
  if (!token?.accessToken) throw new Error("az gave no token");
  await wings.secrets.set(TOKEN_SECRET, token.accessToken);
  // `expires_on` is epoch seconds (az 2.54 and later); `expiresOn` is a local time.
  expiresAt = typeof token.expires_on === "number" ? token.expires_on * 1000 : Date.parse(token.expiresOn ?? "") || Date.now() + 30 * 60_000;
}

/** Makes sure the stored token has time left, getting a new one when it hasn't. Calls during a refresh join it. */
export function ensureToken() {
  if (Date.now() < expiresAt - MARGIN_MS) return Promise.resolve();
  pending ??= store().finally(() => (pending = null));
  return pending;
}
