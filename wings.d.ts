// Types for the Wings plugin SDK, API 1. `window.wings` exists in every plugin; this file only helps your editor.
// Add `// @ts-check` and `/// <reference path="./wings.d.ts" />` at the top of main.js to use it.

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "merged";

interface WingsPane {
  paneId: string;
  /** Follows `cd` in the pane. */
  cwd: string;
  /** What runs in the pane right now, like `zsh` or `claude`. */
  command: string;
  project: string;
  /** Set while Claude Code runs in the pane. `startedAt` is when that `claude` started, in ms; a resumed session's transcript also has what came before. */
  session: { sessionId: string; name: string | null; state: string; startedAt: number } | null;
}

interface WingsTranscriptEvent {
  sessionId: string;
  /** The pane the session runs in. */
  paneId: string;
  /** The entry as Claude Code wrote it. Its `type` is one of `permissions.transcript`. */
  entry: { type: string } & Record<string, unknown>;
}

interface WingsBadge {
  label: string;
  tone: Tone;
  icon?: "pr-open" | "pr-merged" | "pr-closed" | "pr-draft";
  /** Small icon-and-number chips after the label. Leave out zeros. */
  counts?: { icon: "changed" | "push" | "pull"; value: number }[];
  /** Shows a spinner in the pill. */
  loading?: boolean;
  title?: string;
  subtitle?: string;
  rows?: { label: string; value: string; tone?: Tone }[];
  actions?: { id: string; label: string; primary?: boolean }[];
}

interface WingsComment {
  id: number;
  replyTo: number | null;
  /** `null` for a comment on the whole change. */
  path: string | null;
  /** `null` when the comment no longer matches the diff. */
  line: number | null;
  side: "additions" | "deletions";
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

/** A usage limit window. `resetsAt` is in Unix epoch seconds. */
interface WingsLimitWindow {
  usedPercentage: number;
  resetsAt: number | null;
}

/** What Claude Code last told `wings statusline`. `at` is when Wings got it, in ms. */
interface WingsStatusline {
  /** Your account's 5-hour and weekly limits, from the newest session that reported them. `null` until one has. */
  rateLimits: { fiveHour: WingsLimitWindow | null; sevenDay: WingsLimitWindow | null; at: number } | null;
  /** By session id. Token counts are from the session's last API response. */
  sessions: Record<
    string,
    {
      /** Like `Opus 5.5 (1M context)`. */
      model: string | null;
      contextWindowSize: number | null;
      usedPercentage: number | null;
      totalInputTokens: number | null;
      totalOutputTokens: number | null;
      currentUsage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number } | null;
      /** `expiresAt` is in Unix epoch seconds. */
      promptCache: { warm: boolean; ttl: "5m" | "1h" | null; expiresAt: number | null } | null;
      at: number;
    }
  >;
}

interface WingsExecOptions {
  cwd?: string;
  /** 30 s by default, 5 min at most. */
  timeoutMs?: number;
  /** Gets each stdout and stderr line while the program runs. */
  onOutput?: (line: string) => void;
}

interface Wings {
  /** Every terminal pane, on every change. */
  onPanes(listener: (panes: WingsPane[]) => void): void;
  /** A badge action was clicked. Return a promise: the button spins until it settles, and a thrown error shows in the card. */
  onAction(listener: (action: { paneId: string; actionId: string }) => void | Promise<void>): void;
  /**
   * Handles Claude's calls to a tool in `contributes.mcpTools`. Return a string or a JSON value; a thrown error
   * is sent back as a failed call. `paneId` is the Wings pane Claude runs in, or `null`. Register it in `main`.
   */
  onTool(name: string, handler: (input: Record<string, unknown>, context: { paneId: string | null }) => unknown): void;
  /** Runs a command from `permissions.exec`, like `git branch --show-current`. */
  exec(program: string, args?: string[], options?: WingsExecOptions): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /**
   * Needs `permissions.statusline`. What Claude Code last told its status line, once `wings statusline` is your
   * `statusLine` command: usage limits and each session's context and cache, as Claude Code reports them.
   */
  statusline(): Promise<WingsStatusline>;
  /** Claude Code transcript entries of types in `permissions.transcript`, oldest first. */
  transcript(sessionId: string, types: string[], options?: { last?: number }): Promise<Record<string, unknown>[]>;
  /**
   * Each transcript entry Claude Code writes while it runs in a pane, for the types in `permissions.transcript`.
   * Only entries written after the plugin started, or after the session started in the pane; `transcript` reads
   * earlier ones. Entries over 256 KB are skipped.
   */
  onTranscript(listener: (event: WingsTranscriptEvent) => void): void;
  /** Needs `"badges"` in `contributes.ui`. `null` removes it. */
  setBadge(paneId: string, badge: WingsBadge | null): Promise<void>;
  /** Opens an https URL that starts with a prefix in `permissions.openUrl`. */
  openUrl(url: string): Promise<void>;
  /**
   * Needs `permissions.panes`. Opens a terminal in a new tab, or a split beside the focused pane, and resolves
   * once the pane is in `onPanes`. `command`, like `"npm run dev"`, is typed into its shell and must start with
   * an entry of `permissions.panes`. `cwd` must be inside one of your projects; without it the pane opens at the
   * root of the project on screen.
   */
  openPane(options?: { command?: string; cwd?: string; placement?: "tab" | "right" | "down" }): Promise<{ paneId: string }>;
  /** Needs `permissions.panes`. Shows an open pane and moves the keyboard to it. */
  focusPane(paneId: string): Promise<void>;
  /** Needs `permissions.notify`. A desktop notification, up to 3 a minute. The title is cut at 64 characters, the body at 256. */
  notify(notification: { title: string; body?: string }): Promise<void>;
  /** Needs `"diff"` in `contributes.ui`. Leave out `patch` to open it loading, then call `updateDiff`. */
  openDiff(diff: { title: string; subtitle?: string; patch?: string; comments?: WingsComment[] }): Promise<{ id: string }>;
  updateDiff(id: string, update: { patch: string; comments?: WingsComment[] } | { error: string }): Promise<void>;
  /**
   * An HTTP request to a URL under `permissions.fetch`, made by Wings. `bearer` names a secret that Wings sends
   * as `Authorization: Bearer <secret>`. Resolves for any status; redirects aren't followed.
   */
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; bearer?: string },
  ): Promise<{ status: number; contentType: string | null; body: string }>;
  /** Secrets, like API tokens, in the system keychain. `fetch` can send them, but they can't be read back. */
  secrets: {
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
    has(name: string): Promise<boolean>;
  };
  /**
   * The plugin's own storage for settings and state, since `localStorage` throws in plugin pages. Values are
   * JSON. Keys are 1 to 128 letters, digits and `- _ . : /`, and it holds 1 MB in all. Only this plugin sees it.
   */
  storage: {
    /** The value, or `null` when the key isn't set. */
    get(key: string): Promise<unknown>;
    /** Refused if it would take the plugin's storage over 1 MB. */
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    /** Every key, sorted. */
    keys(): Promise<string[]>;
  };
  /** Short text next to a sidebar's title bar button, like a running timer. `null` clears it. */
  setSidebarLabel(sidebarId: string, label: string | null, options?: { rows?: { label: string; value: string }[]; tone?: "warning" | "danger" }): Promise<void>;
  /** Sends a JSON value, up to 64 KB, to the plugin's other pages: its main script and open sidebars. */
  broadcast(message: unknown): Promise<void>;
  /** Gets what the plugin's other pages send with `broadcast`. */
  onBroadcast(listener: (message: unknown) => void): void;
}

declare const wings: Wings;
