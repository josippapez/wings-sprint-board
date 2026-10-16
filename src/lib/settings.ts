import { setting } from "wings-plugin-sdk/settings";

/** Settings start empty or with neutral defaults. Empty lists and fields turn their check off. */
export const DEFAULTS = {
  org: "",
  project: "",
  team: "",
  /** Empty uses the team's areas. */
  areaPath: "",
  members: [] as string[],
  storyTypes: ["User Story", "Product Backlog Item"],
  /** A story is in scope when it has a child of one of these types. Empty puts every story in scope. */
  scopeChildTypes: ["Task"],
  /** Children of an in-scope story that are checked too. */
  childTypes: ["Task", "Bug"],
  /** Other sprint items in scope when assigned to a team member or titled with one of the prefixes. */
  itemTypes: ["Bug"],
  titlePrefixes: [] as string[],
  codeReviewStates: ["Code Review", "In Code Review"],
  blockedByField: "",
  goalTag: "",
  addedTags: [] as string[],
  pointTypes: [] as string[],
  pointFields: ["Microsoft.VSTS.Scheduling.StoryPoints"],
  parkedPrPrefix: "",
  staleDays: 3,
};

export type Settings = typeof DEFAULTS;

/** What the settings steps save. Main reads it and hears it change, and the sidebar writes it. */
export const savedSettings = setting<Settings>("settings", {
  default: DEFAULTS,
  check: (value) => (value && typeof value === "object" && !Array.isArray(value) ? { ...DEFAULTS, ...value } : undefined),
});

/** What's still missing before a check can run. */
export const missingSettings = (s: Settings) =>
  [["Organization", s.org], ["Project", s.project], ["Team", s.team], ["Team members", s.members.length ? "x" : ""]]
    .filter(([, v]) => !String(v).trim())
    .map(([name]) => name);

const REF_NAME = /^[A-Za-z][\w.]*$/;

/** Throws when a setting would break a query, since they go into WIQL and az arguments. */
export function validate(s: Settings) {
  if (!/^https:\/\/dev\.azure\.com\/[\w.-]+\/?$/.test(s.org)) throw new Error("Organization must look like https://dev.azure.com/<name>.");
  for (const field of [s.blockedByField, ...s.pointFields].filter(Boolean)) {
    if (!REF_NAME.test(field)) throw new Error(`"${field}" isn't a field reference name like Custom.MyField.`);
  }
  for (const [name, value] of Object.entries({ project: s.project, team: s.team, areaPath: s.areaPath })) {
    // Wings refuses az arguments starting with "-" or "@".
    if (/^[-@]/.test(value)) throw new Error(`${name} can't start with - or @.`);
  }
}

export const org = (s: Settings) => s.org.replace(/\/+$/, "");
export const itemUrl = (s: Settings, id: number) => `${org(s)}/${encodeURIComponent(s.project)}/_workitems/edit/${id}`;
export const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
export const list = (values: string[]) => values.map(quote).join(", ");
export const lower = (values: string[]) => values.map((v) => v.toLowerCase());
