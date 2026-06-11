/**
 * Egress-diagnostic TCP probe — deterministic, offline. Exercises {@link tcpConnect}
 * against a real local listener (ok) and a closed port (refused), so the helper the
 * `/api/push/_egress-check` endpoint relies on is covered without touching the
 * network or a real push service.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";

import { tcpConnect } from "../src/provider/push-egress-check.ts";

let server: net.Server;
let openPort: number;
let closedPort: number;

beforeAll(async () => {
  // Bind a listener → its port is reachable (ok). Bind+close a second → refused.
  server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openPort = (server.address() as net.AddressInfo).port;

  const scratch = net.createServer();
  await new Promise<void>((resolve) => scratch.listen(0, "127.0.0.1", resolve));
  closedPort = (scratch.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => scratch.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("tcpConnect (egress probe)", () => {
  test("connects to an open port", async () => {
    const r = await tcpConnect("127.0.0.1", openPort, 2000);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  test("reports an error for a closed port (refused)", async () => {
    const r = await tcpConnect("127.0.0.1", closedPort, 2000);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });
});
