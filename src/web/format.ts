export { formatCents, parseDollars } from "../money";

const dateTime = new Intl.DateTimeFormat("en-CA", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Sat, Nov 14, 2:00 p.m." in the reader's own time zone. */
export const formatTime = (epochMs: number): string => dateTime.format(new Date(epochMs));

/** The value a <input type="datetime-local"> expects, for a moment `hours` from now. */
export function localInputValue(hoursFromNow: number): string {
  const date = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
