/** "7 Oct" from an ISO date, read as a calendar day. */
export const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(iso)) : "?");
export const time = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** "5m ago", "3h ago", "2d ago", or the date. */
export function ago(iso: string) {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  if (m < 60 * 24 * 7) return `${Math.round(m / 1440)}d ago`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}
