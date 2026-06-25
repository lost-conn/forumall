/**
 * UserProfileCard (P-overboard, §5.1/§6/§7.5) — a global modal showing a user's
 * profile, presence, and contact/DM actions. Mounted once at the app root and
 * driven by {@link profileActor}; opened from anywhere via {@link openUserProfile}
 * (e.g. clicking a chat author, a contact, or a DM header).
 *
 * Federation-aware: a remote actor's profile/presence are fetched from THEIR home
 * provider via a per-host signing client (`clientForHost`), exactly like the
 * contacts/DM cards. Local actors use the session's home client.
 */
import { deriveDmId } from "@forumall/shared";
import { useNavigate } from "@solidjs/router";
import {
  type Component,
  Match,
  Show,
  Switch,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import { clientForHost, domainOf, isLocalActor } from "../../lib/federation.ts";
import { keyStore } from "../../lib/key-store.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
import { OfscpHttpError } from "../../lib/ofscp-client.ts";
import {
  type ContactMirrorAction,
  fetchContacts,
  fetchPresence,
  fetchProfile,
  mirrorContactEvent,
  requestContact,
} from "../../lib/social-api.ts";
import { upsertConversation } from "../../stores/dms.ts";
import { refreshPresenceSnapshots, subscribePresence } from "../../stores/presence-controller.ts";
import { setPresenceFor } from "../../stores/presence.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { Modal } from "../shared/Modal.tsx";
import { PresenceDot } from "./PresenceDot.tsx";
import { closeUserProfile, profileActor } from "./user-profile-store.ts";

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

async function mirrorIfRemote(action: ContactMirrorAction, counterparty: string): Promise<void> {
  const home = session.host;
  const me = session.actor;
  const keyId = session.keyId;
  if (!home || !me || !keyId) return;
  if (isLocalActor(counterparty, home)) return;
  const targetHost = domainOf(counterparty);
  if (!targetHost) return;
  const privateKey = await keyStore.getKey(keyId);
  if (!privateKey) return;
  await mirrorContactEvent(
    clientForHost(targetHost, { actor: me, keyId, privateKey }),
    action,
    me,
    counterparty,
  );
}

function errorOf(err: unknown, fallback: string): string {
  if (err instanceof OfscpHttpError) {
    const body = err.body as { detail?: string } | undefined;
    return body?.detail ?? `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : fallback;
}

export const UserProfileCard: Component = () => {
  const navigate = useNavigate();
  const actor = () => profileActor();
  const isSelf = () => actor() != null && actor() === session.actor;

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [requested, setRequested] = createSignal(false);

  // Fetch the profile (+ seed presence) whenever the open actor changes.
  const [profile] = createResource(actor, async (ref) => {
    setError(null);
    setRequested(false);
    const client = await clientForActor(ref);
    if (!client) throw new Error("not authenticated");
    const [prof, pres] = await Promise.all([
      fetchProfile(client, ref),
      fetchPresence(client, ref).catch(() => null),
    ]);
    if (pres) {
      setPresenceFor(ref, {
        availability: pres.availability,
        ...(pres.status !== undefined ? { status: pres.status } : {}),
        ...(pres.lastSeen !== undefined ? { lastSeen: pres.lastSeen } : {}),
      });
    }
    return prof;
  });

  // Contacts (to reflect an existing relationship on the Add-contact button).
  const [contacts] = createResource(actor, async () => {
    const c = sessionClient();
    return c ? fetchContacts(c).catch(() => []) : [];
  });
  const contactState = createMemo(() => {
    const a = actor();
    if (!a) return undefined;
    return (contacts() ?? []).find((c) => c.user === a)?.state;
  });

  // Subscribe to live presence while the card is open.
  let disposeSub: (() => void) | null = null;
  createMemo(() => {
    disposeSub?.();
    const a = actor();
    disposeSub = a ? subscribePresence(sessionWs(), [a], session.actor) : null;
  });
  onCleanup(() => disposeSub?.());

  const addContact = async (): Promise<void> => {
    const a = actor();
    const client = sessionClient();
    if (!a || !client) return;
    setBusy(true);
    setError(null);
    try {
      await requestContact(client, a);
      await mirrorIfRemote("request", a);
      setRequested(true);
      refreshPresenceSnapshots(sessionWs(), [a], session.actor);
    } catch (err) {
      setError(errorOf(err, "Could not send contact request."));
    } finally {
      setBusy(false);
    }
  };

  const message = (): void => {
    const a = actor();
    const me = session.actor;
    if (!a || !me) return;
    const dmId = deriveDmId(me, a);
    upsertConversation({ dmId, counterparty: a });
    closeUserProfile();
    navigate(`/dms/${dmId}`);
  };

  const fullActor = () => actor() ?? "";

  return (
    <Show when={actor()}>
      <Modal onClose={closeUserProfile} size="sm" testid="user-profile-modal">
        <Show when={!profile.loading} fallback={<p class="text-sm text-muted">Loading profile…</p>}>
          <Show
            when={!profile.error}
            fallback={
              <div>
                <p class="text-sm text-danger" data-testid="profile-error">
                  Could not load this profile.
                </p>
                <button
                  type="button"
                  class="btn-ghost mt-3 px-3 py-1 text-xs"
                  onClick={closeUserProfile}
                >
                  Close
                </button>
              </div>
            }
          >
            <div class="flex items-start gap-3">
              <Show
                when={profile()?.avatar}
                fallback={
                  <div class="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-surface-2 text-lg text-muted">
                    {fullActor().slice(0, 1).toUpperCase()}
                  </div>
                }
              >
                <img
                  src={profile()?.avatar}
                  alt=""
                  class="h-12 w-12 shrink-0 rounded-full object-cover"
                  data-testid="profile-avatar"
                />
              </Show>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <h2 class="truncate text-base font-semibold text-ink" data-testid="profile-name">
                    {profile()?.displayName ?? localPart(fullActor())}
                  </h2>
                  <PresenceDot actor={fullActor()} size="md" />
                </div>
                <p class="truncate text-xs text-faint" data-testid="profile-handle">
                  {fullActor()}
                </p>
              </div>
            </div>

            <Show when={profile()?.bio}>
              <p class="mt-3 text-sm text-muted" data-testid="profile-bio">
                {profile()?.bio as string}
              </p>
            </Show>

            <div class="mt-4 flex items-center gap-2">
              <Show
                when={!isSelf()}
                fallback={<span class="text-xs text-faint">This is you.</span>}
              >
                <button
                  type="button"
                  class="btn-accent px-3 py-1.5 text-xs"
                  data-testid="profile-message"
                  onClick={message}
                >
                  Message
                </button>
                <Switch>
                  <Match when={contactState() === "accepted"}>
                    <span class="badge text-xs" data-testid="profile-contact-state">
                      Contact
                    </span>
                  </Match>
                  <Match when={contactState() === "pending" || requested()}>
                    <span class="badge text-xs" data-testid="profile-contact-state">
                      Request pending
                    </span>
                  </Match>
                  <Match when={true}>
                    <button
                      type="button"
                      class="btn-ghost px-3 py-1.5 text-xs"
                      data-testid="profile-add-contact"
                      disabled={busy()}
                      onClick={() => void addContact()}
                    >
                      {busy() ? "…" : "Add contact"}
                    </button>
                  </Match>
                </Switch>
              </Show>
              <button
                type="button"
                class="btn-ghost ml-auto px-3 py-1.5 text-xs"
                data-testid="profile-close"
                onClick={closeUserProfile}
              >
                Close
              </button>
            </div>
            <Show when={error()}>
              <p class="mt-2 text-xs text-danger" data-testid="profile-action-error">
                {error()}
              </p>
            </Show>
          </Show>
        </Show>
      </Modal>
    </Show>
  );
};

/** Local-part of `handle@domain`. */
function localPart(actor: string): string {
  const at = actor.indexOf("@");
  return at > 0 ? actor.slice(0, at) : actor;
}
