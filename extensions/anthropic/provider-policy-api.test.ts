import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import {
  applyConfigDefaults,
  normalizeConfig,
  resolveThinkingProfile,
} from "./provider-policy-api.js";

function createModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function collectLegacyExtendedLevelIds(levels: readonly { id: string }[] | undefined): string[] {
  const ids: string[] = [];
  for (const level of levels ?? []) {
    if (level.id === "xhigh" || level.id === "max") {
      ids.push(level.id);
    }
  }
  return ids;
}

function levelIds(levels: readonly { id: string }[] | undefined): string[] {
  return (levels ?? []).map((level) => level.id);
}

describe("anthropic provider policy public artifact", () => {
  it("normalizes Anthropic provider config", () => {
    const normalized = normalizeConfig({
      provider: "anthropic",
      providerConfig: {
        baseUrl: "https://api.anthropic.com",
        models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
      },
    });
    expect(normalized.api).toBe("anthropic-messages");
    expect(normalized.baseUrl).toBe("https://api.anthropic.com");
  });

  it("normalizes Claude CLI provider config", () => {
    const normalized = normalizeConfig({
      provider: "claude-cli",
      providerConfig: {
        baseUrl: "https://api.anthropic.com",
        models: [createModel("claude-sonnet-4-6", "Claude Sonnet 4.6")],
      },
    });
    expect(normalized.api).toBe("anthropic-messages");
  });

  it("does not normalize non-Anthropic provider config", () => {
    const providerConfig = {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      models: [createModel("gpt-5.4", "GPT-5.4")],
    };

    expect(
      normalizeConfig({
        provider: "openai-codex",
        providerConfig,
      }),
    ).toBe(providerConfig);
  });

  it("applies Anthropic API-key defaults without loading the full provider plugin", () => {
    const nextConfig = applyConfigDefaults({
      config: {
        auth: {
          profiles: {
            "anthropic:default": {
              provider: "anthropic",
              mode: "api_key",
            },
          },
          order: { anthropic: ["anthropic:default"] },
        },
        agents: {
          defaults: {},
        },
      },
      env: {},
    });

    expect(nextConfig.agents?.defaults?.contextPruning?.mode).toBe("cache-ttl");
    expect(nextConfig.agents?.defaults?.contextPruning?.ttl).toBe("1h");
  });

  it("keeps Claude CLI defaults when an ambient Anthropic API key exists", () => {
    const nextConfig = applyConfigDefaults({
      config: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-8",
            },
            models: {
              "anthropic/claude-opus-4-8": {
                agentRuntime: {
                  id: "claude-cli",
                },
              },
            },
          },
        },
      },
      env: {
        ANTHROPIC_API_KEY: "sk-ant-host",
      },
    });

    const opus = nextConfig.agents?.defaults?.models?.["anthropic/claude-opus-4-8"];
    const haiku = nextConfig.agents?.defaults?.models?.["anthropic/claude-haiku-4-5"];
    expect(nextConfig.agents?.defaults?.heartbeat?.every).toBe("1h");
    expect(opus?.agentRuntime?.id).toBe("claude-cli");
    expect(opus?.params?.cacheRetention).toBeUndefined();
    expect(haiku?.agentRuntime?.id).toBe("claude-cli");
    expect(haiku?.params?.cacheRetention).toBeUndefined();
  });

  it("exposes Claude Opus 4.7 thinking levels without loading the full provider plugin", () => {
    const profile = resolveThinkingProfile({
      provider: "anthropic",
      modelId: "claude-opus-4-7",
    });
    const ids = levelIds(profile?.levels);
    expect(ids).toContain("xhigh");
    expect(ids).toContain("adaptive");
    expect(ids).toContain("max");
    expect(profile?.defaultLevel).toBe("off");
  });

  it("keeps adaptive-only Claude profiles aligned with the runtime provider", () => {
    const profile = resolveThinkingProfile({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });

    if (!profile) {
      throw new Error("Expected Anthropic policy profile");
    }
    expect(levelIds(profile.levels)).toContain("adaptive");
    expect(profile.defaultLevel).toBe("adaptive");
    expect(collectLegacyExtendedLevelIds(profile.levels)).toStrictEqual([]);
  });

  it("does not expose Anthropic thinking profiles for unrelated providers", () => {
    expect(
      resolveThinkingProfile({
        provider: "openai",
        modelId: "claude-opus-4-7",
      }),
    ).toBeNull();
  });
});
