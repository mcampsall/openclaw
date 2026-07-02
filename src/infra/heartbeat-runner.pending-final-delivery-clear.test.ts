import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { resetSystemEventsForTest } from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

// Regression: with heartbeat target "none", agent-runner marks every
// substantive reply pendingFinalDelivery (durable-delivery retry) but the
// intentional delivery skip never cleared it, so the next beat replayed the
// stored text instead of running the agent — permanently, after the first
// substantive reply. Observed live 2026-07-02 on agent:main:explicit:heartbeat.
describe("heartbeat pendingFinalDelivery clear on intentional non-delivery", () => {
  const substantive =
    "Full pass complete. Triaged the 6 candidates and left one live loop for tomorrow.";

  const readEntry = async (storePath: string, sessionKey: string) => {
    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    return store[sessionKey] ?? {};
  };

  const seedPendingFinalDelivery = async (storePath: string, sessionKey: string) => {
    const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    store[sessionKey] = {
      ...store[sessionKey],
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: substantive,
      pendingFinalDeliveryCreatedAt: Date.now() - 120_000,
      // Outside the 30s pending-final defer window so the run proceeds.
      updatedAt: Date.now() - 120_000,
    };
    await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
  };

  it("clears a stale pendingFinalDelivery marker when target is none", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "none" },
          },
        },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      await seedPendingFinalDelivery(storePath, sessionKey);

      const getReplySpy = vi.fn().mockResolvedValue({ text: substantive });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: { getReplyFromConfig: getReplySpy },
      });

      expect(result.status).toBe("ran");
      expect(getReplySpy).toHaveBeenCalledTimes(1);
      const entry = await readEntry(storePath, sessionKey);
      expect(entry.pendingFinalDelivery).toBeUndefined();
      expect(entry.pendingFinalDeliveryText).toBeUndefined();
      expect(entry.pendingFinalDeliveryCreatedAt).toBeUndefined();
    });
  });

  it("keeps the marker for deliverable targets so durable retry still works", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "telegram", to: "155462274" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "155462274",
      });
      await seedPendingFinalDelivery(storePath, sessionKey);

      const getReplySpy = vi.fn().mockResolvedValue({ text: substantive });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: { getReplyFromConfig: getReplySpy, telegram: sendTelegram },
      });

      // Deliverable path: this run's marker lifecycle is owned by the
      // delivery machinery (set pre-delivery, cleared on send success by
      // dispatch), not by the heartbeat skip branches this patch touches.
      // The run must complete and attempt delivery.
      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalled();
    });
  });
});
