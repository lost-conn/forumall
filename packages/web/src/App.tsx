import { OFSCP_VERSION } from "@forumall/shared";
import type { Component } from "solid-js";

export const App: Component = () => {
  return (
    <main class="min-h-screen flex flex-col items-center justify-center gap-2 bg-neutral-950 text-neutral-100">
      <h1 class="text-3xl font-bold">Forumall</h1>
      <p class="text-neutral-400">OFSCP provider + client · v{OFSCP_VERSION}</p>
    </main>
  );
};
