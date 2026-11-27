/**
 * The promote-lineage tag: an article promoted from a chat thread carries a
 * `promoted-from:#channel` tag, shown as a lineage badge rather than a topic.
 */

/** The tag prefix marking promote lineage. */
export const PROMOTE_TAG_PREFIX = "promoted-from:";

/** The channel an article was promoted from, if its tags say so. */
export function promotedFrom(tags: readonly string[] | undefined): string | undefined {
  const tag = tags?.find((t) => t.startsWith(PROMOTE_TAG_PREFIX));
  return tag ? tag.slice(PROMOTE_TAG_PREFIX.length) : undefined;
}

/** The topic tags, without the lineage marker. */
export function topicTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).filter((t) => !t.startsWith(PROMOTE_TAG_PREFIX));
}
