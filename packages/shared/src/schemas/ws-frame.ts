/**
 * Internal builder for concrete OFSCP WS frame schemas. Not re-exported from
 * the package barrel.
 */
import { z } from "zod";

import { JsonValueSchema, Rfc3339DateTimeSchema } from "./common.ts";

/**
 * Build a concrete frame schema: the envelope fields, a literal `type`, and a
 * specific `data` shape. Stays `.passthrough()` so unknown top-level keys (and,
 * because the `data` schemas are themselves passthrough, unknown data keys) are
 * preserved.
 */
export function wsFrame<T extends z.ZodTypeAny>(type: string, data: T) {
  return z
    .object({
      id: z.string().min(1),
      type: z.literal(type),
      ts: Rfc3339DateTimeSchema,
      correlationId: z.string().min(1).optional(),
      data,
    })
    .passthrough();
}

/** A frame whose `data` may be absent or an empty object (ping/pong). */
export const emptyData = JsonValueSchema.optional();
