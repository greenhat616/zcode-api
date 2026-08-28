/**
 * Tests for the Anthropic → OpenAI request translator's `output_config`
 * handling (start-plan direction: Anthropic client → OpenAI upstream).
 * @see src/translator/anthropic-to-openai.ts
 */
import { describe, it, expect } from "bun:test";
import { translateRequestAnthropicToOpenAI } from "./anthropic-to-openai.js";
import type { AnthropicMessagesRequest } from "./types.js";

describe("translateRequestAnthropicToOpenAI: output_config.effort", () => {
  it("carries output_config.effort into reasoning_effort on the OpenAI-format upstream body", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      output_config: { effort: "high" },
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort when output_config is absent", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.reasoning_effort).toBeUndefined();
  });

  it("omits reasoning_effort when output_config is present but effort is not set", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      output_config: {},
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.reasoning_effort).toBeUndefined();
  });
});


// This translator feeds the OpenAI-protocol upstream on start-plan — the exact
// path where Z.AI says a disabled GLM-5.3 request "will fail".
describe("translateRequestAnthropicToOpenAI — GLM-5.3 disabled thinking", () => {
  it("rewrites disabled to enabled + reasoning_effort low", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      thinking: { type: "disabled" },
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result.reasoning_effort).toBe("low");
  });

  it("lets an explicit output_config.effort win over the substitute", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-5.3",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      thinking: { type: "disabled" },
      output_config: { effort: "high" },
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result.reasoning_effort).toBe("high");
  });

  it("leaves glm-4.7 disabled thinking untouched", () => {
    const req: AnthropicMessagesRequest = {
      model: "glm-4.7",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 100,
      thinking: { type: "disabled" },
    };

    const result = translateRequestAnthropicToOpenAI(req);

    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result.reasoning_effort).toBeUndefined();
  });
});
