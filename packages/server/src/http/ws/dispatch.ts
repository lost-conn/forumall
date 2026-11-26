/**
 * Inbound frame decoding and command routing (§7.1 *WebSocket message
 * envelope*, *WebSocket message types*; §2.3).
 *
 * A frame is decoded only as far as routing needs — its `id` and `type`. Each
 * command handler then validates the whole frame against its own command
 * schema (`ws/command-envelope.json`: `ts` optional and ignored, `data` an
 * object), so a malformed `data` is answered `bad_request` correlated to the
 * command's `id`.
 *
 * Routing after authentication:
 *  - a standard command with a handler → the handler;
 *  - a standard command this provider does not support → `bad_request`
 *    (silently ignoring it would leave the client waiting for a reply);
 *  - any other `type` → ignored (§2.3).
 */
import { WsCommandTypeSchema } from "@forumall/shared";
import type { CommandHandler } from "./connection.ts";

/** The decoded routing fields of an inbound frame. */
export type InboundFrame =
  | { readonly kind: "invalid_json" }
  | {
      readonly kind: "frame";
      /** The parsed JSON, handed to the command handler to validate. */
      readonly json: unknown;
      /** The frame's `id`, when it is a non-empty string. */
      readonly id: string | undefined;
      /** The frame's `type`, when it is a non-empty string. */
      readonly type: string | undefined;
    };

/** Decode a WebSocket message payload (text or binary UTF-8 JSON). */
export function decodeFrame(data: unknown): InboundFrame {
  const text =
    typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : String(data);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid_json" };
  }
  const obj =
    typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  return { kind: "frame", json, id: nonEmptyString(obj.id), type: nonEmptyString(obj.type) };
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const STANDARD_COMMANDS: ReadonlySet<string> = new Set(WsCommandTypeSchema.options);

/** True iff `type` is one of the standard client→server commands of §7.1. */
export function isStandardCommand(type: string): boolean {
  return STANDARD_COMMANDS.has(type);
}

/** Where an authenticated connection's command goes. */
export type CommandRoute =
  | { readonly kind: "handler"; readonly handler: CommandHandler }
  | { readonly kind: "unsupported" }
  | { readonly kind: "ignore" };

/** Route an authenticated connection's command `type` through `table`. */
export function routeCommand(
  type: string,
  table: Readonly<Partial<Record<string, CommandHandler>>>,
): CommandRoute {
  const handler = Object.hasOwn(table, type) ? table[type] : undefined;
  if (handler) return { kind: "handler", handler };
  return isStandardCommand(type) ? { kind: "unsupported" } : { kind: "ignore" };
}
