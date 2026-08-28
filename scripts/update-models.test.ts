/**
 * Unit tests for the pure functions in scripts/update-models.ts (response
 * classification, ceiling parsing, alias detection, merge policy). All
 * inputs are synthetic — no network I/O.
 */
import { describe, it, expect } from "bun:test";
import {
  classifyResponse,
  detectAlias,
  displayName,
  dedupe,
  extractErrorCode,
  parseCeiling,
  mergeCatalog,
  type ProbeOutcome,
} from "./update-models.js";
import type { ModelDef } from "../src/provider/types.js";

// ---------------------------------------------------------------------------
// extractErrorCode / parseCeiling
// ---------------------------------------------------------------------------

describe("extractErrorCode", () => {
  it("extracts the leading [NNNN] code from a plain-text message", () => {
    expect(extractErrorCode("[1210] The max_tokens parameter is illegal.：限制数值范围[1,32768]")).toBe(1210);
    expect(extractErrorCode("[1214] modelCode: does not exist")).toBe(1214);
    expect(extractErrorCode("[1220] You do not have permission")).toBe(1220);
    expect(extractErrorCode("[1311] Your subscription plan does not yet include this model")).toBe(1311);
    expect(extractErrorCode("[1113] Insufficient balance")).toBe(1113);
    expect(extractErrorCode("[1305] service may be temporarily overloaded")).toBe(1305);
  });

  it("extracts the code out of a JSON-enveloped body", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "[1210] The max_tokens parameter is illegal.：限制数值范围[1,131072]" },
    });
    expect(extractErrorCode(body)).toBe(1210);
  });

  it("does not confuse the [1,N] range fragment for the error code", () => {
    // The range fragment "[1,999]" alone (no preceding [NNNN]) must not match.
    expect(extractErrorCode("...限制数值范围[1,999]")).toBeNull();
  });

  it("returns null when there is no bracketed code at all", () => {
    expect(extractErrorCode("plain text with no brackets")).toBeNull();
  });
});

describe("parseCeiling", () => {
  it("parses N out of a [1,N] range fragment", () => {
    expect(parseCeiling("[1210] The max_tokens parameter is illegal.：限制数值范围[1,32768]")).toBe(32768);
    expect(parseCeiling("...[1,999999]")).toBe(999999);
  });

  it("returns null when there is no range fragment", () => {
    expect(parseCeiling("[1214] modelCode: does not exist")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyResponse
// ---------------------------------------------------------------------------

describe("classifyResponse", () => {
  it("classifies a 400 [1210] ceiling error and parses N", () => {
    const v = classifyResponse(400, "[1210] The max_tokens parameter is illegal.：限制数值范围[1,131072]");
    expect(v).toEqual({ kind: "ceiling", maxTokens: 131072 });
  });

  it("classifies a 400 [1210] with an unparsable range as unknown, not a silent 0", () => {
    const v = classifyResponse(400, "[1210] The max_tokens parameter is illegal.：(range omitted)");
    expect(v.kind).toBe("unknown");
  });

  it("classifies a 400 [1214] as not-found", () => {
    expect(classifyResponse(400, "[1214] modelCode: does not exist")).toEqual({ kind: "not-found" });
  });

  it("classifies a 403 [1220] as no-permission", () => {
    expect(classifyResponse(403, "[1220] You do not have permission")).toEqual({ kind: "no-permission" });
  });

  it("classifies a 429 [1311] as plan-restricted", () => {
    expect(classifyResponse(429, "[1311] Your subscription plan does not yet include this model")).toEqual({
      kind: "plan-restricted",
    });
  });

  it("classifies a 429 [1113] as insufficient-balance", () => {
    expect(classifyResponse(429, "[1113] Insufficient balance")).toEqual({ kind: "insufficient-balance" });
  });

  it("classifies a 529 [1305] as transient", () => {
    expect(classifyResponse(529, "[1305] service may be temporarily overloaded")).toEqual({ kind: "transient" });
  });

  it("classifies an unrecognized error code as unknown, carrying status and a snippet", () => {
    const v = classifyResponse(500, "[9999] some new error nobody has seen yet");
    expect(v.kind).toBe("unknown");
    if (v.kind === "unknown") {
      expect(v.status).toBe(500);
      expect(v.snippet).toContain("9999");
    }
  });

  it("classifies a body with no bracketed code at all as unknown", () => {
    const v = classifyResponse(502, "<html>bad gateway</html>");
    expect(v.kind).toBe("unknown");
  });

  it("classifies a 200 with a JSON body as success and extracts the model field", () => {
    const body = JSON.stringify({ id: "msg_1", model: "glm-5.3", content: [] });
    expect(classifyResponse(200, body)).toEqual({ kind: "success", model: "glm-5.3" });
  });

  it("classifies a 200 with a non-JSON body as success with no model", () => {
    expect(classifyResponse(200, "not json")).toEqual({ kind: "success" });
  });

  it("classifies a 200 JSON body without a model field as success with undefined model", () => {
    expect(classifyResponse(200, JSON.stringify({ id: "msg_1" }))).toEqual({ kind: "success", model: undefined });
  });
});

// ---------------------------------------------------------------------------
// detectAlias
// ---------------------------------------------------------------------------

describe("detectAlias", () => {
  it("returns the resolved id when it differs from the requested id (the glm-5.2 -> glm-5.3 case)", () => {
    expect(detectAlias("glm-5.2", "glm-5.3")).toBe("glm-5.3");
  });

  it("returns null when the resolved id matches the requested id", () => {
    expect(detectAlias("glm-4.6", "glm-4.6")).toBeNull();
  });

  it("returns null when there is no resolved model (e.g. non-JSON success body)", () => {
    expect(detectAlias("glm-4.6", undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// displayName / dedupe
// ---------------------------------------------------------------------------

describe("displayName", () => {
  it("formats glm-* ids into a readable display name", () => {
    expect(displayName("glm-4.5")).toBe("GLM 4.5");
    expect(displayName("glm-5.3-flash")).toBe("GLM 5.3 Flash");
    expect(displayName("glm-4.1v-thinking-flash")).toBe("GLM 4.1v Thinking Flash");
  });
});

describe("dedupe", () => {
  it("removes duplicates while preserving first-occurrence order", () => {
    expect(dedupe(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array unchanged", () => {
    expect(dedupe([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeCatalog
// ---------------------------------------------------------------------------

function model(id: string, overrides: Partial<ModelDef> = {}): ModelDef {
  return { id, name: displayName(id), contextWindow: 200_000, maxOutputTokens: 64_000, ...overrides };
}

function outcome(id: string, overrides: Partial<ProbeOutcome> = {}): [string, ProbeOutcome] {
  return [id, { id, status: "available", ...overrides }];
}

describe("mergeCatalog", () => {
  it("keeps a pinned id's hand-verified specs untouched when the probe confirms it available", () => {
    const pinned = [model("glm-4.6", { contextWindow: 200_000, maxOutputTokens: 131_072, reasoning: true })];
    const outcomes = new Map([outcome("glm-4.6", { maxTokens: 999_999 })]); // probed ceiling must NOT override pinned specs
    const r = mergeCatalog(pinned, outcomes, ["glm-4.6"]);
    expect(r.merged).toEqual(pinned);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it("removes a pinned id whose probe hard-fails as not-found, and reports it loudly", () => {
    const pinned = [model("glm-4.5"), model("glm-retired")];
    const outcomes = new Map([outcome("glm-4.5"), outcome("glm-retired", { status: "not-found" })]);
    const r = mergeCatalog(pinned, outcomes, ["glm-4.5", "glm-retired"]);
    expect(r.merged.map((m) => m.id)).toEqual(["glm-4.5"]);
    expect(r.removed).toEqual(["glm-retired"]);
  });

  it("removes a pinned id on no-permission, plan-restricted, and insufficient-balance alike", () => {
    const pinned = [model("a"), model("b"), model("c")];
    const outcomes = new Map([
      outcome("a", { status: "no-permission" }),
      outcome("b", { status: "plan-restricted" }),
      outcome("c", { status: "insufficient-balance" }),
    ]);
    const r = mergeCatalog(pinned, outcomes, ["a", "b", "c"]);
    expect(r.merged).toEqual([]);
    expect(r.removed).toEqual(["a", "b", "c"]);
  });

  it("keeps (not removes) a pinned id whose probe is inconclusive, and reports it as unresolved", () => {
    const pinned = [model("glm-flaky")];
    const outcomes = new Map([
      outcome("glm-flaky", { status: "transient-unresolved", detail: "still 529 after retries" }),
    ]);
    const r = mergeCatalog(pinned, outcomes, ["glm-flaky"]);
    expect(r.merged).toEqual(pinned);
    expect(r.removed).toEqual([]);
    expect(r.keptUnresolved).toEqual(["glm-flaky"]);
  });

  it("keeps a pinned id with no probe result at all (defensive) and reports it unresolved", () => {
    const pinned = [model("glm-never-probed")];
    const r = mergeCatalog(pinned, new Map(), []);
    expect(r.merged).toEqual(pinned);
    expect(r.keptUnresolved).toEqual(["glm-never-probed"]);
  });

  it("adds a new available id using the probed ceiling as maxOutputTokens, defaulting contextWindow", () => {
    const outcomes = new Map([outcome("glm-4.6v", { maxTokens: 32_768 })]);
    const r = mergeCatalog([], outcomes, ["glm-4.6v"]);
    expect(r.added).toEqual(["glm-4.6v"]);
    expect(r.merged).toEqual([{ id: "glm-4.6v", name: "GLM 4.6v", contextWindow: 200_000, maxOutputTokens: 32_768 }]);
    expect(r.unknownCeilingIds).toEqual([]);
  });

  it("falls back to the default maxOutputTokens and flags it when a new id's ceiling was never discovered", () => {
    // e.g. stage-1 succeeded outright at max_tokens=999999, so no [1210] ceiling was ever seen.
    const outcomes = new Map([outcome("glm-huge-cap", { maxTokens: undefined })]);
    const r = mergeCatalog([], outcomes, ["glm-huge-cap"]);
    expect(r.added).toEqual(["glm-huge-cap"]);
    expect(r.merged[0]?.maxOutputTokens).toBe(128_000);
    expect(r.unknownCeilingIds).toEqual(["glm-huge-cap"]);
  });

  it("does not add a new id that hard-fails or is inconclusive", () => {
    const outcomes = new Map([
      outcome("glm-nope", { status: "not-found" }),
      outcome("glm-maybe", { status: "unknown", detail: "weird body" }),
    ]);
    const r = mergeCatalog([], outcomes, ["glm-nope", "glm-maybe"]);
    expect(r.added).toEqual([]);
    expect(r.merged).toEqual([]);
  });

  it("reports the glm-5.1-highspeed trap: a pinned id whose real generation reveals no-permission despite a clean ceiling", () => {
    // The two-stage probe already folds this into a single final ProbeOutcome
    // by the time it reaches mergeCatalog: the false-positive ceiling never
    // survives to become "available" (see probeModel's stage-2 override).
    const pinned = [model("glm-5.1-highspeed")];
    const outcomes = new Map([
      outcome("glm-5.1-highspeed", { status: "no-permission", maxTokens: 131_072 }),
    ]);
    const r = mergeCatalog(pinned, outcomes, ["glm-5.1-highspeed"]);
    expect(r.removed).toEqual(["glm-5.1-highspeed"]);
    expect(r.merged).toEqual([]);
  });

  it("reports an alias mismatch for a pinned id without dropping or renaming it (glm-5.2 -> glm-5.3)", () => {
    const pinned = [model("glm-5.2", { contextWindow: 1_000_000 })];
    const outcomes = new Map([outcome("glm-5.2", { alias: "glm-5.3" })]);
    const r = mergeCatalog(pinned, outcomes, ["glm-5.2"]);
    expect(r.merged).toEqual(pinned);
    expect(r.aliasWarnings).toEqual([{ id: "glm-5.2", resolvedModel: "glm-5.3" }]);
  });

  it("reports an alias mismatch for a newly-added id too", () => {
    const outcomes = new Map([outcome("glm-5", { maxTokens: 64_000, alias: "glm-5.3" })]);
    const r = mergeCatalog([], outcomes, ["glm-5"]);
    expect(r.added).toEqual(["glm-5"]);
    expect(r.aliasWarnings).toEqual([{ id: "glm-5", resolvedModel: "glm-5.3" }]);
  });

  it("preserves pinned ordering and appends new ids in candidate order", () => {
    const pinned = [model("glm-a"), model("glm-b")];
    const outcomes = new Map([outcome("glm-a"), outcome("glm-b"), outcome("glm-c"), outcome("glm-d")]);
    const r = mergeCatalog(pinned, outcomes, ["glm-a", "glm-b", "glm-c", "glm-d"]);
    expect(r.merged.map((m) => m.id)).toEqual(["glm-a", "glm-b", "glm-c", "glm-d"]);
  });
});
