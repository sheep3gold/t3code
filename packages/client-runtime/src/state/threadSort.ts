import type { OrchestrationThreadShell, ProjectId } from "@t3tools/contracts";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";

export interface ThreadSortInput {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt?: string | null;
  readonly messages?: ReadonlyArray<{
    readonly createdAt: string;
    readonly role: string;
  }>;
}

export function toSortableTimestamp(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export type SettledThreadTimestampInput = Pick<
  OrchestrationThreadShell,
  "settledAt" | "latestUserMessageAt" | "latestTurn" | "updatedAt"
>;

/** The timestamp a settled row sorts and labels by on every client: settledAt
    when stamped, otherwise the latest message or turn stamp, then updatedAt. */
export function resolveSettledThreadTimestamp(thread: SettledThreadTimestampInput): string | null {
  if (thread.settledAt != null && toSortableTimestamp(thread.settledAt) !== null) {
    return thread.settledAt;
  }

  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]) {
    const parsed = toSortableTimestamp(candidate ?? undefined);
    if (candidate != null && parsed !== null && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  if (latest !== null) return latest;
  return toSortableTimestamp(thread.updatedAt) === null ? null : thread.updatedAt;
}

function getFirstSortableTimestamp(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    const timestamp = toSortableTimestamp(value ?? undefined);
    if (timestamp !== null) {
      return timestamp;
    }
  }

  return null;
}

function getLatestUserMessageTimestamp(thread: ThreadSortInput): number {
  if (thread.latestUserMessageAt) {
    const latestUserMessageTimestamp = toSortableTimestamp(thread.latestUserMessageAt);
    if (latestUserMessageTimestamp !== null) {
      return latestUserMessageTimestamp;
    }
  }

  let latestUserMessageTimestamp: number | null = null;

  for (const message of thread.messages ?? []) {
    if (message.role !== "user") continue;
    const messageTimestamp = toSortableTimestamp(message.createdAt);
    if (messageTimestamp === null) continue;
    latestUserMessageTimestamp =
      latestUserMessageTimestamp === null
        ? messageTimestamp
        : Math.max(latestUserMessageTimestamp, messageTimestamp);
  }

  if (latestUserMessageTimestamp !== null) {
    return latestUserMessageTimestamp;
  }

  return getFirstSortableTimestamp(thread.updatedAt, thread.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function getThreadSortTimestamp(
  thread: ThreadSortInput,
  sortOrder: SidebarThreadSortOrder | Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (sortOrder === "created_at") {
    return (
      getFirstSortableTimestamp(thread.createdAt, thread.updatedAt) ?? Number.NEGATIVE_INFINITY
    );
  }
  return getLatestUserMessageTimestamp(thread);
}

/**
 * Sort anchor for the active thread list: creation time, re-anchored to
 * unsettledAt when the thread last re-entered the active list (an explicit
 * un-settle, or a settled thread waking on activity). The list stays static
 * between lifecycle transitions, but an un-settled thread surfaces at the
 * top instead of sinking back to its creation-order slot. Shared by web and
 * mobile so both render the same order. Malformed timestamps sink to 0.
 */
function activeThreadAnchorTimestampMs(thread: {
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
}): number {
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
  );
}

export function sortThreads<T extends { readonly id: string } & ThreadSortInput>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  if (threads.length < 2) return [...threads];
  return threads
    .map((thread) => ({ thread, timestamp: getThreadSortTimestamp(thread, sortOrder) }))
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        (left.thread.id < right.thread.id ? 1 : left.thread.id > right.thread.id ? -1 : 0),
    )
    .map(({ thread }) => thread);
}

export function getLatestThreadForProject<
  T extends {
    readonly id: string;
    readonly projectId: ProjectId;
    readonly archivedAt: string | null;
  } & ThreadSortInput,
>(threads: readonly T[], projectId: ProjectId, sortOrder: SidebarThreadSortOrder): T | null {
  let latest: T | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const thread of threads) {
    if (thread.projectId !== projectId || thread.archivedAt !== null) continue;
    const timestamp = getThreadSortTimestamp(thread, sortOrder);
    if (
      latest === null ||
      timestamp > latestTimestamp ||
      (timestamp === latestTimestamp && thread.id > latest.id)
    ) {
      latest = thread;
      latestTimestamp = timestamp;
    }
  }
  return latest;
}

// ── Pinned reorder: fractional index keys ──────────────────────────────
// Pinned threads carry an optional pinOrderKey (a base-26 string). The
// pinned block sorts keyed threads by plain string comparison, so a drag
// (web) or Move up/down (mobile) writes ONE key to ONE thread on that
// thread's own server — neighbors, possibly living on other servers, are
// never touched, and every client connected to the same servers converges
// on the same order.
const PIN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function isValidPinOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!PIN_ORDER_DIGITS.includes(char)) return false;
  }
  // A trailing minimum digit would leave no room to sort a key immediately
  // before this one; generators never produce it, so treat it as corrupt.
  return key.at(-1) !== PIN_ORDER_DIGITS[0];
}

/** Midpoint of two digit strings interpreted as fractions in (0, 1).
    "" stands for the open bound on either side. Requires a < b. */
function pinOrderMidpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("pinOrderMidpoint: bounds out of order");
  if (b !== "") {
    // Recurse past the longest common prefix ("a" pads the shorter side).
    let n = 0;
    while ((a.charAt(n) || PIN_ORDER_DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + pinOrderMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : PIN_ORDER_DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? PIN_ORDER_DIGITS.length : PIN_ORDER_DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return PIN_ORDER_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  // Consecutive leading digits: either b has spare digits to shorten into,
  // or we extend a (never producing a trailing minimum digit — the base
  // case midpoint("", "") is the middle of the alphabet).
  if (b.length > 1) return b.charAt(0);
  return PIN_ORDER_DIGITS.charAt(digitA) + pinOrderMidpoint(a.slice(1), "");
}

/** Key that sorts strictly between two neighbors; null bounds mean "top of
    the pinned block" / "bottom of the keyed run". Returns null instead of
    throwing when existing keys are corrupt or out of order — callers fall
    back to rewriting the section. */
export function pinOrderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidPinOrderKey(a)) return null;
  if (b !== "" && !isValidPinOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return pinOrderMidpoint(a, b);
}

/** Evenly spaced keys for materializing an order. Wider keys keep a large
    active list from exhausting the space between two-digit keys. */
export function generateSpreadPinOrderKeys(count: number): string[] {
  let width = 2;
  let space = PIN_ORDER_DIGITS.length ** width;
  while (space <= (count + 1) * 2) {
    width += 1;
    space *= PIN_ORDER_DIGITS.length;
  }
  const step = space / (count + 1);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = Math.round(step * (i + 1));
    // Skip values whose low digit is the minimum (a trailing "a" key).
    if (value % PIN_ORDER_DIGITS.length === 0) value += 1;
    let key = "";
    for (let digit = 0; digit < width; digit += 1) {
      key = PIN_ORDER_DIGITS.charAt(value % PIN_ORDER_DIGITS.length) + key;
      value = Math.floor(value / PIN_ORDER_DIGITS.length);
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Assignments needed to realize a new pinned order. When the moved thread
 * sits between two keyed (or absent) neighbors, this is a single write to
 * the moved thread. When a neighbor is keyless (threads pinned before
 * reordering shipped), the whole section gets fresh spread keys — a
 * one-time materialization; every move after that is single-write. Active
 * reordering uses the same planner with activeOrderKey values.
 */
export function planPinnedReorder(input: {
  /** Thread ids in the desired visual order (after the move). */
  readonly orderedIds: readonly string[];
  /** Include retained keys from hidden rows; only orderedIds receive writes. */
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const { orderedIds, keysById, movedId } = input;
  const visibleIds = new Set(orderedIds);
  const reservedKeys = new Set(
    [...keysById].flatMap(([id, key]) => (!visibleIds.has(id) && key != null ? [key] : [])),
  );
  const movedIndex = orderedIds.indexOf(movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? orderedIds[movedIndex - 1] : null;
  const afterId = movedIndex < orderedIds.length - 1 ? orderedIds[movedIndex + 1] : null;
  const beforeKey = beforeId != null ? (keysById.get(beforeId) ?? null) : null;
  const afterKey = afterId != null ? (keysById.get(afterId) ?? null) : null;
  const beforeUsable = beforeId === null || beforeKey != null;
  const afterUsable = afterId === null || afterKey != null;
  if (beforeUsable && afterUsable) {
    let key = pinOrderKeyBetween(beforeKey, afterKey);
    while (key !== null && reservedKeys.has(key)) key = pinOrderKeyBetween(key, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  // Keyless neighbor (or corrupt keys): rewrite the section in the new order.
  const keys = generateSpreadPinOrderKeys(orderedIds.length + reservedKeys.size)
    .filter((key) => !reservedKeys.has(key))
    .slice(0, orderedIds.length);
  return orderedIds.flatMap((id, index) => {
    const key = keys[index]!;
    return keysById.get(id) === key ? [] : [{ id, orderKey: key }];
  });
}

/**
 * Pinned block order: user-arranged keys first (string comparison, id
 * tiebreak), then keyless threads newest-created first — so threads on
 * servers that predate reordering keep the static creation order at the
 * bottom of the block instead of breaking the section.
 */
export function sortPinnedThreadsByOrderKey<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly pinOrderKey?: string | null | undefined;
    /** Thread ids are only unique within an environment, and the pinned
        block merges environments — the tiebreak needs both parts or two
        clients could render equal-key threads in stream-arrival order. */
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  if (threads.length < 2) return [...threads];
  const keyed: T[] = [];
  const keyless: T[] = [];
  for (const thread of threads) {
    (thread.pinOrderKey != null ? keyed : keyless).push(thread);
  }
  const identityTiebreak = (left: T, right: T) =>
    left.id.localeCompare(right.id) ||
    (left.environmentId ?? "").localeCompare(right.environmentId ?? "");
  keyed.sort((left, right) => {
    const leftKey = left.pinOrderKey!;
    const rightKey = right.pinOrderKey!;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : identityTiebreak(left, right);
  });
  const timestamps = new Map(
    keyless.map((thread) => [thread, toSortableTimestamp(thread.createdAt) ?? 0]),
  );
  keyless.sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! || identityTiebreak(left, right),
  );
  return [...keyed, ...keyless];
}

/**
 * Working tier of the active list. A thread reads as working while its
 * session is running/starting or native background work outlives the turn
 * (see backgroundLiveness). Resolved per-call because callers (the client
 * shell subscription) hand back frozen shells whose liveness changes with
 * every server push.
 */
export type ActiveThreadWorkingInput = {
  readonly session?: { readonly status: string } | null | undefined;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
};

function activeThreadWorkingPriority(thread: ActiveThreadWorkingInput): 0 | 1 {
  const status = thread.session?.status;
  if (status === "running" || status === "starting") return 1;
  return thread.backgroundLiveness === "working" ? 1 : 0;
}

/** Activity stamps for the rest of the active list. updatedAt is
    deliberately NOT one of them: the server bumps it on any metadata write
    (pin, rename, order keys), which would reorder rows for housekeeping
    work the user never sees. All optional so minimal fixtures and shells
    from older servers keep typechecking. */
export type ActiveThreadActivityInput = {
  readonly latestUserMessageAt?: string | null | undefined;
  readonly latestTurn?:
    | {
        readonly requestedAt?: string | null | undefined;
        readonly startedAt?: string | null | undefined;
        readonly completedAt?: string | null | undefined;
      }
    | null
    | undefined;
};

/** True when the latest turn completed after the user last looked at the
    thread. A missing visit counts as read — never-visited threads must not
    flood the top of the list on a fresh device — while a malformed visit
    timestamp counts as unseen so corrupt local data cannot eat the signal. */
export function hasUnseenThreadCompletion(
  latestTurn: { readonly completedAt?: string | null | undefined } | null | undefined,
  lastVisitedAt: string | null | undefined,
): boolean {
  const completedAt = latestTurn?.completedAt;
  if (!completedAt) return false;
  const completedMs = toSortableTimestamp(completedAt);
  if (completedMs === null) return false;
  if (!lastVisitedAt) return false;
  const visitedMs = toSortableTimestamp(lastVisitedAt);
  if (visitedMs === null) return true;
  return completedMs > visitedMs;
}

/** Read stamp the unseen-completion signal compares against. A server that
    stores read state is authoritative, so a read — or an explicit Mark
    unread — on any device applies to every device. Threads the server has
    no stamp for (null), and shells from servers that predate shared read
    state (field absent), fall back to this device's local visit stamp. */
export function resolveThreadLastReadAt(
  thread: { readonly lastReadAt?: string | null | undefined },
  localLastVisitedAt: string | null | undefined,
): string | null {
  return thread.lastReadAt ?? localLastVisitedAt ?? null;
}

/** True when the server should be told about a visit: it stores read state
    and does not already have this completion (or a later one) as seen. Keeps
    every open/re-render from dispatching a command. */
export function shouldSyncThreadRead(
  thread: { readonly lastReadAt?: string | null | undefined },
  readAt: string,
): boolean {
  if (thread.lastReadAt === undefined) return false;
  const readAtMs = toSortableTimestamp(readAt);
  if (readAtMs === null) return false;
  const currentMs = toSortableTimestamp(thread.lastReadAt ?? undefined);
  return currentMs === null || currentMs < readAtMs;
}

/** The timestamp "rest" rows sort by inside the active block: the newest of
    the thread's activity stamps (latest user message, latest turn) and its
    creation/re-entry anchor, so recently handled threads lead while
    reopened threads still surface. Malformed stamps sink to the epoch. */
function activeThreadActivityMs(
  thread: {
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
  } & ActiveThreadActivityInput,
): number {
  return toSortableTimestamp(resolveActiveThreadActivityTimestamp(thread) ?? undefined) ?? 0;
}

/** The stamp behind activeThreadActivityMs, for rows that label their time:
    showing the same stamp the list sorts by keeps the labels in order. */
export function resolveActiveThreadActivityTimestamp(
  thread: {
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
  } & ActiveThreadActivityInput,
): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.latestUserMessageAt,
    thread.latestTurn?.completedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.requestedAt,
    thread.unsettledAt,
    thread.createdAt,
  ]) {
    const parsed = toSortableTimestamp(candidate ?? undefined);
    if (candidate != null && parsed !== null && parsed > latestMs) {
      latest = candidate;
      latestMs = parsed;
    }
  }
  return latest;
}

/**
 * Attention tiers of the active list, one sort shared by web and mobile:
 * completions the user has not opened yet lead, then running work. Both
 * tiers keep the base order (creation/re-entry anchor, saved arrangement)
 * so rows do not shuffle while the user watches. Everything else follows
 * last activity, newest first, and manually arranged keys keep their run
 * at the bottom of the block. Callers pass an `isUnreadCompleted` predicate
 * (server read state via resolveThreadLastReadAt, falling back to the
 * device's local stamp); without it nothing is unread.
 */
export function sortActiveThreadsByOrderKey<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
    readonly environmentId?: string | undefined;
  } & ActiveThreadWorkingInput &
    ActiveThreadActivityInput,
>(threads: readonly T[], options?: { readonly isUnreadCompleted?: (thread: T) => boolean }): T[] {
  if (threads.length < 2) return [...threads];
  const timestamps = new Map<T, number>();
  for (const thread of threads) {
    if (thread.activeOrderKey == null) {
      timestamps.set(thread, activeThreadAnchorTimestampMs(thread));
    }
  }
  const identityTiebreak = (left: T, right: T) =>
    left.id.localeCompare(right.id) ||
    (left.environmentId ?? "").localeCompare(right.environmentId ?? "");
  // Base order: keyless threads by creation/re-entry anchor, arranged keys below.
  const base = [...threads].sort((left, right) => {
    const leftKey = left.activeOrderKey;
    const rightKey = right.activeOrderKey;
    if (leftKey == null && rightKey != null) return -1;
    if (leftKey != null && rightKey == null) return 1;
    let order = 0;
    if (leftKey != null && rightKey != null) {
      order = leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    } else {
      order = timestamps.get(right)! - timestamps.get(left)!;
    }
    return order || identityTiebreak(left, right);
  });
  // Stable partition by attention tier: running work outranks an older
  // unseen completion on the same thread (the newer result supersedes it).
  const unreadCompleted: T[] = [];
  const working: T[] = [];
  const rest: T[] = [];
  for (const thread of base) {
    if (activeThreadWorkingPriority(thread) === 1) {
      working.push(thread);
    } else if (options?.isUnreadCompleted?.(thread) === true) {
      unreadCompleted.push(thread);
    } else {
      rest.push(thread);
    }
  }
  const restUnkeyed = rest
    .filter((thread) => thread.activeOrderKey == null)
    .sort(
      (left, right) =>
        activeThreadActivityMs(right) - activeThreadActivityMs(left) ||
        identityTiebreak(left, right),
    );
  const restKeyed = rest.filter((thread) => thread.activeOrderKey != null);
  return [...unreadCompleted, ...working, ...restUnkeyed, ...restKeyed];
}

/**
 * planPinnedReorder specialized for mobile's Move up / Move down menu
 * actions: swap the moved thread with its displayed neighbor. Null when the
 * move falls off either end of the list. Same single-write-per-move
 * semantics as a web drag.
 */
export function planPinnedMove(input: {
  /** Reorder-capable pinned thread ids in displayed order. */
  readonly orderedIds: readonly string[];
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
  readonly direction: "up" | "down";
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> | null {
  const { orderedIds, keysById, movedId, direction } = input;
  const from = orderedIds.indexOf(movedId);
  if (from === -1) return null;
  const to = direction === "up" ? from - 1 : from + 1;
  if (to < 0 || to >= orderedIds.length) return null;
  const newOrder = [...orderedIds];
  newOrder.splice(from, 1);
  newOrder.splice(to, 0, movedId);
  return planPinnedReorder({ orderedIds: newOrder, keysById, movedId });
}
