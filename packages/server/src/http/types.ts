/**
 * Shared Hono typing for the app and its routers.
 *
 * `Variables` are populated by middleware in {@link createApp} and read via
 * `c.var` in handlers. Feature cards extend `Variables` (e.g. an authenticated
 * `actor`) by adding to this interface.
 */
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";

export interface AppVariables {
  readonly config: Config;
  readonly db: Db;
}

export interface AppBindings {
  Variables: AppVariables;
}
