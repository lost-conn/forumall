/**
 * Contacts screen (P8, §6.7). Lists the caller's established contacts and their
 * pending requests (incoming + outgoing), with the full state machine:
 *
 *   - send a request (enter an actor `handle@domain`) → outgoing pending,
 *   - accept / decline an incoming pending request,
 *   - cancel an outgoing pending request,
 *   - remove an established contact.
 *
 * The contact rows are partitioned by `(state, direction)` from
 * `GET /api/me/contacts`. After any mutation we refetch so the partitions reflect
 * the new state immediately (the server mirrors a LOCAL counterparty's side, so a
 * local accept flips both rows). Each row shows a live presence dot for the
 * contact, subscribed while the screen is mounted.
 */
import type { Contact } from "@forumall/shared";
import {
  type Component,
  For,
  Show,
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
  acceptContact,
  fetchContacts,
  mirrorContactEvent,
  removeContact,
  requestContact,
} from "../../lib/social-api.ts";
import { refreshPresenceSnapshots, subscribePresence } from "../../stores/presence-controller.ts";
import { session, sessionClient, sessionWs } from "../../stores/session.ts";
import { PresenceDot } from "./PresenceDot.tsx";

function clientOrThrow() {
  const c = sessionClient();
  if (!c) throw new Error("not authenticated");
  return c;
}

/**
 * Mirror a contact `action` against a REMOTE counterparty's provider (§6.7). A
 * same-provider counterparty (or a missing session identity) is a no-op — the
 * server already mirrors a local counterparty's row. For a remote counterparty we
 * build a per-host client targeting their domain, signed by the home key, and
 * deliver `{action, from: me, to: counterparty}` to their federation receiver.
 */
async function mirrorIfRemote(action: ContactMirrorAction, counterparty: string): Promise<void> {
  const home = session.host;
  const me = session.actor;
  const keyId = session.keyId;
  if (!home || !me || !keyId) return;
  if (isLocalActor(counterparty, home)) return; // same provider → no mirror needed
  const targetHost = domainOf(counterparty);
  if (!targetHost) return;
  const privateKey = await keyStore.getKey(keyId);
  if (!privateKey) return;
  const mirrorClient: OfscpClient = clientForHost(targetHost, { actor: me, keyId, privateKey });
  await mirrorContactEvent(mirrorClient, action, me, counterparty);
}

function errorOf(err: unknown, fallback: string): string {
  if (err instanceof OfscpHttpError) {
    const body = err.body as { detail?: string } | undefined;
    return body?.detail ?? `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : fallback;
}

export const ContactsPage: Component = () => {
  const [contacts, { refetch }] = createResource(
    () => session.actor,
    () => fetchContacts(clientOrThrow()),
  );
  const [newActor, setNewActor] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);

  // Read the resource error-safely: reading the accessor while errored re-throws
  // (which would trip the app ErrorBoundary). `list()` yields [] on load/error.
  const list = (): Contact[] => (contacts.error || contacts.loading ? [] : (contacts() ?? []));

  // Subscribe to live presence for every listed contact while mounted; resubscribe
  // when the list changes (the ref-counted controller de-dupes overlap).
  let disposeSub: (() => void) | null = null;
  const actors = createMemo(() => list().map((c) => c.user));
  createMemo(() => {
    disposeSub?.();
    disposeSub = subscribePresence(sessionWs(), actors(), session.actor);
  });
  onCleanup(() => disposeSub?.());

  const accepted = createMemo(() => list().filter((c) => c.state === "accepted"));
  const incoming = createMemo(() =>
    list().filter((c) => c.state === "pending" && c.direction === "incoming"),
  );
  const outgoing = createMemo(() =>
    list().filter((c) => c.state === "pending" && c.direction === "outgoing"),
  );

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refetch();
      // A mutation may cross a visibility tier (e.g. accepting a request promotes
      // the viewer into the subject's `contacts` tier). Pull fresh presence
      // snapshots for the current set so dots reflect the new relationship.
      refreshPresenceSnapshots(sessionWs(), actors(), session.actor);
    } catch (err) {
      setError(errorOf(err, "Action failed."));
    } finally {
      setBusy(null);
    }
  };

  const submitRequest = (): void => {
    const value = newActor().trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(value)) {
      setError("Enter a contact as handle@domain.");
      return;
    }
    if (value === session.actor) {
      setError("You can't add yourself as a contact.");
      return;
    }
    void run("request", async () => {
      await requestContact(clientOrThrow(), value);
      // Cross-provider: mirror the request to the counterparty's provider so they
      // see an incoming pending request (§6.7). Same-provider needs no mirror.
      await mirrorIfRemote("request", value);
      setNewActor("");
    });
  };

  return (
    <div class="flex-1 overflow-auto" data-testid="contacts-page">
      <header class="border-b border-border px-8 py-5">
        <h1 class="text-lg font-semibold tracking-tight">Contacts</h1>
        <p class="mt-0.5 text-sm text-muted">
          Mutually-consented connections. Contacts can see your `contacts`-tier presence and
          profile.
        </p>
      </header>

      <div class="flex max-w-2xl flex-col gap-6 p-8">
        {/* Add a contact */}
        <section class="card" data-testid="add-contact">
          <h2 class="mb-3 text-sm font-semibold tracking-tight">Add a contact</h2>
          <div class="flex gap-2">
            <input
              class="input flex-1"
              placeholder="handle@domain"
              value={newActor()}
              onInput={(e) => {
                setNewActor(e.currentTarget.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitRequest();
                }
              }}
              data-testid="add-contact-input"
            />
            <button
              type="button"
              class="btn-accent px-4 py-2 text-sm"
              onClick={submitRequest}
              disabled={busy() === "request"}
              data-testid="add-contact-submit"
            >
              {busy() === "request" ? "Sending…" : "Send request"}
            </button>
          </div>
          <Show when={error()}>
            <p class="mt-2 text-sm text-danger" role="alert" data-testid="contacts-error">
              {error()}
            </p>
          </Show>
        </section>

        <Show
          when={!contacts.loading}
          fallback={<p class="text-sm text-muted">Loading contacts…</p>}
        >
          {/* Incoming requests */}
          <Show when={incoming().length > 0}>
            <section class="card" data-testid="incoming-requests">
              <h2 class="mb-3 text-sm font-semibold tracking-tight">Incoming requests</h2>
              <ul class="flex flex-col divide-y divide-dashed divide-border">
                <For each={incoming()}>
                  {(c) => (
                    <ContactRow contact={c}>
                      <button
                        type="button"
                        class="btn-accent px-3 py-1 text-xs"
                        disabled={busy() === `accept:${c.user}`}
                        onClick={() =>
                          run(`accept:${c.user}`, async () => {
                            await acceptContact(clientOrThrow(), c.user);
                            await mirrorIfRemote("accept", c.user);
                          })
                        }
                        data-testid="accept-contact"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        class="btn-ghost px-3 py-1 text-xs hover:(border-danger text-danger)"
                        disabled={busy() === `decline:${c.user}`}
                        onClick={() =>
                          run(`decline:${c.user}`, async () => {
                            await removeContact(clientOrThrow(), c.user);
                            await mirrorIfRemote("remove", c.user);
                          })
                        }
                        data-testid="decline-contact"
                      >
                        Decline
                      </button>
                    </ContactRow>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          {/* Outgoing requests */}
          <Show when={outgoing().length > 0}>
            <section class="card" data-testid="outgoing-requests">
              <h2 class="mb-3 text-sm font-semibold tracking-tight">Pending sent requests</h2>
              <ul class="flex flex-col divide-y divide-dashed divide-border">
                <For each={outgoing()}>
                  {(c) => (
                    <ContactRow contact={c}>
                      <span class="text-xs text-faint" data-testid="outgoing-pending-label">
                        Pending
                      </span>
                      <button
                        type="button"
                        class="btn-ghost px-3 py-1 text-xs hover:(border-danger text-danger)"
                        disabled={busy() === `cancel:${c.user}`}
                        onClick={() =>
                          run(`cancel:${c.user}`, async () => {
                            await removeContact(clientOrThrow(), c.user);
                            await mirrorIfRemote("remove", c.user);
                          })
                        }
                        data-testid="cancel-contact"
                      >
                        Cancel
                      </button>
                    </ContactRow>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          {/* Established contacts */}
          <section class="card" data-testid="accepted-contacts">
            <h2 class="mb-3 text-sm font-semibold tracking-tight">Contacts</h2>
            <Show
              when={accepted().length > 0}
              fallback={
                <p class="text-sm text-muted" data-testid="contacts-empty">
                  No contacts yet.
                </p>
              }
            >
              <ul
                class="flex flex-col divide-y divide-dashed divide-border"
                data-testid="contacts-list"
              >
                <For each={accepted()}>
                  {(c) => (
                    <ContactRow contact={c}>
                      <button
                        type="button"
                        class="btn-ghost px-3 py-1 text-xs hover:(border-danger text-danger)"
                        disabled={busy() === `remove:${c.user}`}
                        onClick={() =>
                          run(`remove:${c.user}`, async () => {
                            await removeContact(clientOrThrow(), c.user);
                            await mirrorIfRemote("remove", c.user);
                          })
                        }
                        data-testid="remove-contact"
                      >
                        Remove
                      </button>
                    </ContactRow>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        </Show>
      </div>
    </div>
  );
};

const ContactRow: Component<{ contact: Contact; children: import("solid-js").JSX.Element }> = (
  props,
) => (
  <li
    class="flex items-center gap-3 py-3"
    data-testid="contact-row"
    data-user={props.contact.user}
    data-state={props.contact.state}
    data-direction={props.contact.direction ?? ""}
  >
    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-muted">
      {props.contact.user.slice(0, 2).toUpperCase()}
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class="truncate text-sm text-ink font-mono" data-testid="contact-handle">
          {props.contact.user}
        </span>
        <PresenceDot actor={props.contact.user} />
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-1.5">{props.children}</div>
  </li>
);
