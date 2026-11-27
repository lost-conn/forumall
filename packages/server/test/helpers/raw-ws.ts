/**
 * A minimal WebSocket client over a raw TCP socket (RFC 6455), for tests that
 * must control the upgrade request's headers exactly, such as a browser's
 * `Origin`. (Bun's `WebSocket` accepts `{ headers }`, but with `lib.dom` in the
 * compile, bun-types defers to the DOM constructor type, which has no such
 * option.) Text frames only; enough for the OFSCP JSON envelope.
 */
import { randomBytes } from "node:crypto";
import { type WsEnvelope, WsEnvelopeSchema } from "@forumall/shared";

import { at } from "./at.ts";

/** The `Sec-WebSocket-Accept` GUID (RFC 6455 §1.3). */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface RawUpgrade {
  /** The status line's code (`101` when the upgrade was accepted). */
  readonly status: number;
  /** Response header fields, lower-cased names. */
  readonly headers: ReadonlyMap<string, string>;
  /** Whether `Sec-WebSocket-Accept` is the RFC 6455 digest of our key. */
  readonly acceptValid: boolean;
}

/** Encode one masked client text frame (RFC 6455 §5.2; clients must mask). */
function encodeTextFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const len = payload.length;
  const header =
    len < 126
      ? Uint8Array.of(0x81, 0x80 | len)
      : len < 0x10000
        ? Uint8Array.of(0x81, 0x80 | 126, len >> 8, len & 0xff)
        : null;
  if (header === null) throw new RangeError("test frames are under 64 KiB");
  const mask = randomBytes(4);
  const frame = new Uint8Array(header.length + 4 + len);
  frame.set(header, 0);
  frame.set(mask, header.length);
  const off = header.length + 4;
  for (let i = 0; i < len; i++) frame[off + i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
  return frame;
}

/**
 * Decode the complete unmasked server frames at the start of `buf`; returns
 * the text payloads and how many bytes they used.
 */
function decodeFrames(buf: Uint8Array): { texts: string[]; used: number } {
  const texts: string[] = [];
  let pos = 0;
  while (buf.length - pos >= 2) {
    const opcode = (buf[pos] ?? 0) & 0x0f;
    let len = (buf[pos + 1] ?? 0) & 0x7f;
    let head = 2;
    if (len === 126) {
      if (buf.length - pos < 4) break;
      len = ((buf[pos + 2] ?? 0) << 8) | (buf[pos + 3] ?? 0);
      head = 4;
    } else if (len === 127) {
      if (buf.length - pos < 10) break;
      len = Number(new DataView(buf.buffer, buf.byteOffset + pos + 2, 8).getBigUint64(0));
      head = 10;
    }
    if (buf.length - pos < head + len) break;
    if (opcode === 0x1) {
      texts.push(new TextDecoder().decode(buf.subarray(pos + head, pos + head + len)));
    }
    pos += head + len;
  }
  return { texts, used: pos };
}

/** A WebSocket connection made over a raw socket with chosen upgrade headers. */
export class RawWsClient {
  private buffered = new Uint8Array(0);
  private frames: WsEnvelope[] = [];
  private wake: (() => void) | null = null;
  /** Why no further frames can arrive (a bad frame, or the socket ended); `ofType` rethrows it. */
  private failure: Error | null = null;

  private constructor(
    private readonly socket: Bun.Socket<undefined>,
    readonly upgrade: RawUpgrade,
  ) {}

  /**
   * Open `ws://host:port{path}` sending `headers` with the upgrade request.
   * Resolves once the response head arrives, whatever its status; rejects if
   * the socket closes, errors or fails to connect before it does.
   */
  static async open(
    host: string,
    port: number,
    path: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<RawWsClient> {
    const key = randomBytes(16).toString("base64");
    const expectedAccept = new Bun.CryptoHasher("sha1").update(key + WS_GUID).digest("base64");
    let client: RawWsClient | undefined;
    let pending = new Uint8Array(0);
    let resolveOpen: (c: RawWsClient) => void = () => {};
    let rejectOpen: (err: Error) => void = () => {};
    const opened = new Promise<RawWsClient>((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    /** End the connection with `err`: fails `open()` before the head, `ofType` after. */
    const fail = (err: Error): void => {
      if (client) client.fail(err);
      else rejectOpen(err);
    };

    const socket = await Bun.connect({
      hostname: host,
      port,
      socket: {
        data(sock, chunk) {
          if (client) {
            client.receive(chunk);
            return;
          }
          pending = concat(pending, chunk);
          const end = indexOfHeadEnd(pending);
          if (end === -1) return;
          const lines = new TextDecoder().decode(pending.subarray(0, end)).split("\r\n");
          const status = Number(lines[0]?.split(" ")[1]);
          const fields = new Map<string, string>();
          for (const line of lines.slice(1)) {
            const colon = line.indexOf(":");
            if (colon > 0)
              fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
          }
          client = new RawWsClient(sock, {
            status,
            headers: fields,
            acceptValid: fields.get("sec-websocket-accept") === expectedAccept,
          });
          resolveOpen(client);
          client.receive(pending.subarray(end + 4));
        },
        close(_sock, err) {
          fail(
            new Error(
              `raw WS ${path}: socket closed${client ? "" : " before the response head"}` +
                (err ? `: ${err.message}` : ""),
            ),
          );
        },
        error(_sock, err) {
          fail(new Error(`raw WS ${path}: socket error: ${err.message}`));
        },
        connectError(_sock, err) {
          fail(new Error(`raw WS ${path}: connect failed: ${err.message}`));
        },
      },
    });

    const extra = Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
    );
    return opened;
  }

  /**
   * Buffer `chunk` and queue every complete text frame. A frame that is not a
   * valid envelope ends the client: the error is kept for the waiting (or
   * next) `ofType` rather than thrown into the socket callback, where no test
   * would see it.
   */
  private receive(chunk: Uint8Array): void {
    if (this.failure) return;
    this.buffered = concat(this.buffered, chunk);
    const { texts, used } = decodeFrames(this.buffered);
    this.buffered = this.buffered.slice(used);
    for (const t of texts) {
      try {
        this.frames.push(WsEnvelopeSchema.parse(JSON.parse(t)));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.fail(
          new Error(`raw WS: received a frame that is not a valid envelope: ${t}\n${reason}`),
        );
        return;
      }
    }
    if (texts.length > 0) this.wake?.();
  }

  /** Record the first reason no more frames will arrive, and wake a waiting `ofType`. */
  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.wake?.();
  }

  /** Send one JSON text frame. */
  send(frame: Record<string, unknown>): void {
    this.socket.write(encodeTextFrame(JSON.stringify(frame)));
  }

  /** The next received frame of `type` (earlier frames of other types are kept). */
  async ofType(type: string, timeoutMs = 2000): Promise<WsEnvelope> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.frames.findIndex((f) => f.type === type);
      if (i !== -1) return at(this.frames.splice(i, 1), 0);
      if (this.failure) throw new Error(`waiting for ${type}: ${this.failure.message}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${type}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  close(): void {
    this.socket.end();
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Index of the `\r\n\r\n` ending an HTTP response head, or -1. */
function indexOfHeadEnd(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}
