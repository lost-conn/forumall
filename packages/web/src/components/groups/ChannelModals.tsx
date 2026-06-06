/**
 * Create / manage channel modals (P8, §5.5). Create takes name, type
 * (text/call), tier, topic; manage edits name/tier/topic or deletes (type is
 * immutable server-side). Manager-only — gated by the caller in the group view.
 */
import type { Channel, ChannelType } from "@forumall/shared";
import { useQuery } from "@tanstack/solid-query";
import { type Component, For, createSignal } from "solid-js";
import { createChannel, deleteChannel, updateChannel } from "../../lib/groups-api.ts";
import { sessionClient } from "../../stores/session.ts";
import { tiersQuery, useInvalidateGroup } from "./queries.ts";
import { ErrorLine, Field, Modal, TierSelect, errorMessage } from "./ui.tsx";

const CHANNEL_TYPES: ChannelType[] = ["text", "call"];

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
