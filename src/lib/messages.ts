// What main and the sidebar say to each other. Both import `ch`.

import { channel } from "wings-plugin-sdk/messages";

import type { Published, Snapshot } from "./types";

/** The secret that holds the Azure DevOps token. Main stores it and `wings.fetch` sends it, so no page holds it. */
export const TOKEN_SECRET = "azure-devops";

export const ch = channel<
  // The sidebar asks main to have a fresh sign-in token stored before it fetches an image.
  { "image-auth": { request: void; response: void } },
  // The sidebar asks for the board to be read again.
  { refresh: void },
  {
    // What main knows: the phase, the settings and the last check without its board.
    state: { key: void; value: Published };
    // The board of the last check. It is a query of its own so a refresh that changes nothing on it sends none of it.
    board: { key: void; value: Snapshot | null };
  }
>();
