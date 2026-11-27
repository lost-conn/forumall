/**
 * Privacy + profile settings (P8, §6.3 / §6.6). Two cards added to the Settings
 * screen:
 *
 *  - **Profile** (`PATCH /api/me/profile`): edit displayName, avatar URL, bio.
 *  - **Privacy** (`GET/PUT /api/me/privacy`): edit the three §6.1 visibility
 *    policies (presence / profile / membership) over the
 *    public/authenticated/sharedGroups/contacts/nobody enum, plus optional
 *    allow/deny lists (comma- or newline-separated actor refs).
 *
 * Both load their current values via `createResource` from the signed client and
 * save through the social-api wrappers, surfacing a saved/error state.
 */
import { type VisibilityPolicy, canonicalActor } from "@forumall/shared";
import { type Component, For, Show, createEffect, createResource, createSignal } from "solid-js";
import { resolveAttachmentUrl, uploadMedia } from "../../lib/chat-api.ts";
import { OfscpHttpError } from "../../lib/ofscp-client.ts";
import { profileUpdateBody } from "../../lib/profile-form.ts";
import { fetchPrivacy, fetchProfile, updatePrivacy, updateProfile } from "../../lib/social-api.ts";
import { session, sessionClient } from "../../stores/session.ts";
import { SettingsSection } from "../shared/SettingsSection.tsx";

function clientOrThrow() {
  const c = sessionClient();
  if (!c) throw new Error("not authenticated");
  return c;
}

function errorOf(err: unknown, fallback: string): string {
  if (err instanceof OfscpHttpError) {
    const body = err.body as { detail?: string } | undefined;
    return body?.detail ?? `Request failed (${err.status}).`;
  }
  return err instanceof Error ? err.message : fallback;
}

const POLICIES: VisibilityPolicy[] = [
  "public",
  "authenticated",
  "sharedGroups",
  "contacts",
  "nobody",
];

const POLICY_LABEL: Record<string, string> = {
  public: "Public (anyone)",
  authenticated: "Authenticated users",
  sharedGroups: "Members of my groups",
  contacts: "My contacts only",
  nobody: "Nobody",
};

/** Split a comma/newline-separated list into trimmed non-empty actor refs. */
function parseList(raw: string): string[] {
  return (
    raw
      .split(/[\n,]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
      // Senders MUST send actors in canonical form (§2.2): `bob@host:443` → `bob@host`.
      // Entries are actors only (§6.1); anything else (e.g. a user URI) is sent
      // as typed and the provider rejects it with a 400 the form shows.
      .map((s) => canonicalActor(s) ?? s)
  );
}

// ---------------------------------------------------------------------------
// Profile editing (§6.3)
// ---------------------------------------------------------------------------

export const ProfileSettings: Component = () => {
  const [profile] = createResource(
    () => session.actor,
    (me) => (me ? fetchProfile(clientOrThrow(), me) : null),
  );
  const [displayName, setDisplayName] = createSignal("");
  const [avatar, setAvatar] = createSignal("");
  const [bio, setBio] = createSignal("");
  // The avatar the server holds (as loaded, then as last saved): the save sends
  // `avatar` only when the field differs from it (see `profileUpdateBody`).
  let storedAvatar: string | null = null;
  const [loaded, setLoaded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [uploading, setUploading] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;

  // Seed the form from the loaded profile once. Guard on the resource's error
  // state first — reading the accessor while errored re-throws (and would trip the
  // app-level ErrorBoundary on a 401, e.g. a revoked device key).
  createEffect(() => {
    if (profile.error || profile.loading || loaded()) return;
    const p = profile();
    if (!p) return;
    setDisplayName(p.displayName ?? "");
    setAvatar(p.avatar ?? "");
    storedAvatar = p.avatar ?? null;
    setBio(p.bio ?? "");
    setLoaded(true);
  });

  // Upload a chosen image file as the avatar (§5.8 signed multipart, via the
  // binary-safe `uploadMedia`). The returned attachment `url` is an https:// URL
  // the server hosts, so it satisfies the avatar field's https-only constraint;
  // populate the existing avatar field and let the manual Save flow persist it,
  // matching this form's save-button UX. Upload errors surface like other errors.
  const onPickAvatar = async (file: File): Promise<void> => {
    const client = sessionClient();
    if (!client) return;
    setUploading(true);
    setSaved(false);
    setError(null);
    try {
      const att = await uploadMedia(client, file);
      setAvatar(att.url);
    } catch (err) {
      setError(errorOf(err, "Could not upload the image."));
    } finally {
      setUploading(false);
      if (fileInput) fileInput.value = "";
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const built = profileUpdateBody(
        { displayName: displayName(), avatar: avatar(), bio: bio() },
        storedAvatar,
      );
      if ("error" in built) {
        setError(built.error);
        return;
      }
      // The server answers 400 for a new avatar URL it does not host, shown like
      // any other save error.
      const updated = await updateProfile(clientOrThrow(), built.body);
      storedAvatar = updated.avatar ?? null;
      setSaved(true);
    } catch (err) {
      setError(errorOf(err, "Could not save profile."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Profile" testid="profile-settings">
      <Show when={profile.error}>
        <p class="mb-2 text-sm text-danger" data-testid="profile-load-error">
          Could not load your profile.
        </p>
      </Show>
      <div class="flex flex-col gap-3">
        <label class="flex flex-col gap-1 text-xs text-muted">
          Display name
          <input
            class="input"
            value={displayName()}
            onInput={(e) => setDisplayName(e.currentTarget.value)}
            data-testid="profile-display-name"
          />
        </label>
        <div class="flex flex-col gap-1.5 text-xs text-muted">
          Avatar
          <div class="flex items-center gap-3">
            <span class="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2 text-base text-faint">
              <Show
                when={avatar().trim()}
                fallback={(session.actor ?? "?").slice(0, 1).toUpperCase()}
              >
                <img
                  src={resolveAttachmentUrl(avatar().trim())}
                  alt=""
                  class="h-full w-full object-cover"
                  data-testid="profile-avatar-preview"
                />
              </Show>
            </span>
            <button
              type="button"
              class="btn-ghost px-3 py-1.5 text-xs"
              data-testid="profile-avatar-upload"
              disabled={uploading()}
              onClick={() => fileInput?.click()}
            >
              {uploading() ? "Uploading…" : "Upload image"}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              class="hidden"
              data-testid="profile-avatar-file"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (file) void onPickAvatar(file);
              }}
            />
          </div>
        </div>
        <label class="flex flex-col gap-1 text-xs text-muted">
          Avatar URL
          <input
            class="input"
            placeholder="https://…"
            value={avatar()}
            onInput={(e) => setAvatar(e.currentTarget.value)}
            data-testid="profile-avatar"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs text-muted">
          Bio
          <textarea
            class="input min-h-20 resize-y"
            value={bio()}
            onInput={(e) => setBio(e.currentTarget.value)}
            data-testid="profile-bio"
          />
        </label>
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="btn-accent px-4 py-2 text-sm"
            onClick={() => void save()}
            disabled={saving() || uploading()}
            data-testid="profile-save"
          >
            {saving() ? "Saving…" : "Save profile"}
          </button>
          <Show when={saved()}>
            <span class="text-xs text-success" data-testid="profile-saved">
              Saved.
            </span>
          </Show>
          <Show when={error()}>
            <span class="text-xs text-danger" data-testid="profile-error">
              {error()}
            </span>
          </Show>
        </div>
      </div>
    </SettingsSection>
  );
};

// ---------------------------------------------------------------------------
// Privacy editing (§6.6)
// ---------------------------------------------------------------------------

export const PrivacySettingsCard: Component = () => {
  const [settings] = createResource(
    () => session.actor,
    () => fetchPrivacy(clientOrThrow()),
  );
  const [presenceVisibility, setPresenceVisibility] = createSignal<VisibilityPolicy>("public");
  const [profileVisibility, setProfileVisibility] = createSignal<VisibilityPolicy>("public");
  const [membershipVisibility, setMembershipVisibility] = createSignal<VisibilityPolicy>("public");
  const [allowList, setAllowList] = createSignal("");
  const [denyList, setDenyList] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Guard on the resource's error/loading state before reading the accessor —
  // reading while errored re-throws (would trip the app ErrorBoundary on a 401).
  createEffect(() => {
    if (settings.error || settings.loading || loaded()) return;
    const s = settings();
    if (!s) return;
    setPresenceVisibility(s.presenceVisibility);
    setProfileVisibility(s.profileVisibility);
    setMembershipVisibility(s.membershipVisibility);
    const allow = (s as { allowList?: string[] }).allowList ?? [];
    const deny = (s as { denyList?: string[] }).denyList ?? [];
    setAllowList(allow.join("\n"));
    setDenyList(deny.join("\n"));
    setLoaded(true);
  });

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await updatePrivacy(clientOrThrow(), {
        presenceVisibility: presenceVisibility(),
        profileVisibility: profileVisibility(),
        membershipVisibility: membershipVisibility(),
        allowList: parseList(allowList()),
        denyList: parseList(denyList()),
      });
      setSaved(true);
    } catch (err) {
      setError(errorOf(err, "Could not save privacy settings."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Privacy" testid="privacy-settings">
      <Show when={settings.error}>
        <p class="mb-2 text-sm text-danger" data-testid="privacy-load-error">
          Could not load your privacy settings.
        </p>
      </Show>
      <Show when={loaded()} fallback={<p class="text-sm text-muted">Loading…</p>}>
        <div class="flex flex-col gap-3">
          <PolicySelect
            label="Presence visibility"
            testid="presence-visibility"
            value={presenceVisibility()}
            onChange={setPresenceVisibility}
          />
          <PolicySelect
            label="Profile visibility"
            testid="profile-visibility"
            value={profileVisibility()}
            onChange={setProfileVisibility}
          />
          <PolicySelect
            label="Membership visibility"
            testid="membership-visibility"
            value={membershipVisibility()}
            onChange={setMembershipVisibility}
          />
          <label class="flex flex-col gap-1 text-xs text-muted">
            Allow list (actors, one per line)
            <textarea
              class="input min-h-16 resize-y font-mono text-xs"
              value={allowList()}
              onInput={(e) => setAllowList(e.currentTarget.value)}
              data-testid="privacy-allowlist"
            />
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Deny list (actors, one per line)
            <textarea
              class="input min-h-16 resize-y font-mono text-xs"
              value={denyList()}
              onInput={(e) => setDenyList(e.currentTarget.value)}
              data-testid="privacy-denylist"
            />
          </label>
          <div class="flex items-center gap-3">
            <button
              type="button"
              class="btn-accent px-4 py-2 text-sm"
              onClick={() => void save()}
              disabled={saving()}
              data-testid="privacy-save"
            >
              {saving() ? "Saving…" : "Save privacy"}
            </button>
            <Show when={saved()}>
              <span class="text-xs text-success" data-testid="privacy-saved">
                Saved.
              </span>
            </Show>
            <Show when={error()}>
              <span class="text-xs text-danger" data-testid="privacy-error">
                {error()}
              </span>
            </Show>
          </div>
        </div>
      </Show>
    </SettingsSection>
  );
};

const PolicySelect: Component<{
  label: string;
  testid: string;
  value: VisibilityPolicy;
  onChange: (v: VisibilityPolicy) => void;
}> = (props) => (
  <label class="flex flex-col gap-1 text-xs text-muted">
    {props.label}
    <select
      class="input"
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value as VisibilityPolicy)}
      data-testid={props.testid}
    >
      <For each={POLICIES}>{(p) => <option value={p}>{POLICY_LABEL[p] ?? p}</option>}</For>
    </select>
  </label>
);
