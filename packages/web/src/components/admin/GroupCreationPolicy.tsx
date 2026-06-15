/**
 * Group-creation policy settings (Forumall extension, admin-only).
 *
 * Lets the instance admin choose who may create groups on this provider:
 *  - "Open"       — any authenticated member can create a group (the default).
 *  - "Admin only" — only the provider admin can create groups.
 *
 * Backed by the public `GET /api/provider` (current value) + the admin-only
 * `PUT /api/admin/group-policy` (save). On save the shared branding store is
 * refreshed so the change (e.g. whether the "New space" button shows) takes
 * effect immediately without a reload.
 *
 * Gated on `session.isAdmin` by the parent `SettingsShell` — a non-admin never
 * sees this section, and the server enforces it (403) regardless.
 */
import { type Component, For, Show, createSignal, onMount } from "solid-js";
import { type GroupCreationPolicy as Policy, loadBranding } from "../../stores/branding.ts";
import { sessionClient } from "../../stores/session.ts";

interface ProviderResponse {
  groupCreationPolicy?: Policy;
}

const OPTIONS: { value: Policy; label: string; hint: string }[] = [
  {
    value: "open",
    label: "Open",
    hint: "Anyone with an account on this instance can create a group.",
  },
  {
    value: "admin-only",
    label: "Admin only",
    hint: "Only you, the provider admin, can create groups.",
  },
];

export const GroupCreationPolicy: Component = () => {
  const [policy, setPolicy] = createSignal<Policy>("open");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);

  // Seed the current value from the public provider read.
  onMount(async () => {
    const client = sessionClient();
    if (!client) return;
    try {
      const res = await client.get<ProviderResponse>("/api/provider", { anonymous: true });
      setPolicy(res.data.groupCreationPolicy ?? "open");
    } catch {
      /* leave the form at its default */
    }
  });

  const save = async (next: Policy): Promise<void> => {
    if (next === policy() && saved()) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const previous = policy();
    setPolicy(next);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      await client.put<{ policy: Policy }>("/api/admin/group-policy", { policy: next });
      // Refresh the shared store so the "New space" gating updates live.
      await loadBranding();
      setSaved(true);
    } catch (err) {
      setPolicy(previous);
      setError(err instanceof Error ? err.message : "Could not save the policy.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex flex-col gap-5" data-testid="group-policy-settings">
      <p class="text-sm text-muted">
        Decide who can create groups (spaces) on this instance. This doesn't affect existing groups.
      </p>

      <section class="card flex flex-col gap-2">
        <span class="eyebrow">Who can create groups</span>
        <For each={OPTIONS}>
          {(opt) => (
            <label
              class="flex cursor-pointer items-start gap-3 rounded-lg border-[1.5px] px-3 py-2.5 transition-colors"
              classList={{
                "border-accent bg-accent-soft": policy() === opt.value,
                "border-border hover:bg-surface-2": policy() !== opt.value,
              }}
              data-testid={`group-policy-${opt.value}`}
            >
              <input
                type="radio"
                name="group-creation-policy"
                class="mt-0.5"
                value={opt.value}
                checked={policy() === opt.value}
                disabled={busy()}
                onChange={() => void save(opt.value)}
              />
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium text-ink">{opt.label}</span>
                <span class="block text-xs text-faint">{opt.hint}</span>
              </span>
            </label>
          )}
        </For>
      </section>

      <Show when={error()}>
        <p class="text-sm text-danger" data-testid="group-policy-error">
          {error()}
        </p>
      </Show>
      <Show when={saved()}>
        <p class="text-sm text-accent" data-testid="group-policy-saved">
          Policy saved.
        </p>
      </Show>
    </div>
  );
};
