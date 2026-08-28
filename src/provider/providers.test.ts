/**
 * Tests for provider definitions and model catalog.
 * @see .omo/plans/zcode-proxy.md Task 3
 */
import { describe, it, expect } from "bun:test";
import { getProvider, ZAI_PROVIDER, BIGMODEL_PROVIDER } from "./providers.js";
import { MODELS } from "./models.js";

describe("providers", () => {
  it("getProvider returns Z.AI definition", () => {
    const p = getProvider("zai");
    expect(p.id).toBe("zai");
    expect(p.anthropicBaseURL).toBe("https://api.z.ai/api/anthropic");
    expect(p.openaiBaseURL).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(p.bizHost).toBe("https://api.z.ai");
  });

  it("getProvider returns Bigmodel definition", () => {
    const p = getProvider("bigmodel");
    expect(p.id).toBe("bigmodel");
    expect(p.anthropicBaseURL).toBe("https://open.bigmodel.cn/api/anthropic");
    expect(p.openaiBaseURL).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(p.bizHost).toBe("https://open.bigmodel.cn");
  });

  it("ZAI_PROVIDER constant matches getProvider('zai')", () => {
    expect(ZAI_PROVIDER).toEqual(getProvider("zai"));
  });

  it("BIGMODEL_PROVIDER constant matches getProvider('bigmodel')", () => {
    expect(BIGMODEL_PROVIDER).toEqual(getProvider("bigmodel"));
  });

  it("getProvider throws on unknown id", () => {
    expect(() => getProvider("openai" as any)).toThrow(/Unknown provider/);
  });
});

describe("models", () => {
  it("MODELS contains the pinned coding-plan baseline", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const baseline of [
      "glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.7", "glm-4.7-flash",
      "glm-5", "glm-5-turbo", "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash",
      "glm-4.6v",
    ]) {
      expect(ids).toContain(baseline);
    }
  });

  it("all models have valid id, contextWindow, and maxOutputTokens", () => {
    for (const m of MODELS) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it("baseline 200k-context models keep 200k context", () => {
    for (const id of ["glm-4.6", "glm-4.7", "glm-4.7-flash", "glm-5", "glm-5-turbo", "glm-5.1"]) {
      const m = MODELS.find((x) => x.id === id);
      expect(m, id).toBeDefined();
      expect(m!.contextWindow, id).toBe(200_000);
    }
  });

  it("glm-5.2 and glm-5.3 have 1M context", () => {
    const glm52 = MODELS.find((m) => m.id === "glm-5.2");
    expect(glm52).toBeDefined();
    expect(glm52!.contextWindow).toBe(1_000_000);
    const glm53 = MODELS.find((m) => m.id === "glm-5.3");
    expect(glm53).toBeDefined();
    expect(glm53!.contextWindow).toBe(1_000_000);
  });

  it("includes key GLM models", () => {
    const ids = MODELS.map((m) => m.id);
    expect(ids).toContain("glm-4.6");
    expect(ids).toContain("glm-5.2");
    expect(ids).toContain("glm-5.3");
  });

  // Gateway hard-rejects max_tokens above 32_768 for glm-4.6v:
  // `400 [1210] 限制数值范围[1,32768]` on live probe. Regressing this value
  // back up (e.g. to a blanket 128_000) breaks every glm-4.6v request in
  // production with a 400 from the upstream gateway.
  it("glm-4.6v maxOutputTokens is capped at the gateway limit of 32_768", () => {
    const glm46v = MODELS.find((m) => m.id === "glm-4.6v");
    expect(glm46v).toBeDefined();
    expect(glm46v!.maxOutputTokens).toBe(32_768);
  });

  // Confirmed a reasoning model by live probe: emits thinking tokens by
  // default, and effort:"low" / thinking:{type:"disabled"} suppress it.
  it("glm-5.3-flash is flagged as a reasoning model", () => {
    const glm53flash = MODELS.find((m) => m.id === "glm-5.3-flash");
    expect(glm53flash).toBeDefined();
    expect(glm53flash!.reasoning).toBe(true);
  });

  // glm-5v-turbo returns a hard 429 [1311] "does not yet include access" on
  // 3/3 live probes — it is not available on this plan and must not be
  // re-added without re-verifying against the upstream gateway.
  it("does not list glm-5v-turbo (not available on this plan)", () => {
    const ids = MODELS.map((m) => m.id);
    expect(ids).not.toContain("glm-5v-turbo");
  });
});
