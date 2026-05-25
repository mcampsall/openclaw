import { describe, expect, it } from "vitest";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
  isGenericExternalRunFailureText,
  isThinkingOnlyNoTextFailureMessage,
  replaceGenericExternalRunFailureText,
  THINKING_ONLY_NO_TEXT_FAILURE_TEXT,
} from "./agent-runner-failure-copy.js";

describe("isGenericExternalRunFailureText", () => {
  it("matches the canonical generic failure text", () => {
    expect(isGenericExternalRunFailureText(GENERIC_EXTERNAL_RUN_FAILURE_TEXT)).toBe(true);
  });

  it("returns false for unrelated text", () => {
    expect(isGenericExternalRunFailureText("hello")).toBe(false);
    expect(isGenericExternalRunFailureText(undefined)).toBe(false);
  });
});

describe("replaceGenericExternalRunFailureText", () => {
  it("replaces an exact generic failure with the heartbeat variant", () => {
    const result = replaceGenericExternalRunFailureText(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
    expect(result).toEqual({ text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, replaced: true });
  });

  it("leaves unrelated text untouched", () => {
    const result = replaceGenericExternalRunFailureText("something else");
    expect(result).toEqual({ text: "something else", replaced: false });
  });
});

describe("isThinkingOnlyNoTextFailureMessage", () => {
  it("detects the thinking-only marker substring", () => {
    expect(
      isThinkingOnlyNoTextFailureMessage(
        "CLI backend returned thinking blocks but no visible text.",
      ),
    ).toBe(true);
  });

  it("detects the marker even with surrounding prose", () => {
    expect(
      isThinkingOnlyNoTextFailureMessage(
        "Failover summary: CLI backend returned thinking blocks but no visible text. (model: claude-opus-4-7)",
      ),
    ).toBe(true);
  });

  it("does not match the generic empty-response message", () => {
    expect(isThinkingOnlyNoTextFailureMessage("CLI backend returned an empty response.")).toBe(
      false,
    );
  });

  it("does not match unrelated text", () => {
    expect(isThinkingOnlyNoTextFailureMessage("rate limit exceeded")).toBe(false);
    expect(isThinkingOnlyNoTextFailureMessage(undefined)).toBe(false);
    expect(isThinkingOnlyNoTextFailureMessage("")).toBe(false);
  });
});

describe("THINKING_ONLY_NO_TEXT_FAILURE_TEXT", () => {
  it("is distinct from the generic failure text", () => {
    expect(THINKING_ONLY_NO_TEXT_FAILURE_TEXT).not.toBe(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
  });

  it("mentions reasoning and a recovery hint", () => {
    expect(THINKING_ONLY_NO_TEXT_FAILURE_TEXT).toMatch(/reason|reasoned/i);
    expect(THINKING_ONLY_NO_TEXT_FAILURE_TEXT).toMatch(/\/new|rephras/i);
  });
});
