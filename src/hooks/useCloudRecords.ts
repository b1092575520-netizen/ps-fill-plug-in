import { useCallback, useEffect, useRef, useState } from "react";
import { OpenAIImageProvider } from "../backend/provider";
import { CloudTaskImageCache } from "../cloudTaskImageCache";
import {
  remoteRequestCoordinator,
  type RemoteRequestCoordinator,
} from "../remoteRequestLedger";
import type { CloudTaskRecord } from "../types";

type CloudTaskProvider = Pick<OpenAIImageProvider, "listTasks" | "batchGetTasks" | "getTask">;
type CloudTaskLedger = Pick<RemoteRequestCoordinator, "listRecords" | "reconcileProviderTask">;
type CloudIdentity = { baseUrl: string; apiKey: string };
type CloudTaskImage = { status: "loading" | "ready" | "error"; url?: string; error?: string };
const CLOUD_RECORDS_TIMEOUT_MS = 30_000;

export async function loadCloudTaskRecords(
  provider: Pick<CloudTaskProvider, "listTasks" | "batchGetTasks">,
  ledgerCoordinator: CloudTaskLedger,
  signal: AbortSignal,
) {
  const ledger = await ledgerCoordinator.listRecords();
  const unresolvedTaskIds = ledger.flatMap((record) => (
    record.providerTaskId
    && ["submitting", "running", "downloading", "uncertain"].includes(record.status)
      ? [record.providerTaskId]
      : []
  ));
  const uniqueUnresolvedTaskIds = [...new Set(unresolvedTaskIds)];
  const [historyTasks, recoveredTasks] = await Promise.all([
    provider.listTasks(signal),
    uniqueUnresolvedTaskIds.length
      ? provider.batchGetTasks(uniqueUnresolvedTaskIds, signal)
      : Promise.resolve([]),
  ]);
  if (signal.aborted) return [];
  const statusRank = (status: string) => {
    const normalized = status.toLowerCase();
    if (["succeeded", "completed", "failed", "cancelled", "canceled"].includes(normalized)) return 3;
    if (["running", "downloading", "processing"].includes(normalized)) return 2;
    if (["accepted", "pending", "queued", "submitting", "uncertain"].includes(normalized)) return 1;
    return 0;
  };
  const mergedById = new Map<string, CloudTaskRecord>();
  [...historyTasks, ...recoveredTasks].forEach((task) => {
    const existing = mergedById.get(task.taskId);
    if (!existing) {
      mergedById.set(task.taskId, task);
      return;
    }
    const current = statusRank(task.status) >= statusRank(existing.status) ? task : existing;
    mergedById.set(task.taskId, {
      ...existing,
      ...current,
      model: current.model === "未知模型" ? existing.model : current.model,
      createdAt: existing.createdAt ?? task.createdAt,
      completedAt: task.completedAt ?? existing.completedAt,
      thumbnailUrl: task.thumbnailUrl ?? existing.thumbnailUrl,
    });
  });
  const tasks = [...mergedById.values()];
  await Promise.all(tasks.map((task) => ledgerCoordinator.reconcileProviderTask(task.taskId, task.status)));
  const pluginTaskIds = new Set(ledger.flatMap((record) => record.providerTaskId ? [record.providerTaskId] : []));
  return tasks.map((task) => ({
    ...task,
    origin: pluginTaskIds.has(task.taskId) ? "plugin" as const : "external-or-unknown" as const,
  }));
}

interface CloudRecordsDependencies {
  settings: CloudIdentity;
  loadRecords?: (identity: CloudIdentity, signal: AbortSignal) => Promise<CloudTaskRecord[]>;
  providerFactory?: (identity: CloudIdentity) => CloudTaskProvider;
  imageCache?: Pick<CloudTaskImageCache, "load" | "releaseAll">;
  ledger?: CloudTaskLedger;
}

export interface CloudRecordsController {
  open: boolean;
  records: CloudTaskRecord[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  images: Record<string, CloudTaskImage>;
  setOpen: (open: boolean) => void;
  refresh: () => void;
  loadTaskImage: (task: CloudTaskRecord) => void;
  clearImages: () => void;
}

export function useCloudRecords({
  settings,
  loadRecords,
  providerFactory,
  imageCache,
  ledger = remoteRequestCoordinator,
}: CloudRecordsDependencies): CloudRecordsController {
  const [open, setOpenState] = useState(false);
  const [records, setRecords] = useState<CloudTaskRecord[]>([]);
  const [status, setStatus] = useState<CloudRecordsController["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<Record<string, CloudTaskImage>>({});
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const openRef = useRef(open);
  openRef.current = open;
  const recordsAbortRef = useRef<AbortController | null>(null);
  const recordsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageAbortControllersRef = useRef(new Map<string, AbortController>());
  const imageQueueRef = useRef<CloudTaskRecord[]>([]);
  const queuedTaskIdsRef = useRef(new Set<string>());
  const pumpImageQueueRef = useRef<() => void>(() => undefined);
  const imageEpochRef = useRef(0);
  const requestRevisionRef = useRef(0);
  const cacheRef = useRef<Pick<CloudTaskImageCache, "load" | "releaseAll"> | null>(null);
  if (!cacheRef.current) cacheRef.current = imageCache ?? new CloudTaskImageCache();

  const createProvider = useCallback((identity: CloudIdentity) => (
    providerFactory?.(identity) ?? new OpenAIImageProvider({
      baseUrl: identity.baseUrl,
      apiKey: identity.apiKey.trim(),
      model: "auto",
    })
  ), [providerFactory]);

  const releaseImages = useCallback(() => {
    imageAbortControllersRef.current.forEach((controller) => controller.abort());
    imageAbortControllersRef.current.clear();
    imageQueueRef.current = [];
    queuedTaskIdsRef.current.clear();
    imageEpochRef.current += 1;
    cacheRef.current?.releaseAll();
    imagesRef.current = {};
    setImages({});
  }, []);

  const refresh = useCallback(() => {
    const identity = settingsRef.current;
    const apiKey = identity.apiKey.trim();
    if (!apiKey) {
      recordsAbortRef.current?.abort();
      setRecords([]);
      setStatus("error");
      setError("请先在设置中保存 API Key");
      return;
    }
    recordsAbortRef.current?.abort();
    if (recordsTimeoutRef.current) {
      clearTimeout(recordsTimeoutRef.current);
      recordsTimeoutRef.current = null;
    }
    const controller = new AbortController();
    const revision = ++requestRevisionRef.current;
    recordsAbortRef.current = controller;
    setStatus("loading");
    setError(null);
    let timedOut = false;
    recordsTimeoutRef.current = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (revision === requestRevisionRef.current) {
        setStatus("error");
        setError("云端记录请求超时，请检查网络后重试");
      }
    }, CLOUD_RECORDS_TIMEOUT_MS);
    // Start in a microtask so provider construction errors follow the same
    // visible error path as rejected network requests.
    const request = Promise.resolve().then(() => loadRecords
      ? loadRecords({ ...identity, apiKey }, controller.signal)
      : loadCloudTaskRecords(createProvider({ ...identity, apiKey }), ledger, controller.signal));
    void request.then((tasks) => {
      if (controller.signal.aborted || revision !== requestRevisionRef.current) return;
      setRecords(tasks);
      setStatus("ready");
    }).catch((requestError) => {
      if (revision !== requestRevisionRef.current) return;
      if ((requestError as Error).name === "AbortError" && !timedOut) return;
      setStatus("error");
      setError(timedOut ? "云端记录请求超时，请检查网络后重试" : requestError instanceof Error ? requestError.message : "云端记录读取失败");
    }).finally(() => {
      if (recordsAbortRef.current === controller) recordsAbortRef.current = null;
      if (revision === requestRevisionRef.current && recordsTimeoutRef.current) {
        clearTimeout(recordsTimeoutRef.current);
        recordsTimeoutRef.current = null;
      }
    });
  }, [createProvider, ledger, loadRecords]);

  const close = useCallback(() => {
    requestRevisionRef.current += 1;
    recordsAbortRef.current?.abort();
    recordsAbortRef.current = null;
    if (recordsTimeoutRef.current) {
      clearTimeout(recordsTimeoutRef.current);
      recordsTimeoutRef.current = null;
    }
    releaseImages();
    setRecords([]);
    setStatus("idle");
    setError(null);
  }, [releaseImages]);

  const setOpen = useCallback((nextOpen: boolean) => {
    openRef.current = nextOpen;
    setOpenState(nextOpen);
    if (nextOpen) refresh();
    else close();
  }, [close, refresh]);

  const runTaskImage = useCallback((task: CloudTaskRecord) => {
    const controller = new AbortController();
    const loadEpoch = imageEpochRef.current;
    imageAbortControllersRef.current.set(task.taskId, controller);
    const identity = settingsRef.current;
    const detailedTask = task.thumbnailUrl
      ? Promise.resolve(task)
      : createProvider({ ...identity, apiKey: identity.apiKey.trim() }).getTask(task.taskId, controller.signal)
        .then((detail) => ({ ...detail, origin: task.origin }));
    return detailedTask
      .then((detail) => {
        if (controller.signal.aborted || loadEpoch !== imageEpochRef.current) {
          throw new DOMException("云端记录页已关闭", "AbortError");
        }
        if (!detail.thumbnailUrl) throw new Error("该任务没有可用缩略图");
        setRecords((current) => current.map((record) => record.taskId === detail.taskId ? detail : record));
        return cacheRef.current!.load(detail, controller.signal);
      })
      .then((url) => {
        if (loadEpoch !== imageEpochRef.current) return;
        setImages((current) => ({ ...current, [task.taskId]: { status: "ready", url } }));
      })
      .catch((loadError) => {
        if ((loadError as Error).name === "AbortError" || loadEpoch !== imageEpochRef.current) return;
        setImages((current) => ({
          ...current,
          [task.taskId]: {
            status: "error",
            error: loadError instanceof Error ? loadError.message : "缩略图加载失败",
          },
        }));
      })
      .finally(() => {
        if (imageAbortControllersRef.current.get(task.taskId) === controller) {
          imageAbortControllersRef.current.delete(task.taskId);
        }
        pumpImageQueueRef.current();
      });
  }, [createProvider]);

  const pumpImageQueue = useCallback(() => {
    while (imageAbortControllersRef.current.size < 3 && imageQueueRef.current.length > 0) {
      const task = imageQueueRef.current.shift();
      if (!task) break;
      queuedTaskIdsRef.current.delete(task.taskId);
      if (imagesRef.current[task.taskId]?.status === "ready") continue;
      void runTaskImage(task);
    }
  }, [runTaskImage]);
  pumpImageQueueRef.current = pumpImageQueue;

  const loadTaskImage = useCallback((task: CloudTaskRecord) => {
    if (!["succeeded", "completed", "success"].includes(task.status.toLowerCase())) return;
    if (imageAbortControllersRef.current.has(task.taskId) || queuedTaskIdsRef.current.has(task.taskId)) return;
    const currentImage = imagesRef.current[task.taskId];
    if (currentImage?.status === "ready" || currentImage?.status === "loading") return;
    const loading = { status: "loading" as const };
    imagesRef.current = { ...imagesRef.current, [task.taskId]: loading };
    setImages((current) => ({ ...current, [task.taskId]: loading }));
    queuedTaskIdsRef.current.add(task.taskId);
    imageQueueRef.current.push(task);
    pumpImageQueueRef.current();
  }, []);

  useEffect(() => {
    if (!open || status !== "ready") return;
    records.slice(0, 12).forEach(loadTaskImage);
  }, [open, status, loadTaskImage]);

  useEffect(() => {
    requestRevisionRef.current += 1;
    recordsAbortRef.current?.abort();
    releaseImages();
    setRecords([]);
    setError(null);
    if (openRef.current) refresh();
    else setStatus("idle");
  }, [settings.apiKey, settings.baseUrl, refresh, releaseImages]);

  useEffect(() => () => {
    requestRevisionRef.current += 1;
    recordsAbortRef.current?.abort();
    if (recordsTimeoutRef.current) clearTimeout(recordsTimeoutRef.current);
    imageAbortControllersRef.current.forEach((controller) => controller.abort());
    imageAbortControllersRef.current.clear();
    imageQueueRef.current = [];
    queuedTaskIdsRef.current.clear();
    imageEpochRef.current += 1;
    cacheRef.current?.releaseAll();
  }, []);

  return { open, records, status, error, images, setOpen, refresh, loadTaskImage, clearImages: releaseImages };
}
