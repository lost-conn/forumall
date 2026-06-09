/**
 * Ajv loader for the OFSCP v0.1 JSON Schemas — the spec's OWN schemas, referenced
 * by path from the sibling `ofscp` repo (SSOT; never copied in).
 *
 * This mirrors the wiring in `ofscp/tests/validate-schemas.mjs`:
 *  - Ajv 2020-12 dialect, `strict:false`, `allErrors:true`.
 *  - The six `defs/*.json` are pre-added with `addSchema`.
 *  - Relative `./defs/...` $refs (resolved by Ajv against each schema's absolute
 *    `https://example.invalid/...$id`) are fetched by a `loadSchema` that maps the
 *    path back into `schemas/v0.1/`.
 *
 * Validating real provider responses against these schemas is strictly stronger
 * than the zod mirror in `@forumall/shared`: it proves the wire bytes satisfy the
 * authoritative contract, not our re-encoding of it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";

/** Absolute path to the sibling ofscp repo (SSOT for schemas + samples).
 *  Resolved relative to this file (`packages/server/test/helpers/` → up five to
 *  the repo's parent) so it works on any machine, not just the author's box. */
export const OFSCP_REPO = fileURLToPath(new URL("../../../../../ofscp", import.meta.url));
const SCHEMA_ROOT = join(OFSCP_REPO, "schemas", "v0.1");

function loadJson(absPath: string): unknown {
  return JSON.parse(readFileSync(absPath, "utf8"));
}

/**
 * Resolve a schema $ref (relative `./…` or the absolute `…/schemas/v0.1/…` id)
 * back to an on-disk path under `schemas/v0.1/`.
 */
function refToPath(uri: string): string {
  const clean = uri.split("#")[0] ?? "";
  if (clean.startsWith("./")) {
    return join(SCHEMA_ROOT, clean.replace(/^\.\//, ""));
  }
  const marker = "/schemas/v0.1/";
  const idx = clean.indexOf(marker);
  if (idx !== -1) {
    return join(SCHEMA_ROOT, clean.slice(idx + marker.length));
  }
  throw new Error(`Unsupported $ref for the OFSCP schema loader: ${uri}`);
}

const DEFS = [
  "defs/common.json",
  "defs/objects.json",
  "defs/identity.json",
  "defs/privacy.json",
  "defs/messaging.json",
  "defs/groups.json",
];

/** A function that validates a value and exposes Ajv's `errors` on failure. */
export interface SchemaValidator {
  (value: unknown): boolean;
  errors?: unknown;
}

/**
 * Build a compiler bound to one Ajv instance with the `defs/` pre-loaded. Returns
 * an async `compile(schemaFile)` that takes a filename relative to `schemas/v0.1/`
 * (e.g. `"group.json"` or `"ws/message-created.json"`).
 */
export function makeOfscpCompiler(): (schemaFile: string) => Promise<SchemaValidator> {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    loadSchema: async (uri: string) => loadJson(refToPath(uri)) as object,
  });
  // ajv-formats ships CJS; the default export is the registrar.
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);

  for (const def of DEFS) {
    ajv.addSchema(loadJson(join(SCHEMA_ROOT, def)) as object);
  }

  return async (schemaFile: string): Promise<SchemaValidator> => {
    const schema = loadJson(join(SCHEMA_ROOT, schemaFile)) as { $id?: string };
    // A schema may already be registered under its absolute `$id` because some
    // *other* schema $ref'd it (Ajv auto-adds those during compileAsync). In that
    // case fetch the existing validator instead of re-adding (which throws on a
    // duplicate id).
    if (schema.$id) {
      const existing = ajv.getSchema(schema.$id);
      if (existing) return existing as SchemaValidator;
    }
    return (await ajv.compileAsync(schema as object)) as SchemaValidator;
  };
}

/** Read an OFSCP sample fixture (e.g. `"problem-details.sample.json"`). */
export function readOfscpSample(name: string): unknown {
  return loadJson(join(OFSCP_REPO, "tests", name));
}
