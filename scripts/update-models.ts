/**
 * Regenerates the pinned catalog in `src/provider/models.ts` by probing the
 * *Anthropic* endpoint the proxy actually uses, one model at a time.
 *
 * Why not `GET {openaiBaseURL}/models`? Verified live on 2026-08-29:
 *   1. The runtime never calls it. On the default coding-plan the proxy sets
 *      `upstreamFormat = "anthropic"` (see src/proxy/handler.ts) and talks to
 *      `{anthropicBaseURL}/v1/messages`, which the server then rewrites via
 *      `GET {zcodeApiBase}/api/v1/agent/configs` (see
 *      src/proxy/endpoint-routing.ts). ZCode's own catalog declares the
 *      coding-plan provider as `kinds: ["anthropic"]` only.
 *   2. Its list is not exhaustive — ids like `glm-4.6v`, `glm-4.7-flash`,
 *      `glm-4.1v-thinking-flash` etc. are absent from it yet work fine on the
 *      Anthropic endpoint.
 *   3. Its list over-reports — `glm-5`, `glm-5.1`, `glm-5.2` and
 *      `glm-4.5-air` are listed but the gateway silently aliases them to a
 *      newer id (e.g. `glm-5.3`, `glm-4.7`) at generation time.
 * So `/models` is kept only as a non-authoritative *discovery hint* for ids
 * that might be new to the vendor; it is never trusted for availability.
 *
 * Two-stage probe (the actual source of truth), per candidate id, against
 * `{anthropicBaseURL}/v1/messages` with `x-api-key` + `anthropic-version`:
 *
 *   Stage 1 — cheap ceiling probe: POST with `max_tokens: 999999`. This is
 *   guaranteed to exceed every real cap, so the gateway rejects it before
 *   generating a single token — free of charge — with a `400 [1210]` error
 *   whose message embeds the real per-model `max_tokens` ceiling. A `400
 *   [1214]` means the id does not exist at all: no stage 2 needed.
 *
 *   Stage 2 — real minimal generation: POST with `max_tokens: 16` and one
 *   short user message. This is NOT optional. It was empirically observed
 *   that `glm-5.1-highspeed` passes stage 1 (a clean `[1210]` ceiling,
 *   looking fully available) but a real generation on it returns `403
 *   [1220] You do not have permission` — parameter validation happens
 *   before the permission check for some models. Only ids that pass BOTH
 *   stages are written into the catalog as available. Stage 2's response
 *   `model` field is also compared against the requested id to catch
 *   server-side aliasing (e.g. `glm-5.2` silently resolving to `glm-5.3`);
 *   mismatches are reported, never silently dropped.
 *
 * Response classification (matched on the numeric `[NNNN]` error code the
 * gateway embeds in the message body, not on HTTP status alone):
 *   400 [1210] max_tokens illegal, "...范围[1,N]"  -> resolved; N = ceiling
 *   400 [1214] modelCode: does not exist           -> does not exist
 *   403 [1220] You do not have permission          -> exists, no access
 *   429 [1311] ...subscription plan does not...    -> exists, plan-gated
 *   429 [1113] Insufficient balance                -> exists, pay-per-token
 *   529 [1305] service may be temporarily overloaded -> TRANSIENT, retry
 * A 200 response is a real (unexpected at stage 1) generation success.
 *
 * Candidate id set = pinned MODELS ids ∪ `/models` discovery hint ∪ a
 * hardcoded list of ids known from ZCode's client catalog that `/models`
 * omits. `--pinned-only` restricts probing to just the pinned ids.
 *
 * Merge policy:
 *   - pinned id, probe available            -> kept with its pinned specs
 *     (contextWindow/reasoning are hand-verified and cannot be discovered
 *     by probing, so they are never overwritten).
 *   - pinned id, probe hard-fails            -> REMOVED, reported loudly
 *     (this is new: the old script could only ever add/keep).
 *   - pinned id, probe inconclusive          -> kept, reported as unverified.
 *   - new id, probe available                -> ADDED; maxOutputTokens is
 *     the probed ceiling (no longer a blanket 128_000 default);
 *     contextWindow and reasoning still need hand verification (logged).
 *   - new id, probe hard-fails/inconclusive  -> not added.
 *
 * Usage:
 *   bun run scripts/update-models.ts [--provider zai|bigmodel] [--api-key KEY]
 *                                    [--config config.yaml] [--check]
 *                                    [--pinned-only] [--dry-run]
 *
 * API key resolution order: --api-key > $ZAI_API_KEY / $BIGMODEL_API_KEY >
 * `auth.apiKey` from the config file (default ./config.yaml).
 *
 * `--check` only prints the diff and exits non-zero when it is non-empty.
 * `--dry-run` prints the candidate set and the number of requests that
 * would be issued, then exits before issuing any of them.
 * `--pinned-only` limits the candidate set to the currently-pinned ids
 * (skips the `/models` discovery hint and the hardcoded extra list).
 *
 * This script is deliberately not run against the live API as part of
 * development/verification — real generations cost the account owner's
 * tokens. It is exercised via `scripts/update-models.test.ts` against
 * synthetic response bodies instead.
 */
import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { getProvider } from "../src/provider/providers.js";
import { MODELS } from "../src/provider/models.js";
import type { ModelDef, ProviderId } from "../src/provider/types.js";

const OUT_FILE = new URL("../src/provider/models.ts", import.meta.url);

const ANTHROPIC_VERSION = "2023-06-01";
const STAGE1_MAX_TOKENS = 999_999;
const STAGE2_MAX_TOKENS = 16;
const MAX_PROBE_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;
const INTER_REQUEST_DELAY_MS = 150;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_OUTPUT_TOKENS = 128_000;

/**
 * Ids known from ZCode's desktop client catalog that the coding-plan
 * `/models` endpoint does not list, but that may still resolve on the
 * Anthropic endpoint. Discovery hint only — still probed like any other
 * candidate before being trusted.
 */
const HARDCODED_EXTRA_IDS: readonly string[] = [
  "glm-5.1-highspeed",
  "glm-4.7-flash",
  "glm-4.7-flashx",
  "glm-4.6v",
  "glm-4.6v-flash",
  "glm-4.6v-flashx",
  "glm-4.1v-thinking-flash",
  "glm-4.1v-thinking-flashx",
  "glm-4-flash-250414",
  "glm-4-flashx-250414",
  "glm-4v-flash",
  "glm-5v-turbo",
  "codegeex-4",
];

interface Args {
  provider: ProviderId;
  apiKey?: string;
  configPath: string;
  check: boolean;
  pinnedOnly: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    provider: "zai",
    configPath: "config.yaml",
    check: false,
    pinnedOnly: false,
    dryRun: false,
  };
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
      case "--pinned-only":
        args.pinnedOnly = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function resolveApiKey(args: Args): string {
  let key: string | undefined = args.apiKey;
  if (!key) {
    key = args.provider === "zai" ? process.env.ZAI_API_KEY : process.env.BIGMODEL_API_KEY;
  }
  if (!key && existsSync(args.configPath)) {
    const cfg = parse(readFileSync(args.configPath, "utf8")) as { auth?: { apiKey?: string } } | null;
    key = cfg?.auth?.apiKey;
  }
  key = key?.trim();
  if (!key) {
    throw new Error(
      `No API key found. Pass --api-key, set $${args.provider === "zai" ? "ZAI_API_KEY" : "BIGMODEL_API_KEY"},` +
        ` or provide auth.apiKey in ${args.configPath}.`,
    );
  }
  if (/[\r\n]/.test(key)) {
    throw new Error("API key contains newline characters — check for quoting issues in your env var or config file.");
  }
  return key;
}

// ---------------------------------------------------------------------------
// Pure functions: response classification, ceiling parsing, alias detection,
// merge policy. Exported and covered by scripts/update-models.test.ts against
// synthetic response bodies — no network I/O in tests.
// ---------------------------------------------------------------------------

/** Result of classifying one raw Anthropic-endpoint response. */
export type ProbeVerdict =
  | { kind: "ceiling"; maxTokens: number }
  | { kind: "not-found" }
  | { kind: "no-permission" }
  | { kind: "plan-restricted" }
  | { kind: "insufficient-balance" }
  | { kind: "transient" }
  | { kind: "success"; model?: string }
  | { kind: "unknown"; status: number; snippet: string };

/**
 * Extracts the gateway's numeric `[NNNN]` error code from a response body,
 * e.g. `"[1210] The max_tokens parameter is illegal."` -> 1210. Deliberately
 * requires a bare digit run in the brackets (no comma) so it does not match
 * the `[1,999]` range fragment that appears later in the 1210 message.
 */
export function extractErrorCode(bodyText: string): number | null {
  const m = /\[(\d{3,5})\]/.exec(bodyText);
  return m ? Number(m[1]) : null;
}

/**
 * Extracts the real `max_tokens` ceiling N out of a `[1210]` message's
 * "...范围[1,N]" (or any "[1,N]") range fragment.
 */
export function parseCeiling(bodyText: string): number | null {
  const m = /\[1,\s*(\d+)\]/.exec(bodyText);
  return m ? Number(m[1]) : null;
}

/**
 * Classifies one raw Anthropic-endpoint response into a ProbeVerdict.
 * `bodyText` is the raw response text (JSON-enveloped or not — the gateway's
 * `[NNNN]` codes are matched as plain substrings either way).
 */
export function classifyResponse(status: number, bodyText: string): ProbeVerdict {
  if (status === 200) {
    try {
      const json = JSON.parse(bodyText) as { model?: unknown };
      return { kind: "success", model: typeof json.model === "string" ? json.model : undefined };
    } catch {
      return { kind: "success" };
    }
  }
  const code = extractErrorCode(bodyText);
  switch (code) {
    case 1210: {
      const maxTokens = parseCeiling(bodyText);
      return maxTokens != null
        ? { kind: "ceiling", maxTokens }
        : { kind: "unknown", status, snippet: bodyText.slice(0, 300) };
    }
    case 1214:
      return { kind: "not-found" };
    case 1220:
      return { kind: "no-permission" };
    case 1311:
      return { kind: "plan-restricted" };
    case 1113:
      return { kind: "insufficient-balance" };
    case 1305:
      return { kind: "transient" };
    default:
      return { kind: "unknown", status, snippet: bodyText.slice(0, 300) };
  }
}

/**
 * Compares the model id actually resolved by a real generation against the
 * id that was requested. Returns the resolved id when it differs (an alias),
 * or null when there is no mismatch to report.
 */
export function detectAlias(requestedId: string, responseModel: string | undefined): string | null {
  if (!responseModel || responseModel === requestedId) return null;
  return responseModel;
}

/** Final, post-two-stage disposition for one candidate id. */
export type FinalStatus =
  | "available"
  | "not-found"
  | "no-permission"
  | "plan-restricted"
  | "insufficient-balance"
  | "transient-unresolved"
  | "unknown";

export interface ProbeOutcome {
  id: string;
  status: FinalStatus;
  /** Gateway max_tokens ceiling, when discovered (regardless of final status). */
  maxTokens?: number;
  /** Resolved model id from a real generation, when it differs from `id`. */
  alias?: string;
  /** Extra context for "unknown"/"transient-unresolved" outcomes. */
  detail?: string;
}

export interface MergeResult {
  merged: ModelDef[];
  added: string[];
  removed: string[];
  keptUnresolved: string[];
  aliasWarnings: Array<{ id: string; resolvedModel: string }>;
  /** Newly-added ids whose ceiling could not be discovered (fell back to default). */
  unknownCeilingIds: string[];
}

/** Derive a display name from an id: "glm-5.3-flash" -> "GLM 5.3 Flash". */
export function displayName(id: string): string {
  return id
    .replace(/^glm-/i, "GLM-")
    .split("-")
    .map((part) => (part === "GLM" ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/** Dedupes a list of ids, preserving first-occurrence order. */
export function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Applies the merge policy described in the module header. `pinned` is the
 * current MODELS catalog; `outcomes` maps every probed id to its final
 * ProbeOutcome; `candidateOrder` is the full deduped candidate list (used to
 * order newly-added ids). Pure — no I/O.
 */
export function mergeCatalog(pinned: ModelDef[], outcomes: Map<string, ProbeOutcome>, candidateOrder: string[]): MergeResult {
  const pinnedIds = new Set(pinned.map((m) => m.id));
  const merged: ModelDef[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const keptUnresolved: string[] = [];
  const aliasWarnings: Array<{ id: string; resolvedModel: string }> = [];
  const unknownCeilingIds: string[] = [];

  for (const m of pinned) {
    const outcome = outcomes.get(m.id);
    if (!outcome) {
      keptUnresolved.push(m.id);
      merged.push(m);
      continue;
    }
    if (outcome.alias) aliasWarnings.push({ id: m.id, resolvedModel: outcome.alias });
    switch (outcome.status) {
      case "available":
        merged.push(m);
        break;
      case "not-found":
      case "no-permission":
      case "plan-restricted":
      case "insufficient-balance":
        removed.push(m.id);
        break;
      case "unknown":
      case "transient-unresolved":
        keptUnresolved.push(m.id);
        merged.push(m);
        break;
    }
  }

  for (const id of candidateOrder) {
    if (pinnedIds.has(id)) continue;
    const outcome = outcomes.get(id);
    if (!outcome) continue;
    if (outcome.alias) aliasWarnings.push({ id, resolvedModel: outcome.alias });
    if (outcome.status === "available") {
      const maxOutputTokens = outcome.maxTokens ?? FALLBACK_MAX_OUTPUT_TOKENS;
      if (outcome.maxTokens == null) unknownCeilingIds.push(id);
      merged.push({ id, name: displayName(id), contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens });
      added.push(id);
    }
  }

  return { merged, added, removed, keptUnresolved, aliasWarnings, unknownCeilingIds };
}

// ---------------------------------------------------------------------------
// I/O: discovery hint, two-stage probing, rendering, main.
// ---------------------------------------------------------------------------

/**
 * GET {openaiBaseURL}/models — kept only as a non-authoritative discovery
 * hint for ids that might be new to the vendor. Never treated as the answer
 * to "is this model available": see module header for why.
 */
async function fetchRemoteModelIds(baseURL: string, apiKey: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
  } catch (err) {
    const cause = err instanceof Error && err.cause ? ` (cause: ${String(err.cause)})` : "";
    throw new Error(
      `GET ${baseURL}/models failed at the network level: ${err instanceof Error ? err.message : err}${cause}\n` +
        `Check connectivity (try: curl -sS -o /dev/null -w "%{http_code}" ${baseURL}/models) and proxy settings.`,
    );
  }
  if (!res.ok) {
    throw new Error(`GET ${baseURL}/models failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(body.data)) {
    throw new Error(`Unexpected /models response shape: missing data array`);
  }
  const ids = body.data.map((m) => m.id).filter((id): id is string => typeof id === "string");
  return dedupe(ids.filter((id) => /^glm-/i.test(id)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postAnthropicProbe(
  anthropicBaseURL: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  fetchImpl: typeof fetch,
): Promise<{ status: number; bodyText: string }> {
  const res = await fetchImpl(`${anthropicBaseURL}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const bodyText = await res.text();
  return { status: res.status, bodyText };
}

/** Issues one probe request, retrying while the response classifies as transient (529 [1305]). */
async function probeWithRetries(
  anthropicBaseURL: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  fetchImpl: typeof fetch,
): Promise<ProbeVerdict> {
  let last: ProbeVerdict = { kind: "unknown", status: 0, snippet: "(no attempts made)" };
  for (let attempt = 0; attempt <= MAX_PROBE_RETRIES; attempt++) {
    try {
      const { status, bodyText } = await postAnthropicProbe(anthropicBaseURL, apiKey, model, maxTokens, fetchImpl);
      last = classifyResponse(status, bodyText);
    } catch (err) {
      last = { kind: "unknown", status: 0, snippet: `network error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const retryable = last.kind === "transient" || (last.kind === "unknown" && last.status === 0);
    if (retryable && attempt < MAX_PROBE_RETRIES) {
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
      continue;
    }
    return last;
  }
  return last;
}

/** Runs the full two-stage probe for one candidate id. */
async function probeModel(anthropicBaseURL: string, apiKey: string, id: string, fetchImpl: typeof fetch = fetch): Promise<ProbeOutcome> {
  const stage1 = await probeWithRetries(anthropicBaseURL, apiKey, id, STAGE1_MAX_TOKENS, fetchImpl);

  switch (stage1.kind) {
    case "not-found":
      return { id, status: "not-found" };
    case "no-permission":
      return { id, status: "no-permission" };
    case "plan-restricted":
      return { id, status: "plan-restricted" };
    case "insufficient-balance":
      return { id, status: "insufficient-balance" };
    case "transient":
      return { id, status: "transient-unresolved", detail: "still 529 [1305] after retries" };
    case "unknown":
      return { id, status: "unknown", detail: stage1.snippet };
    case "success": {
      // The cheap probe unexpectedly succeeded outright (ceiling >= 999999).
      // This already spent tokens; do not issue a second generation.
      const alias = detectAlias(id, stage1.model) ?? undefined;
      return { id, status: "available", alias, detail: "stage-1 succeeded outright; ceiling not discovered (>= 999999?)" };
    }
    case "ceiling": {
      const stage2 = await probeWithRetries(anthropicBaseURL, apiKey, id, STAGE2_MAX_TOKENS, fetchImpl);
      const maxTokens = stage1.maxTokens;
      switch (stage2.kind) {
        case "success":
          return { id, status: "available", maxTokens, alias: detectAlias(id, stage2.model) ?? undefined };
        case "not-found":
          return { id, status: "not-found", maxTokens };
        case "no-permission":
          return { id, status: "no-permission", maxTokens };
        case "plan-restricted":
          return { id, status: "plan-restricted", maxTokens };
        case "insufficient-balance":
          return { id, status: "insufficient-balance", maxTokens };
        case "transient":
          return { id, status: "transient-unresolved", maxTokens, detail: "still 529 [1305] after retries" };
        case "unknown":
          return { id, status: "unknown", maxTokens, detail: stage2.snippet };
        case "ceiling":
          // A real minimal generation (max_tokens=16) should never itself hit
          // the ceiling error; treat as unclassifiable rather than guess.
          return { id, status: "unknown", maxTokens, detail: "stage-2 unexpectedly returned a [1210] ceiling error at max_tokens=16" };
      }
    }
  }
}

function render(models: ModelDef[]): string {
  const lines = models.map((m) => {
    const fields = [
      `id: ${JSON.stringify(m.id)}`,
      `name: ${JSON.stringify(m.name)}`,
      `contextWindow: ${m.contextWindow.toLocaleString("en-US").replaceAll(",", "_")}`,
      `maxOutputTokens: ${(m.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS).toLocaleString("en-US").replaceAll(",", "_")}`,
    ];
    if (m.reasoning) fields.push(`reasoning: true`);
    return `  { ${fields.join(", ")} },`;
  });
  return `/**
 * Pinned model catalog for GLM coding plan.
 *
 * Hardcoded to the exact models available on the Z.AI / Bigmodel coding-plan
 * tier. Regenerate with \`bun run update-models\` (see scripts/update-models.ts),
 * which probes the Anthropic endpoint the proxy actually uses per model; the
 * real per-model \`max_tokens\` ceiling it discovers seeds \`maxOutputTokens\`
 * for newly added entries. Verify \`contextWindow\` / \`reasoning\` of newly
 * added entries by hand — the probe cannot discover those.
 */
import type { ModelDef } from "./types.js";

/** All models available on the GLM coding plan, pinned with verified specs. */
export const MODELS: ModelDef[] = [
${lines.join("\n")}
];
`;
}

function describeStatus(status: FinalStatus): string {
  switch (status) {
    case "available":
      return "AVAILABLE";
    case "not-found":
      return "NOT FOUND [1214]";
    case "no-permission":
      return "NO PERMISSION [1220]";
    case "plan-restricted":
      return "PLAN RESTRICTED [1311]";
    case "insufficient-balance":
      return "INSUFFICIENT BALANCE [1113]";
    case "transient-unresolved":
      return "TRANSIENT (529) — unresolved after retries";
    case "unknown":
      return "UNKNOWN — could not classify response";
  }
}

function reportOutcome(o: ProbeOutcome): void {
  const parts = [`[${describeStatus(o.status)}]`, o.id];
  if (o.maxTokens != null) parts.push(`ceiling=${o.maxTokens}`);
  if (o.alias) parts.push(`ALIAS -> ${o.alias}`);
  if (o.detail) parts.push(`(${o.detail})`);
  console.log(parts.join(" "));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = getProvider(args.provider);
  const apiKey = resolveApiKey(args);

  const pinnedIds = MODELS.map((m) => m.id);
  let discoveryIds: string[] = [];
  if (!args.pinnedOnly) {
    try {
      discoveryIds = await fetchRemoteModelIds(provider.openaiBaseURL, apiKey);
      console.log(
        `Discovery hint (GET ${provider.openaiBaseURL}/models, NON-authoritative) reports ${discoveryIds.length} ids: ` +
          `${discoveryIds.join(", ") || "(none)"}`,
      );
    } catch (err) {
      console.warn(
        `Discovery hint fetch failed (non-fatal — continuing with pinned + hardcoded ids only): ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
  }
  const hardcodedExtra = args.pinnedOnly ? [] : [...HARDCODED_EXTRA_IDS];
  const candidateOrder = dedupe([...pinnedIds, ...discoveryIds, ...hardcodedExtra]);

  console.log(
    `Candidate set: ${candidateOrder.length} ids ` +
      `(${pinnedIds.length} pinned, ${discoveryIds.length} discovery-hint, ${hardcodedExtra.length} hardcoded).`,
  );
  console.log(
    `Will issue up to ${candidateOrder.length} cheap stage-1 probes (max_tokens=999999, ~0 generated tokens) and ` +
      `up to ${candidateOrder.length} real stage-2 generations (max_tokens=16, DOES cost tokens) against ` +
      `${provider.anthropicBaseURL}/v1/messages — worst case ${candidateOrder.length * 2} requests, ` +
      `${candidateOrder.length} of which are billed.`,
  );

  if (args.dryRun) {
    console.log("--dry-run: stopping before issuing any probe requests.");
    return;
  }

  const outcomes = new Map<string, ProbeOutcome>();
  for (const id of candidateOrder) {
    const outcome = await probeModel(provider.anthropicBaseURL, apiKey, id);
    outcomes.set(id, outcome);
    reportOutcome(outcome);
    await sleep(INTER_REQUEST_DELAY_MS);
  }

  const { merged, added, removed, keptUnresolved, aliasWarnings, unknownCeilingIds } = mergeCatalog(MODELS, outcomes, candidateOrder);

  for (const id of added) {
    const flag = unknownCeilingIds.includes(id) ? " (ceiling undiscovered, defaulted maxOutputTokens)" : "";
    console.warn(`NEW model "${id}" added${flag} — verify contextWindow/reasoning by hand.`);
  }
  for (const id of removed) {
    console.error(`REMOVED model "${id}": probe returned a hard failure (does-not-exist/no-permission/plan/balance) — dropped from catalog.`);
  }
  for (const id of keptUnresolved) {
    console.warn(`Pinned model "${id}" kept — probe was inconclusive (transient/unknown); verify manually, not auto-removed.`);
  }
  for (const a of aliasWarnings) {
    console.warn(`ALIAS: "${a.id}" resolves server-side to "${a.resolvedModel}" — review whether to keep, repoint, or drop "${a.id}".`);
  }

  const changed =
    added.length > 0 ||
    removed.length > 0 ||
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

// Only run when this file is the process entry point (`bun run scripts/update-models.ts`
// / `bun run update-models`) — NOT when it is imported, e.g. by
// scripts/update-models.test.ts for its pure-function unit tests. Without this
// guard, importing this module for testing would fire real network probes
// (including billed stage-2 generations) against the live API.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
