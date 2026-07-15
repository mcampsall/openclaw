import { getRuntimeConfig } from "../config/config.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveApprovalRequestChannelAccountId } from "./approval-request-account-binding.js";
import { resolveExecApprovalInitiatingSurfaceState } from "./exec-approval-surface.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

export function hasApprovalTurnSourceRoute(params: {
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
}): boolean {
  const channel = normalizeMessageChannel(params.turnSourceChannel);
  if (!channel) {
    return false;
  }

  // A deliverable channel name alone is not a route. If no approval client or
  // forwarder accepted the request, an external chat must include a concrete
  // destination where the user can actually receive and answer /approve.
  if (channel !== INTERNAL_MESSAGE_CHANNEL && channel !== "tui" && !params.turnSourceTo?.trim()) {
    return false;
  }

  const cfg = getRuntimeConfig();
  let accountId = params.turnSourceAccountId;
  try {
    const request: PluginApprovalRequest = {
      id: "approval-route-check",
      request: {
        title: "Approval route check",
        description: "Resolve the originating approval surface.",
        sessionKey: params.sessionKey,
        turnSourceChannel: channel,
        turnSourceTo: params.turnSourceTo,
        turnSourceAccountId: params.turnSourceAccountId,
      },
      createdAtMs: 0,
      expiresAtMs: 0,
    };
    accountId = resolveApprovalRequestChannelAccountId({ cfg, request, channel }) ?? accountId;
  } catch {
    // Preserve the explicit binding when a persisted session cannot be read.
  }
  return (
    resolveExecApprovalInitiatingSurfaceState({
      channel,
      accountId,
      cfg,
    }).kind === "enabled"
  );
}
