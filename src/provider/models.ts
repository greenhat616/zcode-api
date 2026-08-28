/**
 * Pinned model catalog for GLM coding plan.
 *
 * Hardcoded to the exact models available on the Z.AI / Bigmodel coding-plan
 * tier, verified against two sources: the ZCode desktop client's bundled
 * catalog (contextWindow/maxOutputTokens) and live probes against the real
 * upstream (which models actually generate, gateway max_tokens ceilings, and
 * server-side aliasing). `bun run update-models` (see scripts/update-models.ts)
 * queries a DIFFERENT gateway's `/models` endpoint that is NOT exhaustive — it
 * omits models (e.g. glm-4.6v, glm-4.7-flash) that demonstrably work here, so
 * do not blindly regenerate this file from its output; verify specs by hand.
 */
import type { ModelDef } from "./types.js";

/** All models available on the GLM coding plan, pinned with verified specs. */
export const MODELS: ModelDef[] = [
  { id: "glm-4.5", name: "GLM 4.5", contextWindow: 131_072, maxOutputTokens: 98_304, reasoning: true },
  // Server-side alias: requests for glm-4.5-air are answered as glm-4.7 (2/2 live
  // probes, response `model` field). Specs are pinned from ZCode's catalog for
  // glm-4.5-air itself — do not "fix" them to match glm-4.7 independently.
  { id: "glm-4.5-air", name: "GLM 4.5 Air", contextWindow: 131_072, maxOutputTokens: 98_304, reasoning: true },
  { id: "glm-4.6", name: "GLM 4.6", contextWindow: 200_000, maxOutputTokens: 131_072, reasoning: true },
  { id: "glm-4.7", name: "GLM 4.7", contextWindow: 200_000, maxOutputTokens: 131_072, reasoning: true },
  { id: "glm-4.7-flash", name: "GLM 4.7 Flash", contextWindow: 200_000, maxOutputTokens: 131_072, reasoning: true },
  // Server-side alias: requests for glm-5, glm-5.1, glm-5.2 are all answered as
  // glm-5.3 (2/2 live probes each, response `model` field). Specs below are
  // pinned per-id from ZCode's catalog (glm-5, glm-5.1) or carried forward
  // (glm-5.2, absent from that catalog) — do not derive them from glm-5.3's
  // specs even though the backend is shared.
  { id: "glm-5", name: "GLM 5", contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true },
  { id: "glm-5-turbo", name: "GLM 5 Turbo", contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true },
  { id: "glm-5.1", name: "GLM 5.1", contextWindow: 200_000, maxOutputTokens: 64_000, reasoning: true },
  { id: "glm-5.2", name: "GLM 5.2", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  { id: "glm-5.3", name: "GLM 5.3", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  // Absent from ZCode's bundled v1 catalog snapshot, which predates it, so
  // these specs come from Z.AI's model page instead:
  // https://docs.z.ai/guides/vlm/glm-5.3-flash — "Context Length: 1M",
  // "Maximum Output Tokens: 128K", and "text parameters are consistent with
  // GLM-5.3, with support for a 1M-token context window". Observed gateway
  // max_tokens ceiling is 131_072, above the 128_000 pinned here.
  //
  // Natively multimodal (video / image / text / file input), unlike glm-5.3
  // which is text-only — hence its docs live under /guides/vlm/. Reasoning is
  // always on: the docs state thinking.type accepts only "enabled". Measured
  // 183 chars of thinking by default, and 0 under effort:"low" — note that
  // sending thinking:{type:"disabled"} also measured 0 rather than erroring,
  // which the docs say is unsupported; do not rely on it.
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: true },
  // Gateway hard-rejects max_tokens above 32_768 for this model:
  // `400 [1210] 限制数值范围[1,32768]`, where every sibling allows 131_072. The
  // previous 128_000 here was never sent upstream (nothing consumed this field
  // yet), but it is advertised to clients, so a client that trusted it would
  // have had its request rejected. Do not raise it without re-probing.
  { id: "glm-4.6v", name: "GLM 4.6V", contextWindow: 131_072, maxOutputTokens: 32_768 },
  // Reachable on the coding-plan credential (confirmed by live probe, HTTP 200)
  // but not offered in the ZCode client's coding-plan model picker.
  { id: "glm-4.1v-thinking-flash", name: "GLM 4.1V Thinking Flash", contextWindow: 65_536, maxOutputTokens: 32_768 },
  // Reachable on the coding-plan credential but not offered in the ZCode
  // client's coding-plan model picker.
  { id: "glm-4-flash-250414", name: "GLM 4 Flash", contextWindow: 131_072, maxOutputTokens: 16_384 },
  // Reachable on the coding-plan credential but not offered in the ZCode
  // client's coding-plan model picker. Gateway max_tokens ceiling is 1_024.
  { id: "glm-4v-flash", name: "GLM 4V Flash", contextWindow: 16_384, maxOutputTokens: 1_024 },
];
