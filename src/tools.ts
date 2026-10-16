// The tool Claude gets. The build writes it into the manifest's mcpTools.

import { tool } from "wings-plugin-sdk/tools";

import { boardText } from "./main/run";

export const tools = {
  board_check: tool({
    description:
      "Checks the team's current Azure DevOps sprint board read-only and returns the hygiene findings, each with a proposed fix, then who on the team is working on what and who is blocked with only lower-priority work left. Changes nothing.",
    run: () => boardText(),
  }),
};
