/**
 * Fetches the live model list from the upstream OpenAI-compatible `/models`
 * endpoint and regenerates the pinned catalog in `src/provider/models.ts`.
 *
 * Usage:
 *   bun run scripts/update-models.ts [--provider zai|bigmodel] [--api-key KEY]
 *                                    [--config config.yaml] [--check]
 *
 * API key resolution order: --api-key > $ZAI_API_KEY / $BIGMODEL_API_KEY >
 * `auth.apiKey` from the config file (default ./config.yaml).
 *
 * Merge policy:
 *   - ids present in both keep their pinned specs (contextWindow etc.).
 *   - new remote ids are added with conservative defaults and reported, so
 *     their specs can be verified by hand afterwards.
 *   - pinned ids missing from the remote list are kept (appended last) and
 *     reported, since the endpoint may not reflect the full coding-plan tier.
 *
 * `--check` only prints the diff and exits non-zero when it is non-empty.
 */
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { getProvider, type ProviderId } from "../src/provider/providers.js";
import { MODELS } from "../src/provider/models.js";
import type { ModelDef } from "../src/provider/types.js";

const OUT_FILE = new URL("../src/provider/models.ts", import.meta.url);

interface Args {
  provider: ProviderId;
  apiKey?: string;
  configPath: string;
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { provider: "zai", configPath: "config.yaml", check: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--provider": {
        const v = argv[++i];
        if (v !== "zai" && v !== "bigmodel") throw new Error(`--provider must be zai|bigmodel, got "${v}"`);
        args.provider = v;
        break;
      }
      case "--api-key":
        args.apiKey = argv[++i];
        break;
      case "--config":
        args.configPath = argv[++i];
        break;
      case "--check":
        args.check = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function resolveApiKey(args: Args): string {
  if (args.apiKey) return args.apiKey;
  const envKey = args.provider === "zai" ? process.env.ZAI_API_KEY : process.env.BIGMODEL_API_KEY;
  if (envKey) return envKey;
  if (existsSync(args.configPath)) {
    const cfg = parse(readFileSync(args.configPath, "utf8")) as { auth?: { apiKey?: string } } | null;
    if (cfg?.auth?.apiKey) return cfg.auth.apiKey;
  }
  throw new Error(
    `No API key found. Pass --api-key, set $${args.provider === "zai" ? "ZAI_API_KEY" : "BIGMODEL_API_KEY"},` +
      ` or provide auth.apiKey in ${args.configPath}.`,
  );
}

async function fetchRemoteModelIds(baseURL: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET ${baseURL}/models failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(body.data)) {
    throw new Error(`Unexpected /models response shape: missing data array`);
  }
  const ids = body.data.map((m) => m.id).filter((id): id is string => typeof id === "string");
  // The coding-plan catalog is GLM-only; drop anything else the account can see.
  return [...new Set(ids.filter((id) => /^glm-/i.test(id)))];
}

/** Derive a display name from an id: "glm-5.3-flash" -> "GLM 5.3 Flash". */
function displayName(id: string): string {
  return id
    .replace(/^glm-/i, "GLM-")
    .split("-")
    .map((part) => (part === "GLM" ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function render(models: ModelDef[]): string {
  const lines = models.map((m) => {
    const fields = [
      `id: ${JSON.stringify(m.id)}`,
      `name: ${JSON.stringify(m.name)}`,
      `contextWindow: ${m.contextWindow.toLocaleString("en-US").replaceAll(",", "_")}`,
      `maxOutputTokens: ${(m.maxOutputTokens ?? 128_000).toLocaleString("en-US").replaceAll(",", "_")}`,
    ];
    if (m.reasoning) fields.push(`reasoning: true`);
    return `  { ${fields.join(", ")} },`;
  });
  return `/**
 * Pinned model catalog for GLM coding plan.
 *
 * Hardcoded to the exact models available on the Z.AI / Bigmodel coding-plan
 * tier. Regenerate with \`bun run update-models\` (see scripts/update-models.ts);
 * verify specs (contextWindow / reasoning) of newly added entries by hand.
 */
import type { ModelDef } from "./types.js";

/** All models available on the GLM coding plan, pinned with verified specs. */
export const MODELS: ModelDef[] = [
${lines.join("\n")}
];
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = getProvider(args.provider);
  const apiKey = resolveApiKey(args);

  const remoteIds = await fetchRemoteModelIds(provider.openaiBaseURL, apiKey);
  console.log(`Remote (${provider.id}) reports ${remoteIds.length} GLM models: ${remoteIds.join(", ")}`);

  const pinned = new Map(MODELS.map((m) => [m.id, m]));
  const merged: ModelDef[] = [];
  const added: string[] = [];

  for (const id of remoteIds) {
    const known = pinned.get(id);
    if (known) {
      merged.push(known);
      pinned.delete(id);
    } else {
      merged.push({ id, name: displayName(id), contextWindow: 200_000, maxOutputTokens: 128_000 });
      added.push(id);
    }
  }
  // Keep pinned ids the remote list did not mention, appended at the end.
  const keptOnly = [...pinned.values()];
  merged.push(...keptOnly);

  for (const id of added) {
    console.warn(`NEW model "${id}" added with default specs (200k context, no reasoning flag) — verify by hand.`);
  }
  for (const m of keptOnly) {
    console.warn(`Pinned model "${m.id}" not in remote list — kept; remove manually if retired.`);
  }

  const changed =
    added.length > 0 ||
    keptOnly.length > 0 ||
    merged.length !== MODELS.length ||
    merged.some((m, i) => m.id !== MODELS[i]?.id);

  if (!changed) {
    console.log("Catalog already up to date.");
    return;
  }
  if (args.check) {
    console.error("Catalog is stale (see diff above).");
    process.exit(1);
  }

  await Bun.write(OUT_FILE, render(merged));
  console.log(`Wrote ${merged.length} models to src/provider/models.ts`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
