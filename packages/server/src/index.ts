import { OFSCP_VERSION } from "@forumall/shared";
import { Hono } from "hono";

export const app = new Hono();

app.get("/", (c) =>
  c.json({
    name: "forumall",
    message: "hello",
    ofscp: OFSCP_VERSION,
  }),
);

const port = Number(process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
};
