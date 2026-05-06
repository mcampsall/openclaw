import { createHash } from "node:crypto";
import { mkdir, readFile, appendFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve as resolvePath, join as joinPath } from "node:path";

export type ReliabilitySource = {
  channel: string;
  accountId?: string;
  chatId?: string;
  messageId?: string;
  requestId?: string;
};

export type TaskIntentKey = Record<string, unknown>;

export type TaskState =
  | "declared"
  | "claimed"
  | "started"
  | "heartbeat"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskTerminalState = Extract<TaskState, "completed" | "failed" | "cancelled">;

export type TaskEventType = TaskState;

export type TaskLedgerEvent = {
  v: 1;
  ts: string;
  taskId: string;
  eventId: string;
  type: TaskEventType;
  state: TaskState;
  source: ReliabilitySource;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
};

export type NotifyState = "queued" | "delivering" | "delivered" | "failed" | "sealed";

export type NotifyOutboxEvent = {
  v: 1;
  ts: string;
  notificationId: string;
  taskId: string;
  state: NotifyState;
  idempotencyKey: string;
  target: {
    channel: string;
    to: string;
    accountId?: string;
  };
  message: string;
};

export type ReliabilityTaskSnapshot = {
  taskId: string;
  state: TaskState;
  terminal: boolean;
  lastEvent: TaskLedgerEvent;
};

export type ReliabilitySpineStorePaths = {
  taskEventsPath: string;
  notifyOutboxPath: string;
};

export type ReliabilitySpineSnapshot = {
  taskEvents: TaskLedgerEvent[];
  notifications: NotifyOutboxEvent[];
  taskSnapshots: Map<string, ReliabilityTaskSnapshot>;
};

const TERMINAL_TASK_STATES = new Set<TaskState>(["completed", "failed", "cancelled"]);
const SAFE_SOURCE_RE = /[^a-z0-9_-]+/gi;

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortObject(item)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dateStamp(input: Date): string {
  return input.toISOString().slice(0, 10).replaceAll("-", "");
}

function normalizeSourceName(source: string): string {
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(SAFE_SOURCE_RE, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "unknown";
}

export function buildTaskId(params: {
  intentKey: TaskIntentKey;
  source: string;
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const source = normalizeSourceName(params.source);
  const hash = sha256Hex(canonicalJson(params.intentKey)).slice(0, 16);
  return `task_${dateStamp(now)}_${source}_${hash}`;
}

export function buildTaskIdempotencyKey(params: {
  source: ReliabilitySource;
  kind: string;
  goal?: string;
}): string {
  const source = params.source;
  const stableIdentity = source.messageId ?? source.requestId;
  if (!stableIdentity) {
    throw new Error("source.messageId or source.requestId is required for task idempotency");
  }
  return [
    "task",
    normalizeSourceName(source.channel),
    source.accountId ?? "default",
    source.chatId ?? "unknown-chat",
    stableIdentity,
    params.kind,
    params.goal ? sha256Hex(params.goal).slice(0, 12) : null,
  ]
    .filter(Boolean)
    .join(":");
}

export function buildTaskEvent(params: {
  taskId: string;
  type: TaskEventType;
  source: ReliabilitySource;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  ts?: string;
}): TaskLedgerEvent {
  const ts = params.ts ?? new Date().toISOString();
  return {
    v: 1,
    ts,
    taskId: params.taskId,
    eventId: `evt_${sha256Hex(`${params.taskId}:${params.type}:${params.idempotencyKey}:${ts}`).slice(0, 24)}`,
    type: params.type,
    state: params.type,
    source: params.source,
    idempotencyKey: params.idempotencyKey,
    ...(params.payload ? { payload: params.payload } : {}),
  };
}

export function reduceTaskEvents(events: TaskLedgerEvent[]): Map<string, ReliabilityTaskSnapshot> {
  const snapshots = new Map<string, ReliabilityTaskSnapshot>();
  const ordered = events.toSorted((left, right) => left.ts.localeCompare(right.ts));
  for (const event of ordered) {
    const existing = snapshots.get(event.taskId);
    if (existing?.terminal) {
      continue;
    }
    snapshots.set(event.taskId, {
      taskId: event.taskId,
      state: event.state,
      terminal: TERMINAL_TASK_STATES.has(event.state),
      lastEvent: event,
    });
  }
  return snapshots;
}

export function buildTerminalNotification(params: {
  taskEvent: TaskLedgerEvent;
  target: NotifyOutboxEvent["target"];
  message: string;
  ts?: string;
}): NotifyOutboxEvent {
  if (!TERMINAL_TASK_STATES.has(params.taskEvent.state)) {
    throw new Error("terminal task event is required to enqueue a terminal notification");
  }
  const ts = params.ts ?? new Date().toISOString();
  const notificationId = `ntf_${sha256Hex(
    canonicalJson({
      taskId: params.taskEvent.taskId,
      target: params.target,
      state: params.taskEvent.state,
    }),
  ).slice(0, 24)}`;
  return {
    v: 1,
    ts,
    notificationId,
    taskId: params.taskEvent.taskId,
    state: "queued",
    idempotencyKey: `notify:${params.taskEvent.taskId}:${params.taskEvent.state}:${notificationId}`,
    target: params.target,
    message: params.message,
  };
}

function sameNotifyTarget(
  left: NotifyOutboxEvent["target"],
  right: NotifyOutboxEvent["target"],
): boolean {
  return (
    left.channel === right.channel &&
    left.to === right.to &&
    (left.accountId ?? null) === (right.accountId ?? null)
  );
}

export function notificationsMissingForTerminalTasks(params: {
  taskEvents: TaskLedgerEvent[];
  notifications: NotifyOutboxEvent[];
  target: NotifyOutboxEvent["target"];
  formatMessage: (event: TaskLedgerEvent) => string;
}): NotifyOutboxEvent[] {
  const existingTaskIds = new Set(
    params.notifications
      .filter((notification) => sameNotifyTarget(notification.target, params.target))
      .map((notification) => notification.taskId),
  );
  return Array.from(reduceTaskEvents(params.taskEvents).values())
    .filter((snapshot) => snapshot.terminal && !existingTaskIds.has(snapshot.taskId))
    .map((snapshot) =>
      buildTerminalNotification({
        taskEvent: snapshot.lastEvent,
        target: params.target,
        message: params.formatMessage(snapshot.lastEvent),
      }),
    );
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: T[] = [];
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      records.push(JSON.parse(line) as T);
    } catch (error) {
      console.warn(
        `[reliability-spine] skipping invalid JSONL record in ${filePath}:${index + 1}: ${(error as Error).message}`,
      );
    }
  }
  return records;
}

async function appendJsonlRecord(filePath: string, record: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

const fileLocks = new Map<string, Promise<void>>();

async function resolveFileLockKey(filePath: string): Promise<string> {
  const resolvedPath = resolvePath(filePath);
  const parentDir = dirname(resolvedPath);
  await mkdir(parentDir, { recursive: true });
  try {
    return joinPath(await realpath(parentDir), basename(resolvedPath));
  } catch {
    return resolvedPath;
  }
}

export async function withSpineFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const lockKey = await resolveFileLockKey(filePath);
  const previous = fileLocks.get(lockKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((release) => {
    releaseCurrent = release;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  fileLocks.set(lockKey, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    releaseCurrent();
    if (fileLocks.get(lockKey) === tail) {
      fileLocks.delete(lockKey);
    }
  }
}

export async function readTaskLedgerEvents(filePath: string): Promise<TaskLedgerEvent[]> {
  return readJsonlFile<TaskLedgerEvent>(filePath);
}

export async function readNotifyOutboxEvents(filePath: string): Promise<NotifyOutboxEvent[]> {
  return readJsonlFile<NotifyOutboxEvent>(filePath);
}

export function appendTaskLedgerEvent(
  filePath: string,
  event: TaskLedgerEvent,
): Promise<{ appended: boolean; event: TaskLedgerEvent }> {
  return withSpineFileLock(filePath, async () => {
    const existing = await readTaskLedgerEvents(filePath);
    const alreadyPersisted = existing.some(
      (candidate) =>
        candidate.taskId === event.taskId &&
        candidate.type === event.type &&
        candidate.idempotencyKey === event.idempotencyKey,
    );
    if (alreadyPersisted) {
      return { appended: false, event };
    }

    await appendJsonlRecord(filePath, event);
    return { appended: true, event };
  });
}

export function appendNotifyOutboxEvent(
  filePath: string,
  notification: NotifyOutboxEvent,
): Promise<{ appended: boolean; notification: NotifyOutboxEvent }> {
  return withSpineFileLock(filePath, async () => {
    const existing = await readNotifyOutboxEvents(filePath);
    const alreadyPersisted = existing.some(
      (candidate) =>
        candidate.notificationId === notification.notificationId ||
        candidate.idempotencyKey === notification.idempotencyKey,
    );
    if (alreadyPersisted) {
      return { appended: false, notification };
    }

    await appendJsonlRecord(filePath, notification);
    return { appended: true, notification };
  });
}

export async function loadReliabilitySpineSnapshot(
  paths: ReliabilitySpineStorePaths,
): Promise<ReliabilitySpineSnapshot> {
  const [taskEvents, notifications] = await Promise.all([
    readTaskLedgerEvents(paths.taskEventsPath),
    readNotifyOutboxEvents(paths.notifyOutboxPath),
  ]);
  return {
    taskEvents,
    notifications,
    taskSnapshots: reduceTaskEvents(taskEvents),
  };
}
