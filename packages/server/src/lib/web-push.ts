import { p256 } from "@noble/curves/p256";
/**
 * Web Push crypto — RFC 8291 (Message Encryption, `aes128gcm`) + VAPID (RFC 8292),
 * implemented in PURE JS on `@noble/curves/p256` + `@noble/hashes` and the
 * WebCrypto `crypto.subtle` AES-GCM primitive. No `web-push`, no `jose`, no
 * native module — a self-host requirement.
 *
 * Three concerns:
 *  1. {@link generateVapidKeys} — mint the provider's P-256 VAPID identity
 *     (uncompressed public key + raw scalar private key, base64url).
 *  2. {@link vapidAuthHeader} — build the per-request `Authorization: vapid …`
 *     header (an ES256 JWT, signature encoded as raw r||s per JOSE, NOT DER).
 *  3. {@link encryptPayload} — RFC 8291 §3.4 `aes128gcm` content encryption of a
 *     push payload to a subscription's `p256dh`/`auth` keys, gated byte-for-byte
 *     against the RFC 8291 §5 worked example in the unit tests.
 *
 * {@link buildPushRequest} assembles the `{url, headers, body}` a caller hands to
 * `fetch` to deliver one push (the caller owns the network + 410 cleanup).
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

// ---------------------------------------------------------------------------
// base64url helpers (unpadded, per RFC 7515 / RFC 8291)
// ---------------------------------------------------------------------------

/** Encode bytes as unpadded base64url. */
export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decode unpadded (or padded) base64url to bytes. */
export function b64urlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

const te = new TextEncoder();

// ---------------------------------------------------------------------------
// VAPID key generation
// ---------------------------------------------------------------------------

/** A VAPID (application-server) P-256 key pair, base64url-encoded. */
export interface VapidKeys {
  /** Uncompressed public key `0x04 || X || Y` (65 bytes), base64url. */
  readonly publicKey: string;
  /** Raw 32-byte private scalar, base64url. */
  readonly privateKey: string;
}

/**
 * Generate a fresh P-256 VAPID key pair. The public half is the 65-byte
 * uncompressed point (`applicationServerKey` the browser subscribes with); the
 * private half is the raw 32-byte scalar used to sign the VAPID JWT.
 */
export function generateVapidKeys(): VapidKeys {
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false); // uncompressed, 65 bytes
  return { publicKey: b64urlEncode(pub), privateKey: b64urlEncode(priv) };
}

// ---------------------------------------------------------------------------
// VAPID JWT (RFC 8292) — ES256, raw r||s signature (JOSE)
// ---------------------------------------------------------------------------

/** The scheme+host origin of an endpoint URL (the JWT `aud`, RFC 8292 §2). */
function endpointOrigin(endpoint: string): string {
  const u = new URL(endpoint);
  return `${u.protocol}//${u.host}`;
}

/**
 * Build a signed VAPID JWT (RFC 8292) for `endpoint`. ES256 over
 * `base64url(header).base64url(claims)`; the signature is the raw 64-byte r||s
 * concatenation JOSE mandates (NOT the ASN.1/DER form @noble emits by default).
 *
 * `subject` is the `sub` claim — an `https://…` or `mailto:` contact for the
 * application server. `exp` defaults to now + 12h (RFC 8292 caps it at 24h).
 */
export function vapidJwt(
  endpoint: string,
  vapidPrivateKeyB64url: string,
  subject: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: endpointOrigin(endpoint),
    exp: nowSeconds + 12 * 60 * 60,
    sub: subject,
  };
  const signingInput = `${b64urlEncode(te.encode(JSON.stringify(header)))}.${b64urlEncode(
    te.encode(JSON.stringify(claims)),
  )}`;
  const priv = b64urlDecode(vapidPrivateKeyB64url);
  // ES256 = ECDSA-P256 over SHA-256(signingInput). @noble's `prehash:false`
  // expects the message itself; we pass the SHA-256 digest explicitly so the
  // signature is over the hash (ES256). `toCompactRawBytes()` yields raw r||s.
  const digest = sha256(te.encode(signingInput));
  const sig = p256.sign(digest, priv, { prehash: false });
  const rawSig = sig.toCompactRawBytes(); // 64 bytes: r||s
  return `${signingInput}.${b64urlEncode(rawSig)}`;
}

/**
 * The full `Authorization` header value for a VAPID-authenticated push:
 * `vapid t=<JWT>, k=<vapidPublicKeyB64url>` (RFC 8292 §3, the single-header form).
 */
export function vapidAuthHeader(
  endpoint: string,
  vapidPublicKeyB64url: string,
  vapidPrivateKeyB64url: string,
  subject: string,
): string {
  const jwt = vapidJwt(endpoint, vapidPrivateKeyB64url, subject);
  return `vapid t=${jwt}, k=${vapidPublicKeyB64url}`;
}

// ---------------------------------------------------------------------------
// RFC 8291 aes128gcm content encryption
// ---------------------------------------------------------------------------

/** Concatenate byte arrays into one Uint8Array. */
function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A 32-bit big-endian length prefix (the `rs` field of the aes128gcm header). */
function uint32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

/** Record size advertised in the aes128gcm header (RFC 8188): one big record. */
const RECORD_SIZE = 4096;

/** Optional deterministic inputs (TEST ONLY) for gating against the RFC vector. */
export interface EncryptOverrides {
  /** Fixed ephemeral (sender) private scalar — RFC 8291 §5 reproducibility. */
  readonly ephemeralPrivateKey?: Uint8Array;
  /** Fixed 16-byte record salt — RFC 8291 §5 reproducibility. */
  readonly salt?: Uint8Array;
}

/** The encrypted body plus the inputs a caller may want to inspect/test. */
export interface EncryptedPayload {
  /** The full `aes128gcm` message: header || ciphertext (the HTTP body). */
  readonly body: Uint8Array;
  /** The 16-byte record salt used (random unless overridden). */
  readonly salt: Uint8Array;
  /** The ephemeral (sender) public key (65 bytes, uncompressed). */
  readonly ephemeralPublicKey: Uint8Array;
}

/**
 * Encrypt `payload` to a subscription's keys per RFC 8291 §3.4 (`aes128gcm`).
 *
 * Stages (RFC 8291 §3.4 — TWO HKDF layers):
 *  1. ECDH(ephemeralPriv, uaPublic) → 32-byte shared secret (the X coordinate).
 *  2. PRK = HKDF-SHA256(salt=authSecret, ikm=ecdhSecret,
 *           info="WebPush: info\0" || uaPublic || serverPublic, L=32).
 *  3. CEK   = HKDF-SHA256(salt=recordSalt, ikm=PRK,
 *           info="Content-Encoding: aes128gcm\0", L=16).
 *     nonce = HKDF-SHA256(salt=recordSalt, ikm=PRK,
 *           info="Content-Encoding: nonce\0",    L=12).
 *  4. plaintext record = payload || 0x02 (single-record delimiter), AES-128-GCM
 *     encrypted with CEK+nonce → ciphertext || 16-byte tag.
 *  5. body = [ salt(16) | rs(4 BE) | idlen(1)=65 | keyid(65)=serverPublic ]
 *           || ciphertext.
 *
 * `ua*` = user-agent (subscription) values; `server*` = the per-message
 * ephemeral key. Override `ephemeralPrivateKey`/`salt` ONLY for the RFC-vector
 * test (production always randomizes both).
 */
export async function encryptPayload(
  payload: Uint8Array,
  uaPublicKeyB64url: string,
  authSecretB64url: string,
  overrides: EncryptOverrides = {},
): Promise<EncryptedPayload> {
  const uaPublic = b64urlDecode(uaPublicKeyB64url); // 65-byte uncompressed point
  const authSecret = b64urlDecode(authSecretB64url); // 16 bytes

  const ephemeralPrivate = overrides.ephemeralPrivateKey ?? p256.utils.randomPrivateKey();
  const serverPublic = p256.getPublicKey(ephemeralPrivate, false); // 65 bytes
  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(16));

  // 1. ECDH → shared secret. @noble returns a 33-byte compressed point; the
  //    shared secret is its X coordinate (drop the 1-byte parity prefix).
  const ecdhPoint = p256.getSharedSecret(ephemeralPrivate, uaPublic);
  const ecdhSecret = ecdhPoint.slice(1); // 32-byte X coordinate

  // 2. PRK (keyed by the auth secret).
  const prkInfo = concat(te.encode("WebPush: info\0"), uaPublic, serverPublic);
  const prk = hkdf(sha256, ecdhSecret, authSecret, prkInfo, 32);

  // 3. CEK + nonce (keyed by the 16-byte record salt) — RFC 8188.
  const cek = hkdf(sha256, prk, salt, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(sha256, prk, salt, te.encode("Content-Encoding: nonce\0"), 12);

  // 4. plaintext record = payload || 0x02 delimiter, then AES-128-GCM.
  const record = concat(payload, new Uint8Array([0x02]));
  const key = await crypto.subtle.importKey(
    "raw",
    cek as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
    key,
    record as BufferSource,
  );
  const ciphertext = new Uint8Array(ctBuf);

  // 5. aes128gcm header || ciphertext.
  const header = concat(
    salt,
    uint32BE(RECORD_SIZE),
    new Uint8Array([serverPublic.length]),
    serverPublic,
  );
  const body = concat(header, ciphertext);

  return { body, salt, ephemeralPublicKey: serverPublic };
}

// ---------------------------------------------------------------------------
// Push request assembly
// ---------------------------------------------------------------------------

/** A browser PushSubscription's transport details (the parts the server needs). */
export interface PushSubscription {
  /** The push service endpoint URL the encrypted body is POSTed to. */
  readonly endpoint: string;
  /** The subscription's P-256 public key (`p256dh`), base64url. */
  readonly p256dh: string;
  /** The subscription's auth secret (`auth`), base64url. */
  readonly auth: string;
}

/** A ready-to-`fetch` push request (caller performs the network call). */
export interface PushRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

/** TTL (seconds) the push service should retain an undelivered message: 28 days. */
const PUSH_TTL_SECONDS = 2419200;

/**
 * Build the `{url, headers, body}` for one Web Push delivery: encrypt `payload`
 * to the subscription (RFC 8291) and attach the VAPID `Authorization` +
 * `aes128gcm` content headers (RFC 8291/8292). The caller does the `fetch` and
 * handles 410/404 (dead subscription) cleanup.
 */
export async function buildPushRequest(
  subscription: PushSubscription,
  payload: Uint8Array,
  vapidKeys: VapidKeys,
  subject: string,
): Promise<PushRequest> {
  const { body } = await encryptPayload(payload, subscription.p256dh, subscription.auth);
  const headers: Record<string, string> = {
    Authorization: vapidAuthHeader(
      subscription.endpoint,
      vapidKeys.publicKey,
      vapidKeys.privateKey,
      subject,
    ),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(PUSH_TTL_SECONDS),
    "Content-Length": String(body.length),
  };
  return { url: subscription.endpoint, headers, body };
}
