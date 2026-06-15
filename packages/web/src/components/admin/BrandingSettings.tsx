/**
 * Provider branding settings (Forumall extension, admin-only).
 *
 * Lets the instance admin set the provider's display **name**, **icon**, and
 * **accent color**. The icon is uploaded through the existing `/api/media`
 * pipeline (binary-safe signed multipart, via `uploadMedia`); the returned URL
 * is then persisted with the name + accent via `PUT /api/provider`. On save the
 * shared branding store is refreshed so the change (title / favicon / accent /
 * header brand) is visible immediately without a reload.
 *
 * Gated on `session.isAdmin` by the parent `SettingsShell` — a non-admin never
 * sees this section, and the server enforces it (403) regardless.
 */
import { type Component, Show, createSignal, onMount } from "solid-js";
import { resolveAttachmentUrl, uploadMedia } from "../../lib/chat-api.ts";
import { brandName, loadBranding } from "../../stores/branding.ts";
import { sessionClient } from "../../stores/session.ts";

interface BrandingResponse {
  domain: string;
  name: string;
  iconUrl: string | null;
  accentColor: string | null;
}

export const BrandingSettings: Component = () => {
  const [name, setName] = createSignal("");
  const [iconUrl, setIconUrl] = createSignal("");
  const [accent, setAccent] = createSignal("#34d6b8");
  const [domain, setDomain] = createSignal("");

  const [uploading, setUploading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  let iconInput: HTMLInputElement | undefined;

  // Seed the form from the current branding (public read).
  onMount(async () => {
    const client = sessionClient();
    if (!client) return;
    try {
      const res = await client.get<BrandingResponse>("/api/provider", { anonymous: true });
      const b = res.data;
      setDomain(b.domain);
      setName(b.name === b.domain ? "" : b.name);
      setIconUrl(b.iconUrl ?? "");
      if (b.accentColor) setAccent(b.accentColor);
    } catch {
      /* leave the form at its defaults */
    }
  });

  const onPickIcon = async (file: File): Promise<void> => {
    const client = sessionClient();
    if (!client) return;
    setUploading(true);
    setError(null);
    try {
      const att = await uploadMedia(client, file);
      setIconUrl(att.url);
    } catch {
      setError("Could not upload the image.");
    } finally {
      setUploading(false);
      if (iconInput) iconInput.value = "";
    }
  };

  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      const icon = iconUrl().trim();
      await client.put<BrandingResponse>("/api/provider", {
        // Empty name → null clears the override (falls back to the domain).
        name: name().trim() || null,
        iconUrl: icon || null,
        accentColor: accent(),
      });
      // Refresh the shared store so title/favicon/accent/header update live.
      await loadBranding();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save branding.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="flex flex-col gap-5" onSubmit={save} data-testid="branding-settings">
      <p class="text-sm text-muted">
        Customize how this instance presents itself to its members. These apply to everyone on{" "}
        <span class="font-mono text-ink">{domain()}</span>.
      </p>

      {/* Name */}
      <section class="card flex flex-col gap-2">
        <label class="eyebrow" for="branding-name">
          Instance name
        </label>
        <input
          id="branding-name"
          class="input"
          value={name()}
          placeholder={domain() || "Forumall"}
          maxlength={80}
          onInput={(e) => setName(e.currentTarget.value)}
          disabled={busy()}
          data-testid="branding-name"
        />
        <p class="fa-meta">
          Shown in the page title, the welcome screen, and the app header. Leave blank to use{" "}
          <span class="font-mono">{domain() || "your domain"}</span>. Currently:{" "}
          <span class="font-mono text-ink">{brandName()}</span>.
        </p>
      </section>

      {/* Icon */}
      <section class="card flex flex-col gap-3">
        <span class="eyebrow">Instance icon</span>
        <div class="flex items-center gap-3">
          <span class="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-md border-[1.5px] border-border-strong bg-surface-2 text-base text-faint">
            <Show
              when={iconUrl().trim()}
              fallback={(name() || domain() || "?").slice(0, 1).toUpperCase()}
            >
              <img
                src={resolveAttachmentUrl(iconUrl().trim())}
                alt=""
                class="h-full w-full object-cover"
                data-testid="branding-icon-preview"
              />
            </Show>
          </span>
          <button
            type="button"
            class="btn-ghost px-3 py-1.5 text-xs"
            disabled={busy() || uploading()}
            onClick={() => iconInput?.click()}
            data-testid="branding-icon-upload"
          >
            {uploading() ? "Uploading…" : "Upload image"}
          </button>
          <Show when={iconUrl().trim()}>
            <button
              type="button"
              class="btn-ghost px-3 py-1.5 text-xs hover:(border-danger text-danger)"
              disabled={busy() || uploading()}
              onClick={() => setIconUrl("")}
              data-testid="branding-icon-clear"
            >
              Remove
            </button>
          </Show>
          <input
            ref={iconInput}
            type="file"
            accept="image/*"
            class="hidden"
            data-testid="branding-icon-file"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              if (file) void onPickIcon(file);
            }}
          />
        </div>
      </section>

      {/* Accent */}
      <section class="card flex flex-col gap-3">
        <span class="eyebrow">Accent color</span>
        <div class="flex items-center gap-3">
          <input
            type="color"
            class="h-9 w-12 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
            value={accent()}
            onInput={(e) => setAccent(e.currentTarget.value)}
            disabled={busy()}
            aria-label="Accent color"
            data-testid="branding-accent-color"
          />
          <input
            class="input w-32 font-mono"
            value={accent()}
            onInput={(e) => setAccent(e.currentTarget.value)}
            disabled={busy()}
            data-testid="branding-accent-hex"
          />
          <span
            class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold"
            style={{ background: accent(), color: "var(--phosphor-ink)" }}
            data-testid="branding-accent-swatch"
          >
            Preview
          </span>
        </div>
        <p class="fa-meta">A `#rrggbb` hex color used as the primary accent across the app.</p>
      </section>

      <Show when={error()}>
        <p class="text-sm text-danger" data-testid="branding-error">
          {error()}
        </p>
      </Show>
      <Show when={saved()}>
        <p class="text-sm text-accent" data-testid="branding-saved">
          Branding saved.
        </p>
      </Show>

      <div class="flex justify-end">
        <button type="submit" class="btn-accent" disabled={busy()} data-testid="branding-save">
          {busy() ? "Saving…" : "Save branding"}
        </button>
      </div>
    </form>
  );
};
