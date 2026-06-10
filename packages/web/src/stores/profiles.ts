/**
 * Profile-name cache (Overboard "Display name in chat"). A reactive,
 * client-side cache of `UserProfile.displayName` keyed by full actor
 * (`handle@domain`), so every chat/DM/member surface can render a user's
 * GLOBAL display name (falling back to the handle local-part) without each view
 * re-fetching the profile.
 *
 * Federation-aware: a remote actor's profile is fetched from THEIR home provider
 * via a per-host signing client (`clientForHost`), exactly like
 * {@link UserProfileCard}. Local actors use the session's home client.
 *
 * No protocol/schema change: this consults the existing `/api/users/{ref}/profile`
 * surface (§6.3) via {@link fetchProfile}. Fetches are deduplicated (one in-flight
 * request per actor; cached/pending actors are not refetched) and failures are
 * non-fatal — an actor that can't be resolved simply keeps its local-part name.
 */
import { createStore } from "solid-js/store";
import { clientForHost, domainOf, isLocalActor } from "../lib/federation.ts";
import { keyStore } from "../lib/key-store.ts";
import type { OfscpClient } from "../lib/ofscp-client.ts";
import { fetchProfile } from "../lib/social-api.ts";
import { session, sessionClient } from "./session.ts";

/** Local-part of an actor `handle@domain` (full actor as a fallback). */
export function localPart(actor: string): string {
  const at = actor.indexOf("@");
  return at > 0 ? actor.slice(0, at) : actor;
}

interface CachedProfile {
  /** The resolved global display name, or undefined when the user has none. */
  displayName?: string;
}

interface ProfilesStore {
  /** Resolved profiles by canonical actor (`handle@domain`). */
  byActor: Record<string, CachedProfile>;
}

const [profiles, setProfiles] = createStore<ProfilesStore>({ byActor: {} });

/** In-flight fetches, so we never fire two requests for the same actor. */
const inflight = new Map<string, Promise<void>>();

/** Build a signing client targeting `actor`'s home provider (home or remote). */
async function clientForActor(actor: string): Promise<OfscpClient | null> {
  const home = session.host;
  const me = session.actor;
  const keyId = session.keyId;
  if (!home || !me || !keyId) return null;
  if (isLocalActor(actor, home)) return sessionClient();
  const targetHost = domainOf(actor);
  if (!targetHost) return null;
  const privateKey = await keyStore.getKey(keyId);
  if (!privateKey) return null;
  return clientForHost(targetHost, { actor: me, keyId, privateKey });
}

/**
 * Fetch + cache `actor`'s profile if it isn't already cached or in-flight.
 * Resolves quietly on failure (the actor keeps its local-part name).
 */
async function fetchInto(actor: string): Promise<void> {
  try {
    const client = await clientForActor(actor);
    if (!client) return;
    const prof = await fetchProfile(client, actor);
    setProfiles("byActor", actor, {
      ...(prof.displayName !== undefined ? { displayName: prof.displayName } : {}),
    });
  } catch {
    // Non-fatal: leave the actor unresolved; callers fall back to the local-part.
  }
}

/**
 * Ensure `actor`'s profile is cached (fires at most one fetch per actor). Safe to
 * call repeatedly and from render — a cached or in-flight actor is a no-op.
 */
export function warmProfile(actor: string): void {
  if (!actor || actor.length === 0) return;
  if (actor in profiles.byActor || inflight.has(actor)) return;
  const p = fetchInto(actor).finally(() => inflight.delete(actor));
  inflight.set(actor, p);
}

/** Warm a batch of actors (de-duped), e.g. the authors of the loaded messages. */
export function warmProfiles(actors: Iterable<string>): void {
  for (const a of actors) warmProfile(a);
}

/**
 * Reactive display name for `actor`: the cached global `displayName` when set,
 * else the handle local-part. Reading this in a component subscribes to the
 * cache so the name swaps in once the profile resolves.
 */
export function displayNameFor(actor: string): string {
  return profiles.byActor[actor]?.displayName || localPart(actor);
}

/** Reset the cache (logout). */
export function clearProfiles(): void {
  inflight.clear();
  setProfiles({ byActor: {} });
}
