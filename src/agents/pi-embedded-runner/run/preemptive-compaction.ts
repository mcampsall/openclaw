import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { SAFETY_MARGIN, estimateMessagesTokens } from "../../compaction.js";
import {
  MIN_PROMPT_BUDGET_RATIO,
  MIN_PROMPT_BUDGET_TOKENS,
} from "../../pi-compaction-constants.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;
const TRUNCATION_ROUTE_BUFFER_CHARS = 16_384;

export type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export function estimatePrePromptTokens(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  const { messages, systemPrompt, prompt } = params;
  const syntheticMessages: AgentMessage[] = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
    syntheticMessages.push({
      role: "system",
      content: systemPrompt,
      timestamp: 0,
    } as unknown as AgentMessage);
  }
  syntheticMessages.push({ role: "user", content: prompt, timestamp: 0 } as AgentMessage);

  const estimated =
    estimateMessagesTokens(messages) +
    syntheticMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
  return Math.max(0, Math.ceil(estimated * SAFETY_MARGIN));
}

function estimateContentChars(content: unknown): number {
  if (typeof content === "string") {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, item) => sum + estimateContentChars(item), 0);
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    let total = 0;
    for (const value of Object.values(record)) {
      total += estimateContentChars(value);
    }
    return total;
  }
  return 0;
}

export function estimatePrePromptChars(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  const historyChars = params.messages.reduce(
    (sum, message) => sum + estimateContentChars((message as { content?: unknown }).content),
    0,
  );
  return historyChars + (params.systemPrompt?.length ?? 0) + params.prompt.length;
}

export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  unwindowedMessages?: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
  maxPromptChars?: number;
}): {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  estimatedPromptChars: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  overflowChars: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
} {
  let messagesForPressure = params.messages;
  let estimatedPromptTokens = estimatePrePromptTokens({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
  });
  if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
    const unwindowedEstimatedPromptTokens = estimatePrePromptTokens({
      messages: params.unwindowedMessages,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
    });
    if (unwindowedEstimatedPromptTokens > estimatedPromptTokens) {
      estimatedPromptTokens = unwindowedEstimatedPromptTokens;
      messagesForPressure = params.unwindowedMessages;
    }
  }
  let estimatedPromptChars = estimatePrePromptChars({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    prompt: params.prompt,
  });
  if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
    const unwindowedEstimatedPromptChars = estimatePrePromptChars({
      messages: params.unwindowedMessages,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
    });
    estimatedPromptChars = Math.max(estimatedPromptChars, unwindowedEstimatedPromptChars);
  }
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const requestedReserveTokens = Math.max(0, Math.floor(params.reserveTokens));
  const minPromptBudget = Math.min(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)),
  );
  const effectiveReserveTokens = Math.min(
    requestedReserveTokens,
    Math.max(0, contextTokenBudget - minPromptBudget),
  );
  const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const maxPromptChars =
    typeof params.maxPromptChars === "number" && Number.isFinite(params.maxPromptChars)
      ? Math.max(1, Math.floor(params.maxPromptChars))
      : undefined;
  const promptOverflowChars =
    typeof maxPromptChars === "number" ? Math.max(0, estimatedPromptChars - maxPromptChars) : 0;
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: messagesForPressure,
    contextWindowTokens: params.contextTokenBudget,
    maxCharsOverride: params.toolResultMaxChars,
  });
  const overflowChars = Math.max(overflowTokens * ESTIMATED_CHARS_PER_TOKEN, promptOverflowChars);
  const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN;
  const truncateOnlyThresholdChars = Math.max(
    overflowChars +
      truncationBufferChars +
      (promptOverflowChars > 0 ? TRUNCATION_ROUTE_BUFFER_CHARS : 0),
    Math.ceil(overflowChars * 1.5),
  );
  const toolResultReducibleChars = toolResultPotential.maxReducibleChars;

  let route: PreemptiveCompactionRoute = "fits";
  if (overflowTokens > 0 || promptOverflowChars > 0) {
    if (toolResultReducibleChars <= 0) {
      route = "compact_only";
    } else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
      route = "truncate_tool_results_only";
    } else {
      route = "compact_then_truncate";
    }
  }
  return {
    route,
    shouldCompact: route === "compact_only" || route === "compact_then_truncate",
    estimatedPromptTokens,
    estimatedPromptChars,
    promptBudgetBeforeReserve,
    overflowTokens,
    overflowChars,
    toolResultReducibleChars,
    effectiveReserveTokens,
  };
}
