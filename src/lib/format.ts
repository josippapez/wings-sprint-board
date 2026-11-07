// The native app's JS engine has no Intl, so there dates are written out by hand, as en-GB writes them, and times as 24-hour HH:MM.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "7 Oct" from an ISO date, read as a calendar day. */
export const day = (iso: string | null) => {
  if (!iso) return "?";
  const at = new Date(iso);
  return WINGS_NATIVE ? `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}` : new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(at);
};
export const time = (iso: string) => {
  const at = new Date(iso);
  return WINGS_NATIVE ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(at);
};

/** "5m ago", "3h ago", "2d ago", or the date. */
export function ago(iso: string) {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  if (m < 60 * 24 * 7) return `${Math.round(m / 1440)}d ago`;
  const at = new Date(iso);
  return WINGS_NATIVE ? `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}` : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(at);
}
