import process from "node:process";
import unocss from "unocss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Combined local dev: forward API + WS from the :5173 dev client to the Hono
// provider so the client works same-origin (HMR on :5173) without typing a
// provider host. Override the upstream with VITE_PROXY_TARGET.
//
// Authority note (§4.4.2): the proxy is transport only. The client signs with
// its origin (`localhost:5173`) as the authority, so the provider must run with
// `DOMAIN=localhost:5173` for signatures to verify against the dev origin.
const proxyTarget = process.env.VITE_PROXY_TARGET ?? "http://localhost:3000";

export default defineConfig({
  plugins: [unocss(), solid()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: proxyTarget,
        ws: true,
      },
    },
  },
});
