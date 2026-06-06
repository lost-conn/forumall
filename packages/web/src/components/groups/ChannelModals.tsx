/**
 * Create / manage channel modals (P8, §5.5). Create takes name, type
 * (text/call), tier, topic; manage edits name/tier/topic or deletes (type is
 * immutable server-side). Manager-only — gated by the caller in the group view.
 */
import type { Channel, ChannelType } from "@forumall/shared";
import { useQuery } from "@tanstack/solid-query";
import { type Component, For, Show, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { createChannel, deleteChannel, updateChannel } from "../../lib/groups-api.ts";
import { sessionClient } from "../../stores/session.ts";
import { tiersQuery, useInvalidateGroup } from "./queries.ts";
import { ErrorLine, Field, Modal, TierSelect, errorMessage } from "./ui.tsx";

const CHANNEL_TYPES: ChannelType[] = ["text", "call"];

/** Comma-separated role list → trimmed non-empty string[]. */
function roleList(s: string): string[] {
  return s
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/** Roles array → comma-separated string for the inputs. */
function joinRoles(roles: readonly string[] | undefined): string {
  return (roles ?? []).join(", ");
}

/** The per-channel grant/restriction actions edited as comma-separated roles. */
const PERMISSION_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "view", label: "Who can view", hint: "blank = inherit channel tier" },
  { key: "post:message", label: "Who can post chats", hint: "blank = inherit group post" },
  { key: "post:memo", label: "Who can post memos", hint: "blank = inherit group post" },
  { key: "post:article", label: "Who can post articles", hint: "blank = inherit group post" },
  { key: "react", label: "Who can react", hint: "blank = anyone who can read" },
  { key: "replyOnly", label: "Reply-only roles", hint: "these roles may only post replies" },
];

const REPLY_PARENT_TYPES = ["message", "memo", "article"] as const;

export const CreateChannelModal: Component<{
  groupId: string;
  onClose: () => void;
}> = (props) => {
  const tiers = useQuery(tiersQuery);
  const invalidate = useInvalidateGroup();
  const [name, setName] = createSignal("");
  const [type, setType] = createSignal<ChannelType>("text");
  const [tier, setTier] = createSignal("group");
  const [topic, setTopic] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      await createChannel(client, props.groupId, {
        ...(name().trim() ? { name: name().trim() } : {}),
        type: type(),
        tier: tier(),
        ...(topic().trim() ? { topic: topic().trim() } : {}),
      });
      invalidate(props.groupId);
      props.onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not create the channel."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create a channel" onClose={props.onClose} testid="create-channel-modal">
      <form class="flex flex-col gap-4" onSubmit={submit}>
        <Field label="Name">
          <input
            class="input"
            placeholder="general"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            disabled={busy()}
            data-testid="channel-name"
          />
        </Field>
        <Field label="Type">
          <div class="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1 text-xs">
            <For each={CHANNEL_TYPES}>
              {(t) => (
                <button
                  type="button"
                  class="rounded-md px-2 py-1.5 font-medium capitalize transition-colors"
                  classList={{
                    "bg-accent text-white": type() === t,
                    "text-muted hover:text-ink": type() !== t,
                  }}
                  onClick={() => setType(t)}
                  data-testid={`channel-type-${t}`}
                >
                  {t}
                </button>
              )}
            </For>
          </div>
        </Field>
        <Field label="Tier">
          <TierSelect tiers={tiers.data} value={tier()} onChange={setTier} testid="channel-tier" />
        </Field>
        <Field label="Topic" hint="(optional)">
          <input
            class="input"
            value={topic()}
            onInput={(e) => setTopic(e.currentTarget.value)}
            disabled={busy()}
            data-testid="channel-topic"
          />
        </Field>
        <ErrorLine message={error()} testid="create-channel-error" />
        <div class="flex justify-end gap-2">
          <button type="button" class="btn-ghost" onClick={props.onClose} disabled={busy()}>
            Cancel
          </button>
          <button
            type="submit"
            class="btn-accent"
            disabled={busy()}
            data-testid="create-channel-submit"
          >
            {busy() ? "Creating…" : "Create channel"}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export const ManageChannelModal: Component<{
  groupId: string;
  channel: Channel;
  onClose: () => void;
}> = (props) => {
  const tiers = useQuery(tiersQuery);
  const invalidate = useInvalidateGroup();
  const [name, setName] = createSignal(props.channel.name ?? "");
  const [tier, setTier] = createSignal(props.channel.tier);
  const [topic, setTopic] = createSignal(props.channel.topic ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Per-channel permissions (§5.2.1). Seed each action's roles from the channel.
  const initialPerms = (props.channel.permissions ?? {}) as Record<string, string[] | undefined>;
  const [perms, setPerms] = createStore<Record<string, string>>(
    Object.fromEntries(PERMISSION_FIELDS.map((f) => [f.key, joinRoles(initialPerms[f.key])])),
  );
  const [replyOnlyTo, setReplyOnlyTo] = createStore<Record<string, boolean>>(
    Object.fromEntries(
      REPLY_PARENT_TYPES.map((t) => [t, (initialPerms.replyOnlyTo ?? []).includes(t)]),
    ),
  );

  /** Assemble the ChannelPermissions object from the form (empty → clear). */
  const buildPermissions = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const f of PERMISSION_FIELDS) {
      const arr = roleList(perms[f.key] ?? "");
      if (arr.length > 0) out[f.key] = arr;
    }
    const rot = REPLY_PARENT_TYPES.filter((t) => replyOnlyTo[t]);
    if (rot.length > 0) out.replyOnlyTo = [...rot];
    return out;
  };

  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      await updateChannel(client, props.groupId, props.channel.id, {
        name: name().trim(),
        tier: tier(),
        topic: topic().trim(),
        permissions: buildPermissions(),
      });
      invalidate(props.groupId);
      props.onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not update the channel."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this channel? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      const client = sessionClient();
      if (!client) throw new Error("not authenticated");
      await deleteChannel(client, props.groupId, props.channel.id);
      invalidate(props.groupId);
      props.onClose();
    } catch (err) {
      setError(errorMessage(err, "Could not delete the channel."));
      setBusy(false);
    }
  };

  return (
    <Modal title="Manage channel" onClose={props.onClose} testid="manage-channel-modal">
      <form class="flex flex-col gap-4" onSubmit={save}>
        <Field label="Name">
          <input
            class="input"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            disabled={busy()}
            data-testid="manage-channel-name"
          />
        </Field>
        <Field label="Type" hint="(immutable)">
          <input class="input capitalize text-muted" value={props.channel.type} disabled />
        </Field>
        <Field label="Tier">
          <TierSelect
            tiers={tiers.data}
            value={tier()}
            onChange={setTier}
            testid="manage-channel-tier"
          />
        </Field>
        <Field label="Topic">
          <input
            class="input"
            value={topic()}
            onInput={(e) => setTopic(e.currentTarget.value)}
            disabled={busy()}
          />
        </Field>

        {/* Per-channel permissions (§5.2.1). Roles are comma-separated; blank
            inherits the group/tier default. */}
        <details class="rounded-lg border border-border" data-testid="channel-permissions">
          <summary class="cursor-pointer px-3 py-2 text-xs font-medium text-muted">
            Permissions (advanced)
          </summary>
          <div class="flex flex-col gap-3 px-3 pb-3">
            <For each={PERMISSION_FIELDS}>
              {(f) => (
                <Field label={f.label} hint={f.hint}>
                  <input
                    class="input"
                    placeholder="e.g. admin, member"
                    value={perms[f.key] ?? ""}
                    onInput={(e) => setPerms(f.key, e.currentTarget.value)}
                    disabled={busy()}
                    data-testid={`perm-${f.key}`}
                  />
                </Field>
              )}
            </For>
            <Show when={roleList(perms.replyOnly ?? "").length > 0}>
              <Field
                label="Reply-only: allowed parent types"
                hint="replies must target one of these"
              >
                <div class="flex gap-3 text-xs">
                  <For each={REPLY_PARENT_TYPES}>
                    {(t) => (
                      <label class="flex items-center gap-1 capitalize">
                        <input
                          type="checkbox"
                          checked={replyOnlyTo[t]}
                          onChange={(e) => setReplyOnlyTo(t, e.currentTarget.checked)}
                          data-testid={`reply-only-to-${t}`}
                        />
                        {t}
                      </label>
                    )}
                  </For>
                </div>
              </Field>
            </Show>
          </div>
        </details>

        <ErrorLine message={error()} testid="manage-channel-error" />
        <div class="flex items-center justify-between gap-2">
          <button
            type="button"
            class="btn-ghost text-xs hover:(border-danger text-danger)"
            onClick={remove}
            disabled={busy()}
            data-testid="delete-channel"
          >
            Delete channel
          </button>
          <div class="flex gap-2">
            <button type="button" class="btn-ghost" onClick={props.onClose} disabled={busy()}>
              Cancel
            </button>
            <button type="submit" class="btn-accent" disabled={busy()} data-testid="save-channel">
              {busy() ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
};
