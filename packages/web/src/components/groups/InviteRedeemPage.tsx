/**
 * Invite redeem page (P8, §5.6) at `/invite/{token}`.
 *
 *  - Signed-in user: redeem via `POST /api/invites/{token}/redeem` → becomes a
 *    member, then routes into the group.
 *  - Signed-out user: offer a **guest** path — generate a keypair in-browser and
 *    provision a guest account via `POST /api/invites/{token}/guest` (only works
 *    if the invite `grantsGuest`); or a link to sign in first. We don't know the
 *    invite's `grantsGuest` flag up front (it isn't publicly readable), so we
 *    attempt the guest flow and surface the server's verdict.
 */
import { useNavigate, useParams } from "@solidjs/router";
import { type Component, Show, createSignal, onMount } from "solid-js";
import { redeemInvite } from "../../lib/groups-api.ts";
import { loadProviderHost, probeProvider } from "../../lib/provider.ts";
import { doRedeemGuest } from "../../stores/auth-controller.ts";
import { isAuthenticated, provider, sessionClient, setProvider } from "../../stores/session.ts";
import { useInvalidateGroup } from "./queries.ts";
import { ErrorLine, errorMessage } from "./ui.tsx";

/** Resolve the provider host for the guest flow: the chosen one, else the origin. */
function hostForGuest(): string {
  return (
    provider()?.host ?? loadProviderHost() ?? (typeof location !== "undefined" ? location.host : "")
  );
}

export const InviteRedeemPage: Component = () => {
  const params = useParams<{ token: string }>();
  const navigate = useNavigate();
  const invalidate = useInvalidateGroup();

  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [displayName, setDisplayName] = createSignal("");
  const [autoTried, setAutoTried] = createSignal(false);

  // For a signed-in user, redeem immediately on mount.
  onMount(async () => {
    if (isAuthenticated()) {
      await redeemAsMember();
    }
    setAutoTried(true);
  });

  const redeemAsMember = async () => {
    setBusy(true);
    setError(null);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      const result = await redeemInvite(client, params.token);
      invalidate(result.groupId);
      navigate(`/groups/${result.groupId}`);
    } catch (err) {
      setError(errorMessage(err, "Could not redeem this invite."));
    } finally {
      setBusy(false);
    }
  };

  const redeemAsGuest = async () => {
    setBusy(true);
    setError(null);
    try {
      let host = hostForGuest();
      // Make sure a provider is confirmed so the guest session has a real host.
      if (!provider() && host) {
        try {
          setProvider(await probeProvider(host));
          host = provider()?.host ?? host;
        } catch {
          /* fall through with the raw host */
        }
      }
      const { groupId } = await doRedeemGuest({
        host,
        token: params.token,
        ...(displayName().trim() ? { displayName: displayName().trim() } : {}),
      });
      invalidate(groupId);
      navigate(`/groups/${groupId}`);
    } catch (err) {
      setError(errorMessage(err, "Could not join as a guest."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="grid min-h-screen place-items-center bg-canvas px-4">
      <div class="w-full max-w-md" data-testid="invite-redeem-page">
        <div class="mb-7 flex items-center gap-3">
          <span class="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-accent to-cyan text-lg font-bold text-white">
            F
          </span>
          <div>
            <div class="text-xl font-semibold tracking-tight text-ink">You're invited</div>
            <div class="text-xs text-faint">Join a Forumall group</div>
          </div>
        </div>

        <div class="card flex flex-col gap-4">
          <Show
            when={isAuthenticated()}
            fallback={
              <>
                <p class="text-sm text-muted">
                  Join without an account as a <span class="text-ink">guest</span>, or sign in first
                  to join with your handle.
                </p>
                <label class="flex flex-col gap-1.5">
                  <span class="text-xs font-medium text-muted">
                    Display name <span class="text-faint">(optional)</span>
                  </span>
                  <input
                    class="input"
                    value={displayName()}
                    onInput={(e) => setDisplayName(e.currentTarget.value)}
                    placeholder="Guest"
                    disabled={busy()}
                    data-testid="guest-display-name"
                  />
                </label>
                <button
                  type="button"
                  class="btn-accent"
                  onClick={redeemAsGuest}
                  disabled={busy()}
                  data-testid="redeem-as-guest"
                >
                  {busy() ? "Joining…" : "Join as guest"}
                </button>
                <a class="text-center text-xs text-accent hover:text-accent-hi" href="/">
                  I have an account — sign in
                </a>
              </>
            }
          >
            <p class="text-sm text-muted" data-testid="redeem-as-member-status">
              <Show when={busy()} fallback="Redeeming your invite…">
                Redeeming your invite…
              </Show>
            </p>
            <Show when={autoTried() && !busy() && error()}>
              <button
                type="button"
                class="btn-accent"
                onClick={redeemAsMember}
                data-testid="retry-redeem"
              >
                Try again
              </button>
            </Show>
          </Show>

          <ErrorLine message={error()} testid="invite-redeem-error" />
        </div>
      </div>
    </div>
  );
};
