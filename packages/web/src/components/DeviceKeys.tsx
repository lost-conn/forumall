/**
 * Device / key management (P8, spec §4.5/§4.7).
 *
 * Lists THIS user's registered device keys via the signed `GET
 * /api/auth/device-keys`, marks the current device, and lets the user revoke any
 * key via `DELETE /api/auth/device-keys/{keyId}`. Revoking the *current* device's
 * key is effectively a logout (its credential dies), so that row routes through
 * the logout flow to also wipe local state.
 */
import { type Component, For, type Resource, Show, createResource, createSignal } from "solid-js";
import { OfscpHttpError } from "../lib/ofscp-client.ts";
import { doLogout } from "../stores/auth-controller.ts";
import { session, sessionClient } from "../stores/session.ts";

/** Fallback while a device-keys fetch is loading; silent on error (surfaced above). */
const LoadingOrFailed: Component<{ resource: Resource<unknown> }> = (props) => (
  <Show when={props.resource.loading}>
    <p class="text-sm text-muted">Loading device keys…</p>
  </Show>
);

interface DeviceKey {
  key_id: string;
  algorithm: string;
  public_key: string;
  device_name: string;
  created_at: string;
}

interface DeviceKeysResponse {
  keys: DeviceKey[];
}

async function fetchDeviceKeys(): Promise<DeviceKey[]> {
  const client = sessionClient();
  if (!client) throw new Error("not authenticated");
  const res = await client.get<DeviceKeysResponse>("/api/auth/device-keys");
  return res.data.keys ?? [];
}

export const DeviceKeys: Component = () => {
  const [keys, { refetch }] = createResource(fetchDeviceKeys);
  const [error, setError] = createSignal<string | null>(null);
  const [revoking, setRevoking] = createSignal<string | null>(null);

  const revoke = async (keyId: string) => {
    setError(null);
    setRevoking(keyId);
    try {
      if (keyId === session.keyId) {
        // Revoking the current device = logout (wipes local key + session).
        await doLogout();
        return;
      }
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      await client.delete(`/api/auth/device-keys/${keyId}`);
      await refetch();
    } catch (err) {
      if (err instanceof OfscpHttpError) {
        const body = err.body as { detail?: string } | undefined;
        setError(body?.detail ?? `Revoke failed (${err.status}).`);
      } else {
        setError(err instanceof Error ? err.message : "Revoke failed.");
      }
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section class="card max-w-xl" data-testid="device-keys">
      <div class="mb-4 flex items-center justify-between">
        <div>
          <h2 class="text-sm font-semibold tracking-tight">Device keys</h2>
          <p class="mt-0.5 text-xs text-muted">
            Each device holds its own Ed25519 key. Revoke a key to sign that device out.
          </p>
        </div>
        <button
          type="button"
          class="btn-ghost px-3 py-1.5 text-xs"
          onClick={() => refetch()}
          disabled={keys.loading}
        >
          Refresh
        </button>
      </div>

      <Show when={error() ?? (keys.error ? "Could not load device keys." : null)}>
        {(msg) => (
          <p class="mb-3 text-sm text-danger" role="alert" data-testid="device-keys-error">
            {msg()}
          </p>
        )}
      </Show>

      <Show when={!keys.loading && !keys.error} fallback={<LoadingOrFailed resource={keys} />}>
        <Show
          when={keys() && (keys() as DeviceKey[]).length > 0}
          fallback={<p class="text-sm text-muted">No device keys.</p>}
        >
          <ul class="flex flex-col divide-y divide-border" data-testid="device-keys-list">
            <For each={keys()}>
              {(key) => {
                const isCurrent = () => key.key_id === session.keyId;
                return (
                  <li class="flex items-center gap-3 py-3" data-testid="device-key-row">
                    <span
                      class="h-2 w-2 shrink-0 rounded-full"
                      classList={{ "bg-success": isCurrent(), "bg-faint": !isCurrent() }}
                    />
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="truncate text-sm font-medium text-ink">
                          {key.device_name || "Unnamed device"}
                        </span>
                        <Show when={isCurrent()}>
                          <span class="badge text-[10px]" data-testid="current-device">
                            This device
                          </span>
                        </Show>
                      </div>
                      <div class="truncate text-xs text-faint font-mono">{key.key_id}</div>
                    </div>
                    <button
                      type="button"
                      class="btn-ghost px-3 py-1.5 text-xs hover:(border-danger text-danger)"
                      onClick={() => revoke(key.key_id)}
                      disabled={revoking() === key.key_id}
                      data-testid={isCurrent() ? "revoke-current" : "revoke-key"}
                    >
                      {revoking() === key.key_id
                        ? "Revoking…"
                        : isCurrent()
                          ? "Sign out"
                          : "Revoke"}
                    </button>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
};
