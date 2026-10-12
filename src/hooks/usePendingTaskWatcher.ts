import { useCallback, useEffect, useRef } from "react";
import { OpenAIImageProvider } from "../backend/provider";
import {
  remoteRequestCoordinator,
  type RemoteRequestCoordinator,
} from "../remoteRequestLedger";

type Identity = { baseUrl: string; apiKey: string };
type PendingTaskProvider = Pick<OpenAIImageProvider, "batchGetTasks">;
type PendingTaskLedger = Pick<
  RemoteRequestCoordinator,
  "detachedPendingTaskIds" | "reconcileProviderTask" | "onDetachedPending"
>;

export interface PendingTaskOutcome {
  completed: number;
  failed: number;
  unknown: number;
  pending: number;
}

const CHECK_INTERVAL_MS = 20_000;

/**
 * Asks the provider about submitted tasks nobody is waiting for any more and
 * records their final status. Never submits anything.
 */
export async function reconcilePendingTasks(
  provider: PendingTaskProvider,
  ledger: Pick<PendingTaskLedger, "detachedPendingTaskIds" | "reconcileProviderTask">,
  signal: AbortSignal,
): Promise<PendingTaskOutcome> {
  const taskIds = await ledger.detachedPendingTaskIds();
  if (!taskIds.length) return { completed: 0, failed: 0, unknown: 0, pending: 0 };
  const tasks = await provider.batchGetTasks(taskIds, signal);
  let completed = 0;
  let failed = 0;
  let unknown = 0;
  for (const task of tasks) {
    const outcome = await ledger.reconcileProviderTask(task.taskId, task.status);
    if (outcome === "completed") completed += 1;
    else if (outcome === "failed") failed += 1;
    else if (outcome === "unknown") unknown += 1;
  }
  return { completed, failed, unknown, pending: (await ledger.detachedPendingTaskIds()).length };
}

interface PendingTaskWatcherOptions {
  settings: Identity;
  enabled: boolean;
  onResolved: (outcome: PendingTaskOutcome) => void;
  ledger?: PendingTaskLedger;
  providerFactory?: (identity: Identity) => PendingTaskProvider;
  intervalMs?: number;
}

/**
 * Follows up tasks that were cancelled, timed out or interrupted after the
 * paid request went out, so the account unlocks and the user learns when the
 * image is ready, without opening the cloud records page.
 */
export function usePendingTaskWatcher({
  settings,
  enabled,
  onResolved,
  ledger = remoteRequestCoordinator,
  providerFactory = (identity) => new OpenAIImageProvider({ ...identity, model: "" }),
  intervalMs = CHECK_INTERVAL_MS,
}: PendingTaskWatcherOptions) {
  const identityRef = useRef(settings);
  identityRef.current = settings;
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  const providerFactoryRef = useRef(providerFactory);
  providerFactoryRef.current = providerFactory;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const recheckRef = useRef(false);

  const stop = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    runningRef.current = false;
    recheckRef.current = false;
  }, []);

  const check: () => void = useCallback(() => {
    if (runningRef.current) {
      // A task may have detached after this check read the ledger.
      recheckRef.current = true;
      return;
    }
    const identity = identityRef.current;
    const apiKey = identity.apiKey.trim();
    if (!apiKey) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    void ledger.detachedPendingTaskIds()
      .then((taskIds) => (taskIds.length
        ? reconcilePendingTasks(
          providerFactoryRef.current({ baseUrl: identity.baseUrl, apiKey }),
          ledger,
          controller.signal,
        )
        : { completed: 0, failed: 0, unknown: 0, pending: 0 }))
      .then((outcome) => {
        if (controller.signal.aborted) return;
        if (outcome.completed || outcome.failed || outcome.unknown) onResolvedRef.current(outcome);
        if (outcome.pending) timerRef.current = setTimeout(check, intervalMs);
      })
      .catch(() => {
        // Network or provider trouble: try again later; stale records stop
        // being watched on their own once they exceed the lock window.
        if (!controller.signal.aborted) timerRef.current = setTimeout(check, intervalMs);
      })
      .finally(() => {
        if (abortRef.current !== controller) return;
        abortRef.current = null;
        runningRef.current = false;
        if (recheckRef.current) {
          recheckRef.current = false;
          check();
        }
      });
  }, [intervalMs, ledger]);

  useEffect(() => {
    if (!enabled || !settings.apiKey.trim()) return undefined;
    check();
    const unsubscribe = ledger.onDetachedPending(check);
    return () => {
      unsubscribe();
      stop();
    };
  }, [check, enabled, ledger, settings.apiKey, settings.baseUrl, stop]);

  return { check };
}
