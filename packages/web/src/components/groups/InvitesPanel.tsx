/**
 * Invite management (P8, §5.6). Managers create invites (role, grantsGuest,
 * maxUses, expiresAt) and get a shareable `/invite/{token}` link; existing
 * invites are listed and revocable. The shareable link points at the app's
 * in-browser redeem page so the shape works regardless of the server's HTTPS
 * `link` (which assumes the production domain).
 */
import type { Group, Invite } from "@forumall/shared";
import { useQuery } from "@tanstack/solid-query";
import { type Component, For, Show, createSignal } from "solid-js";
import { createInvite, deleteInvite } from "../../lib/groups-api.ts";
import { sessionClient } from "../../stores/session.ts";
import { invitesQuery, useInvalidateGroup } from "./queries.ts";
import { ErrorLine, Field, errorMessage } from "./ui.tsx";

/** Build the in-app shareable redeem link for a token (works on any origin). */
export function inviteLinkFor(token: string): string {
  const origin = typeof location !== "undefined" ? location.origin : "";
  return `${origin}/invite/${token}`;
}

export const InvitesPanel: Component<{ group: Group; enabled: () => boolean }> = (props) => {
  const groupId = () => props.group.id;
  const invites = useQuery(() => invitesQuery(groupId, props.enabled));
  const invalidate = useInvalidateGroup();

  const [role, setRole] = createSignal("member");
  const [grantsGuest, setGrantsGuest] = createSignal(false);
  const [maxUses, setMaxUses] = createSignal("");
  const [expiresAt, setExpiresAt] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [lastLink, setLastLink] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  const create = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      const max = Number.parseInt(maxUses(), 10);
      const invite = await createInvite(client, groupId(), {
        ...(role().trim() ? { role: role().trim() } : {}),
        grantsGuest: grantsGuest(),
        ...(Number.isFinite(max) && max > 0 ? { maxUses: max } : {}),
        ...(expiresAt() ? { expiresAt: new Date(expiresAt()).toISOString() } : {}),
      });
      setLastLink(inviteLinkFor(invite.token));
      setCopied(false);
      invalidate(groupId());
    } catch (err) {
      setError(errorMessage(err, "Could not create the invite."));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    const link = lastLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      /* clipboard may be blocked; the link is still visible to copy manually */
    }
  };

  const revoke = async (inv: Invite) => {
    const client = sessionClient();
    if (!client) return;
    try {
      await deleteInvite(client, groupId(), inv.id);
      invalidate(groupId());
    } catch (err) {
      setError(errorMessage(err, "Could not revoke the invite."));
    }
  };

  return (
    <section class="flex flex-col gap-5" data-testid="invites-panel">
      <form class="flex flex-col gap-3" onSubmit={create}>
        <div class="grid grid-cols-2 gap-3">
          <Field label="Role">
            <input
              class="input font-mono text-xs"
              value={role()}
              onInput={(e) => setRole(e.currentTarget.value)}
              data-testid="invite-role"
            />
          </Field>
          <Field label="Max uses" hint="(blank = unlimited)">
            <input
              class="input"
              type="number"
              min="1"
              value={maxUses()}
              onInput={(e) => setMaxUses(e.currentTarget.value)}
              data-testid="invite-max-uses"
            />
          </Field>
        </div>
        <Field label="Expires at" hint="(optional)">
          <input
            class="input"
            type="datetime-local"
            value={expiresAt()}
            onInput={(e) => setExpiresAt(e.currentTarget.value)}
            data-testid="invite-expires"
          />
        </Field>
        <label class="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={grantsGuest()}
            onChange={(e) => setGrantsGuest(e.currentTarget.checked)}
            data-testid="invite-grants-guest"
          />
          Allow guests (no account needed to join)
        </label>
        <ErrorLine message={error()} testid="invites-error" />
        <button
          type="submit"
          class="btn-accent self-start"
          disabled={busy()}
          data-testid="create-invite"
        >
          {busy() ? "Creating…" : "Create invite link"}
        </button>
      </form>

      <Show when={lastLink()}>
        {(link) => (
          <div
            class="rounded-lg border border-accent/40 bg-surface-2 p-3"
            data-testid="invite-link-box"
          >
            <p class="mb-1.5 text-xs font-medium text-muted">Shareable link</p>
            <div class="flex items-center gap-2">
              <code
                class="min-w-0 flex-1 truncate rounded bg-canvas px-2 py-1.5 text-xs text-cyan"
                data-testid="invite-link"
              >
                {link()}
              </code>
              <button type="button" class="btn-ghost px-3 py-1.5 text-xs" onClick={copy}>
                {copied() ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </Show>

      <div>
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
          Active invites
        </h3>
        <Show
          when={(invites.data ?? []).length > 0}
          fallback={<p class="text-sm text-muted">No active invites.</p>}
        >
          <ul class="flex flex-col divide-y divide-border" data-testid="invites-list">
            <For each={invites.data ?? []}>
              {(inv) => (
                <li class="flex items-center gap-3 py-2.5" data-testid="invite-row">
                  <div class="min-w-0 flex-1">
                    <code class="truncate text-xs text-muted">{inviteLinkFor(inv.token)}</code>
                    <div class="text-[11px] text-faint">
                      role {inv.role ?? "member"} · {inv.uses}
                      {inv.maxUses ? `/${inv.maxUses}` : ""} uses
                      {inv.grantsGuest ? " · guests ok" : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    class="btn-ghost px-2 py-1 text-xs hover:(border-danger text-danger)"
                    onClick={() => revoke(inv)}
                    data-testid="revoke-invite"
                  >
                    Revoke
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </section>
  );
};
