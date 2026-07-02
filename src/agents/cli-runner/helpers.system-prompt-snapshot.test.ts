import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliBackendConfig } from "../../config/types.js";
import {
  buildCliArgs,
  resolveCliSystemPromptSnapshotFile,
  resolveSystemPromptUsage,
} from "./helpers.js";

const SESSION_BACKEND: CliBackendConfig = {
  command: "claude",
  systemPromptFileArg: "--append-system-prompt-file",
  systemPromptMode: "append",
  systemPromptWhen: "session",
};

describe("resolveSystemPromptUsage (session mode)", () => {
  it("returns the system prompt for fresh AND resumed runs", () => {
    for (const isNewSession of [true, false]) {
      expect(
        resolveSystemPromptUsage({
          backend: SESSION_BACKEND,
          isNewSession,
          systemPrompt: "prompt-bytes",
        }),
      ).toBe("prompt-bytes");
    }
  });

  it('keeps "first" semantics unchanged', () => {
    const backend = { ...SESSION_BACKEND, systemPromptWhen: "first" as const };
    expect(resolveSystemPromptUsage({ backend, isNewSession: true, systemPrompt: "p" })).toBe("p");
    expect(
      resolveSystemPromptUsage({ backend, isNewSession: false, systemPrompt: "p" }),
    ).toBeNull();
  });
});

describe("resolveCliSystemPromptSnapshotFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-sysprompt-snap-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fresh run persists the snapshot and returns its path", async () => {
    const result = await resolveCliSystemPromptSnapshotFile({
      snapshotDir: dir,
      cliSessionId: "11111111-2222-3333-4444-555555555555",
      useResume: false,
      systemPrompt: "first-turn bytes",
    });
    expect(result.filePath).toBeDefined();
    expect(await fs.readFile(result.filePath ?? "", "utf8")).toBe("first-turn bytes");
  });

  it("resumed run re-uses the persisted first-turn bytes untouched", async () => {
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const fresh = await resolveCliSystemPromptSnapshotFile({
      snapshotDir: dir,
      cliSessionId: sessionId,
      useResume: false,
      systemPrompt: "first-turn bytes",
    });
    const resumed = await resolveCliSystemPromptSnapshotFile({
      snapshotDir: dir,
      cliSessionId: sessionId,
      useResume: true,
      systemPrompt: "CHANGED bytes that must not be re-sent",
    });
    expect(resumed.filePath).toBe(fresh.filePath);
    expect(await fs.readFile(resumed.filePath ?? "", "utf8")).toBe("first-turn bytes");
  });

  it("resumed run with a missing snapshot adopts the current build (fallback)", async () => {
    const result = await resolveCliSystemPromptSnapshotFile({
      snapshotDir: dir,
      cliSessionId: "orphan-session-id",
      useResume: true,
      systemPrompt: "rebuilt bytes",
    });
    expect(result.filePath).toBeDefined();
    expect(await fs.readFile(result.filePath ?? "", "utf8")).toBe("rebuilt bytes");
  });

  it("returns nothing without a snapshot dir or session id", async () => {
    expect(
      await resolveCliSystemPromptSnapshotFile({
        cliSessionId: "x",
        useResume: false,
        systemPrompt: "p",
      }),
    ).toEqual({});
    expect(
      await resolveCliSystemPromptSnapshotFile({
        snapshotDir: dir,
        useResume: false,
        systemPrompt: "p",
      }),
    ).toEqual({});
  });
});

describe("buildCliArgs system prompt on resume", () => {
  const baseParams = {
    backend: SESSION_BACKEND,
    baseArgs: ["-p"],
    modelId: "opus",
    systemPrompt: "prompt-bytes",
    systemPromptFilePath: "/snap/abc.md",
  };

  it("omits the system prompt on resume by default (first/always semantics preserved)", () => {
    const args = buildCliArgs({ ...baseParams, useResume: true });
    expect(args).not.toContain("--append-system-prompt-file");
  });

  it("re-sends the snapshot on resume when sendSystemPromptOnResume is set", () => {
    const args = buildCliArgs({
      ...baseParams,
      useResume: true,
      sendSystemPromptOnResume: true,
    });
    const flagIndex = args.indexOf("--append-system-prompt-file");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("/snap/abc.md");
  });

  it("still sends the system prompt on fresh runs", () => {
    const args = buildCliArgs({ ...baseParams, useResume: false });
    const flagIndex = args.indexOf("--append-system-prompt-file");
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe("/snap/abc.md");
  });
});
