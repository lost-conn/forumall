/**
 * Shared timestamp formatting helpers.
 *
 * `formatTime` (HH:MM) was previously copy-pasted byte-for-byte into ChatView,
 * DmsPage, HomeFeed, and ArticleReadingPane; `formatFullTime` lived only in
 * DmsPage. Both tolerate `undefined`/unparseable input by returning "".
 */

/** Short clock time, e.g. "14:05" — used for message/feed-item timestamps. */
export function formatTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Localized full date + time, e.g. for hover tooltips on a DM timestamp. */
export function formatFullTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}
