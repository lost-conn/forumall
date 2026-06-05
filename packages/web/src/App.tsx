import { Route, Router } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import type { Component } from "solid-js";
import { AppShell } from "./components/AppShell";
import {
  DmsPage,
  GroupChannelPage,
  HomePage,
  LoginPage,
  NotFoundPage,
  SettingsPage,
} from "./routes/pages";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

export const App: Component = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <Router root={AppShell}>
        <Route path="/" component={HomePage} />
        <Route path="/login" component={LoginPage} />
        <Route path="/groups/:groupId?/:channelId?" component={GroupChannelPage} />
        <Route path="/dms/:dmId?" component={DmsPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="*" component={NotFoundPage} />
      </Router>
    </QueryClientProvider>
  );
};
