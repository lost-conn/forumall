import { clientForHost } from "../../lib/federation.ts";
import {
  channelIdFromRef,
  fetchFollows,
  groupIdFromChannelRef,
  hostForRef,
} from "../../lib/feed-api.ts";
import { fetchChannel, fetchGroup } from "../../lib/groups-api.ts";
import { keyStore } from "../../lib/key-store.ts";
import type { OfscpClient } from "../../lib/ofscp-client.ts";
/**
 * Home-feed controller (P8, spec §7.6) — composes the "follows" timeline
 * CLIENT-SIDE from the follow pointers. The server stores no feed; this is where
 * the read + subscribe + merge + prune happens.
 *
 * `startFeed()` (driven from {@link HomeFeed}'s `onMount`):
 *   1. reads the follow list over REST (`GET /api/me/follows`),
 *   2. for EACH followed channel, opens it via the shared {@link openChannel}
 *      (chat-controller) — which loads recent history over REST AND subscribes for
 *      live updates over the channel's source WS, folding every `message.created /
 *      updated / deleted` into the shared chat store keyed by channel id,
 *   3. the merged, time-ordered, de-duped timeline is then a pure derivation over
 *      that store (`stores/feed.ts#mergedTimeline`) — so live events, in-place
 *      edits and tombstones on any followed channel update Home automatically,
 *   4. if a channel's reads start failing / access is lost, the stale pointer is
 *      PRUNED from the feed (it drops out of the timeline; the follow row remains
 *      on the server until the user unfollows).
 *
 * ## Sources: local now, per-host registry for federation later
 * Each followed channel is read+subscribed against ITS source provider's WS. The
 * home provider's channels use the live session WS; a foreign (remote) channel —
 * not produced in this local run, but supported for a future federation run —
 * gets its own authenticated WS via the {@link OfscpWsRegistry}, keyed by host.
 */
import { OfscpWsRegistry } from "../../lib/ofscp-ws.ts";
import type { OfscpWsClient } from "../../lib/ofscp-ws.ts";
import { baseUrlForHost } from "../../lib/provider.ts";
import { upsertChannel } from "../../stores/chat.ts";
import { type FollowedChannel, pruneFollow, setFollowMeta, setFollows } from "../../stores/feed.ts";
import { type ChannelHandle, openChannel } from "../chat/chat-controller.ts";

/** Per-host WS registry for foreign sources (federation-ready). */
const registry = new OfscpWsRegistry();

/** A running feed: the open per-channel handles + a teardown. */
export interface FeedHandle {
  /** Re-read the follow list and reconcile open channels (after a follow toggle). */
  refresh(): Promise<void>;
  /** Tear down every open channel + close any foreign-source WS. */
  close(): void;
}

interface FeedDeps {
  client: OfscpClient;
  /** The live home-provider WS (session WS) for local-channel sources. */
  homeWs: OfscpWsClient;
  /** The home provider host (signing authority) — local channels live here. */
  homeHost: string;
  /** The authenticated actor (for foreign-source WS auth). */
  actor: string;
  /** The active device key id (for foreign-source WS auth). */
  keyId: string;
}

/** One open source channel: its chat-controller handle + the WS it rode in on. */
interface OpenSource {
  handle: ChannelHandle;
  host: string;
}

/**
 * Start composing the home feed. Reads the follow list and opens each followed
 * channel; returns a handle to refresh (on a follow change) and tear down.
 */
export async function startFeed(deps: FeedDeps): Promise<FeedHandle> {
  const open = new Map<string, OpenSource>();

  /** Resolve the WS client for a source host (session WS for home; registry else). */
  async function wsForHost(host: string): Promise<OfscpWsClient> {
    if (host === deps.homeHost) return deps.homeWs;
    // Foreign source (federation): an authenticated per-host client signed by the
    // home key (the peer resolves it via §8.5 step 3 / §4.6).
    const privateKey = await keyStore.getKey(deps.keyId);
    if (!privateKey) throw new Error("device private key missing");
    const base = baseUrlForHost(host);
    const ws = registry.get({
      host,
      actor: deps.actor,
      keyId: deps.keyId,
      privateKey,
      url: `${base.replace(/^http/, "ws")}/api/ws`,
    });
    if (ws.state === "idle" || ws.state === "closed") {
      await ws.connect().catch(() => undefined);
    }
    return ws;
  }

  /**
   * Resolve the signing client for a source host's REST reads (history/metadata).
   * Home → the session client; a peer → a per-host client signed by the home key,
   * with `authority = host` (the peer resolves the key via §4.6).
   */
  async function clientForSource(host: string): Promise<OfscpClient> {
    if (host === deps.homeHost) return deps.client;
    const privateKey = await keyStore.getKey(deps.keyId);
    if (!privateKey) throw new Error("device private key missing");
    return clientForHost(host, { actor: deps.actor, keyId: deps.keyId, privateKey });
  }

  /** Open one followed channel (history + live subscribe), or prune on failure. */
  async function openOne(f: FollowedChannel): Promise<void> {
    if (open.has(f.channelId)) return;
    // A bare/local channel ref needs its owning group id to read history. The
    // follow pointer SHOULD carry it; if missing we cannot read it → prune.
    const groupId = f.groupId;
    if (!groupId) {
      pruneFollow(f.channelId);
      return;
    }
    try {
      const ws = await wsForHost(f.host);
      const client = await clientForSource(f.host);
      const handle = await openChannel({
        client,
        ws,
        groupId,
        channelId: f.channelId,
      });
      open.set(f.channelId, { handle, host: f.host });
      // Resolve display metadata (channel + group names) for the feed item header,
      // read from the SOURCE provider (home or peer).
      void hydrateMeta(client, f);
    } catch {
      // Reads failed / access lost → drop the stale pointer from the feed (§7.6).
      pruneFollow(f.channelId);
    }
  }

  /** Read the follow list and open every channel, closing ones no longer followed. */
  async function load(): Promise<void> {
    const raw = await fetchFollows(deps.client);
    const list: FollowedChannel[] = raw.map((follow) => {
      const host = hostForRef(follow.channel, deps.homeHost);
      // The bare channel id (the source provider's WS `channelId` + chat-store key)
      // works for a bare local id, a local channel URI, AND a remote channel URI.
      const channelId = channelIdFromRef(follow.channel) ?? follow.channel;
      // Owning group: the follow pointer carries it for a local follow; a remote
      // follow URI encodes it in the path (`…/groups/{g}/channels/{c}`).
      const groupId = follow.groupId ?? groupIdFromChannelRef(follow.channel) ?? undefined;
      return {
        channelId,
        ref: follow.channel,
        ...(groupId ? { groupId } : {}),
        host,
      };
    });
    setFollows(list);

    // Close channels no longer in the follow list.
    const wanted = new Set(list.map((f) => f.channelId));
    for (const [id, src] of open) {
      if (!wanted.has(id)) {
        src.handle.close();
        open.delete(id);
      }
    }
    // Open any new ones.
    await Promise.all(list.map((f) => openOne(f)));
  }

  await load();

  return {
    refresh: load,
    close(): void {
      for (const src of open.values()) src.handle.close();
      open.clear();
      registry.closeAll();
    },
  };
}

/**
 * Resolve a followed channel's display metadata (channel name + group name) for
 * the feed item header. Best-effort: failures leave the ids showing.
 */
async function hydrateMeta(client: OfscpClient, f: FollowedChannel): Promise<void> {
  if (!f.groupId) return;
  try {
    const [channel, group] = await Promise.all([
      fetchChannel(client, f.groupId, f.channelId).catch(() => null),
      fetchGroup(client, f.groupId).catch(() => null),
    ]);
    if (channel) {
      upsertChannel({
        id: f.channelId,
        groupId: f.groupId,
        ...(channel.name ? { name: channel.name } : {}),
        type: channel.type,
        tier: channel.tier,
      });
    }
    setFollowMeta(f.channelId, {
      ...(channel?.name ? { name: channel.name } : {}),
      ...(group?.name ? { groupName: group.name } : {}),
    });
  } catch {
    /* best-effort metadata; the feed still renders with ids */
  }
}
