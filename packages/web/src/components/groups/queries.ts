/**
 * TanStack solid-query factories for the groups UI (P8).
 *
 * Centralizes the query keys + fetchers so the screens share one cache and
 * invalidation is consistent. Every fetcher resolves the live signing client
 * from the session store at call time (so it always uses the current identity).
 */
import { useQueryClient } from "@tanstack/solid-query";
import {
  fetchGroup,
  fetchMyGroups,
  fetchTiers,
  listChannels,
  listInvites,
  listJoinRequests,
  listMembers,
} from "../../lib/groups-api.ts";
import { sessionClient } from "../../stores/session.ts";

function client() {
  const c = sessionClient();
  if (!c) throw new Error("not authenticated");
  return c;
}

export const groupsKeys = {
  myGroups: () => ["groups", "mine"] as const,
  group: (id: string) => ["groups", "one", id] as const,
  channels: (id: string) => ["groups", id, "channels"] as const,
  members: (id: string) => ["groups", id, "members"] as const,
  requests: (id: string) => ["groups", id, "requests"] as const,
  invites: (id: string) => ["groups", id, "invites"] as const,
  tiers: () => ["tiers"] as const,
};

export const myGroupsQuery = () => ({
  queryKey: groupsKeys.myGroups(),
  queryFn: () => fetchMyGroups(client()),
});

export const groupQuery = (id: () => string) => ({
  queryKey: groupsKeys.group(id()),
  queryFn: () => fetchGroup(client(), id()),
  enabled: !!id(),
});

export const channelsQuery = (id: () => string) => ({
  queryKey: groupsKeys.channels(id()),
  queryFn: () => listChannels(client(), id()),
  enabled: !!id(),
});

export const membersQuery = (id: () => string, enabled: () => boolean) => ({
  queryKey: groupsKeys.members(id()),
  queryFn: () => listMembers(client(), id()),
  get enabled() {
    return !!id() && enabled();
  },
});

export const requestsQuery = (id: () => string, enabled: () => boolean) => ({
  queryKey: groupsKeys.requests(id()),
  queryFn: () => listJoinRequests(client(), id()),
  get enabled() {
    return !!id() && enabled();
  },
});

export const invitesQuery = (id: () => string, enabled: () => boolean) => ({
  queryKey: groupsKeys.invites(id()),
  queryFn: () => listInvites(client(), id()),
  get enabled() {
    return !!id() && enabled();
  },
});

export const tiersQuery = () => ({
  queryKey: groupsKeys.tiers(),
  queryFn: () => fetchTiers(client()),
  staleTime: 5 * 60_000,
});

/** Invalidate everything scoped to one group (after a mutation). */
export function useInvalidateGroup() {
  const qc = useQueryClient();
  return (id: string) => {
    qc.invalidateQueries({ queryKey: ["groups", "one", id] });
    qc.invalidateQueries({ queryKey: ["groups", id] });
    qc.invalidateQueries({ queryKey: groupsKeys.myGroups() });
  };
}
