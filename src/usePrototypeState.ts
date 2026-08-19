import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OpenAIImageProvider } from "./backend/provider";
import { createCredentialStore, createPhotoshopGateway, isUxpRuntime, pickUxpReferenceFiles } from "./backend/runtime";
import { LitterboxReferenceUploader } from "./backend/referenceUploader";
import type { GeneratedImageAsset } from "./backend/contracts";
import {
  GenerationService,
  generateFromDraft,
  generationModel,
  realGenerationBlocker,
} from "./backend/generationService";
import { AssetLifecycleManager, measureImageBytes, type AssetOwner } from "./assetLifecycleManager";
import { DocumentSessionCoordinator, type DocumentTaskToken } from "./documentSessionCoordinator";
import { PreviewCoordinator } from "./previewCoordinator";
import { hashPrompt, remoteRequestCoordinator } from "./remoteRequestLedger";
import { useCloudRecords } from "./hooks/useCloudRecords";
export { loadCloudTaskRecords } from "./hooks/useCloudRecords";
import {
  applyRememberedSettings,
  DEFAULT_GENERATION_SETTINGS_MEMORY,
  loadGenerationSettingsMemory,
  saveGenerationSettingsMemory,
  settingsFromDraft,
  type GenerationSettingsMemory,
} from "./generationSettingsStorage";
import { fileFromCapturedReference, planReferenceFiles, removeReferenceById } from "./backend/referenceSelection";
import {
  loadPromptNotes,
  normalizePromptNotes,
  savePromptNotes,
} from "./promptNotebookStorage";
import {
  loadPromptHistory,
  recordPromptHistory,
  savePromptHistory,
} from "./promptHistoryStorage";
import {
  capabilityForModel,
  createXinbaoSnapshot,
  snapshotModelOptions,
} from "./backend/providerCapabilities";
import { createCandidates } from "./mockArtwork";
import {
  completeDocumentSession,
  cancelDocumentJob,
  commitPreviewSession,
  canStagePreview,
  createDocumentSession,
  updateDocumentSession,
  removeDocumentSession,
  type DocumentPreviewStatus,
  type DocumentSession,
  type DocumentSessionMap,
} from "./documentSessionState";
import type {
  BalanceSnapshot,
  Candidate,
  ConnectionSettings,
  GenerationDraft,
  GenerationStage,
  GenerationJob,
  JobStatus,
  PhotoshopContext,
  PromptNote,
  PromptHistoryEntry,
  ReferenceImage,
  ToastMessage,
  ThemeKey,
} from "./types";

const INITIAL_CONTEXT: PhotoshopContext = {
  documentId: "ps-doc-01",
  documentName: "DSC_2841.psd",
  width: 6000,
  height: 4000,
  colorMode: "RGB / 16 位",
  selection: { x: 1840, y: 1120, width: 1200, height: 800 },
};

const INITIAL_DRAFT: GenerationDraft = {
  mode: "text",
  prompt: "",
  model: "auto",
  resolution: "2K",
  quality: "high",
  count: 4,
  aspectRatio: "auto",
  customWidth: 1,
  customHeight: 1,
  outputTarget: "current-document",
  references: [],
};

const INITIAL_PROVIDER_SNAPSHOT = createXinbaoSnapshot(false);

const INITIAL_SETTINGS: ConnectionSettings = {
  baseUrl: "https://async.xinbao-ai.com",
  apiKey: "",
  modelOptions: snapshotModelOptions(INITIAL_PROVIDER_SNAPSHOT),
  connectionStatus: "idle",
  providerSnapshot: INITIAL_PROVIDER_SNAPSHOT,
};

const EMPTY_BALANCE: BalanceSnapshot = { status: "idle", unit: "积分" };

export function resetProviderConnection(
  current: ConnectionSettings,
  next: ConnectionSettings,
) {
  const changed = next.apiKey !== current.apiKey || next.baseUrl !== current.baseUrl;
  return changed
    ? {
        ...next,
        connectionStatus: "idle" as const,
        modelOptions: [],
        providerSnapshot: null,
      }
    : next;
}

export function providerConnectionStatus(
  snapshot: NonNullable<ConnectionSettings["providerSnapshot"]>,
  balance: BalanceSnapshot,
) {
  return snapshot.credentialVerified || balance.status === "available"
    ? "connected" as const
    : "reachable" as const;
}

const credentialStore = createCredentialStore();
const referenceUploader = new LitterboxReferenceUploader();
const UXP_RUNTIME = isUxpRuntime();
let localRequestSequence = 0;
let referenceIdSequence = 0;

function readableGenerationError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = record.message ?? record.error ?? record.reason;
    if (typeof message === "string" && message.trim()) return message;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Ignore non-serializable host exceptions.
    }
  }
  return "API 请求失败";
}

function cloneDraft(draft: GenerationDraft): GenerationDraft {
  return { ...draft, references: draft.references.map((item) => ({ ...item })) };
}

function cloneContext(context: PhotoshopContext | null): PhotoshopContext | null {
  if (!context) return null;
  return { ...context, selection: context.selection ? { ...context.selection } : null };
}

function sameSelection(a: PhotoshopContext["selection"], b: PhotoshopContext["selection"]) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function samePhotoshopContext(a: PhotoshopContext | null, b: PhotoshopContext) {
  return Boolean(a)
    && a!.documentId === b.documentId
    && a!.documentName === b.documentName
    && a!.width === b.width
    && a!.height === b.height
    && a!.colorMode === b.colorMode
    && sameSelection(a!.selection, b.selection);
}

function ratioFromDocument(context: PhotoshopContext | null) {
  if (!context) return "—";
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const width = Math.max(1, Math.round(context.width));
  const height = Math.max(1, Math.round(context.height));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function assetPreviewUrl(asset: GeneratedImageAsset) {
  const bytes = asset.bytes.buffer.slice(
    asset.bytes.byteOffset,
    asset.bytes.byteOffset + asset.bytes.byteLength,
  ) as ArrayBuffer;
  return URL.createObjectURL(new Blob([bytes], { type: asset.mimeType }));
}

interface DocumentRuntimeResources {
  referenceUrls: string[];
  referenceAssetIds: Map<string, string>;
  candidateUrls: string[];
  abort: AbortController | null;
  timer: number | null;
  startTimer: number | null;
  elapsedTimer: number | null;
  previewQueue: Promise<void>;
  previewStaging: boolean;
  previewCleanup: boolean;
  insertInFlight: boolean;
  previewRevision: number;
  jobId: string | null;
  candidateOwner: DocumentTaskToken | null;
  previewAssetId: string | null;
}

function createDocumentRuntimeResources(): DocumentRuntimeResources {
  return {
    referenceUrls: [],
    referenceAssetIds: new Map(),
    candidateUrls: [],
    abort: null,
    timer: null,
    startTimer: null,
    elapsedTimer: null,
    previewQueue: Promise.resolve(),
    previewStaging: false,
    previewCleanup: false,
    insertInFlight: false,
    previewRevision: 0,
    jobId: null,
    candidateOwner: null,
    previewAssetId: null,
  };
}

export function usePrototypeState() {
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(
    UXP_RUNTIME ? null : INITIAL_CONTEXT.documentId,
  );
  const [documentSessions, setDocumentSessions] = useState<DocumentSessionMap>(() => UXP_RUNTIME
    ? {}
    : { [INITIAL_CONTEXT.documentId]: createDocumentSession(INITIAL_CONTEXT.documentId, INITIAL_DRAFT, INITIAL_CONTEXT) });
  const activeDocumentIdRef = useRef(activeDocumentId);
  activeDocumentIdRef.current = activeDocumentId;
  const documentSessionsRef = useRef(documentSessions);
  documentSessionsRef.current = documentSessions;
  const activeSession = activeDocumentId ? documentSessions[activeDocumentId] ?? null : null;
  const draft = activeSession?.draft ?? INITIAL_DRAFT;
  const context = activeSession?.context ?? null;
  const status = activeSession?.status ?? "idle";
  const progress = activeSession?.progress ?? 0;
  const stage = activeSession?.stage ?? "idle";
  const elapsedSeconds = activeSession?.elapsedSeconds ?? 0;
  const candidates = activeSession?.candidates ?? [];
  const jobs = activeSession?.jobs ?? [];
  const previewCandidate = activeSession?.previewCandidate ?? null;
  const photoshopPreviewSession = activeSession?.photoshopPreviewSession ?? null;
  const activeCandidateId = activeSession?.activeCandidateId ?? null;
  const previewStatus: DocumentPreviewStatus = activeSession?.previewStatus ?? "idle";
  const workspaceView = activeSession?.workspaceView ?? "config";
  const generationResultStatus = activeSession?.generationResultStatus ?? "idle";
  const writeStatus = activeSession?.writeStatus ?? "idle";
  const writeError = activeSession?.writeError ?? null;
  const [settings, setSettingsState] = useState<ConnectionSettings>(INITIAL_SETTINGS);
  const [balance, setBalance] = useState<BalanceSnapshot>(EMPTY_BALANCE);
  const balanceRef = useRef(balance);
  balanceRef.current = balance;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [theme, setTheme] = useState<ThemeKey>("graphite");
  const [promptNotes, setPromptNotesState] = useState<PromptNote[]>([]);
  const [promptNotesReady, setPromptNotesReady] = useState(false);
  const [promptHistory, setPromptHistoryState] = useState<PromptHistoryEntry[]>([]);
  const [promptHistoryReady, setPromptHistoryReady] = useState(false);
  const [rememberLastSettings, setRememberLastSettingsState] = useState(true);
  const [generationSettingsReady, setGenerationSettingsReady] = useState(false);
  const cloudRecordsController = useCloudRecords({ settings });
  const cloudRecordsOpen = cloudRecordsController.open;
  const cloudRecords = cloudRecordsController.records;
  const cloudRecordsStatus = cloudRecordsController.status;
  const cloudRecordsError = cloudRecordsController.error;
  const cloudTaskImages = cloudRecordsController.images;
  const setCloudRecordsOpen = cloudRecordsController.setOpen;
  const refreshCloudTasks = cloudRecordsController.refresh;
  const loadCloudTaskImage = cloudRecordsController.loadTaskImage;
  const [referenceCaptureStatus, setReferenceCaptureStatus] = useState<"idle" | "capturing">("idle");
  const [credentialSaveStatus, setCredentialSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const toastTimerRef = useRef<number | null>(null);
  const documentResourcesRef = useRef<Map<string, DocumentRuntimeResources>>(new Map());
  const assetLifecycleRef = useRef(new AssetLifecycleManager());
  const photoshopGatewayRef = useRef<ReturnType<typeof createPhotoshopGateway> | null>(null);
  if (!photoshopGatewayRef.current) {
    photoshopGatewayRef.current = createPhotoshopGateway(assetLifecycleRef.current);
  }
  const photoshopGateway = photoshopGatewayRef.current;
  const sessionCoordinatorRef = useRef(new DocumentSessionCoordinator());
  const previewCoordinatorRef = useRef<PreviewCoordinator | null>(null);
  if (!previewCoordinatorRef.current) {
    previewCoordinatorRef.current = new PreviewCoordinator({
      stage: (documentId, asset) => {
        const token = documentResourcesRef.current.get(documentId)?.candidateOwner;
        const owner = token ? { ...token, ownerPrefix: "ps-fill" } : undefined;
        return photoshopGateway.insert([asset], "current-document", documentId, owner);
      },
      discard: (session) => photoshopGateway.discardPreview(session),
      commit: (session) => photoshopGateway.discardPreview(session, session.layerIds[0]),
    });
  }
  const providerRefreshAbortRef = useRef<AbortController | null>(null);
  const balanceRefreshAbortRef = useRef<AbortController | null>(null);
  const credentialEditedRef = useRef(false);
  const promptNotesRef = useRef<PromptNote[]>([]);
  const promptHistoryRef = useRef<PromptHistoryEntry[]>([]);
  const generationSettingsMemoryRef = useRef<GenerationSettingsMemory>({
    ...DEFAULT_GENERATION_SETTINGS_MEMORY,
    byMode: {},
  });
  const referenceCaptureInFlightRef = useRef(false);
  const referenceFingerprintsRef = useRef(new WeakMap<Blob, string>());
  const referenceFingerprintSequenceRef = useRef(0);
  const refreshAllRef = useRef<() => void>(() => undefined);
  const refreshCloudTasksRef = useRef<() => void>(() => undefined);
  refreshCloudTasksRef.current = refreshCloudTasks;
  const refreshBalanceRef = useRef<(showLoading?: boolean) => void>(() => undefined);
  const resourcesFor = useCallback((documentId: string) => {
    const existing = documentResourcesRef.current.get(documentId);
    if (existing) return existing;
    const created = createDocumentRuntimeResources();
    documentResourcesRef.current.set(documentId, created);
    return created;
  }, []);

  const assetOwner = useCallback((token: DocumentTaskToken): AssetOwner => ({
    ...token,
    ownerPrefix: "ps-fill",
  }), []);

  const updateActiveSession = useCallback((update: (session: DocumentSession) => DocumentSession) => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId) return;
    setDocumentSessions((sessions) => sessions[documentId]
      ? updateDocumentSession(sessions, documentId, update, INITIAL_DRAFT)
      : sessions);
  }, []);

  const updateSession = useCallback((documentId: string, update: (session: DocumentSession) => DocumentSession) => {
    setDocumentSessions((sessions) => sessions[documentId]
      ? updateDocumentSession(sessions, documentId, update, INITIAL_DRAFT)
      : sessions);
  }, []);

  const activateDocumentContext = useCallback((next: PhotoshopContext) => {
    setActiveDocumentId(next.documentId);
    setDocumentSessions((sessions) => {
      const current = sessions[next.documentId];
      if (!current) {
        return {
          ...sessions,
          [next.documentId]: createDocumentSession(
            next.documentId,
            applyRememberedSettings(INITIAL_DRAFT, generationSettingsMemoryRef.current),
            next,
          ),
        };
      }
      if (samePhotoshopContext(current.context, next)) return sessions;
      return updateDocumentSession(sessions, next.documentId, (session) => ({
        ...session,
        context: { ...next, selection: next.selection ? { ...next.selection } : null },
      }));
    });
    resourcesFor(next.documentId);
  }, [resourcesFor]);

  const cleanupDocumentResources = useCallback((documentId: string) => {
    const resources = documentResourcesRef.current.get(documentId);
    if (!resources) return;
    resources.abort?.abort();
    if (resources.timer) window.clearInterval(resources.timer);
    if (resources.startTimer) window.clearTimeout(resources.startTimer);
    if (resources.elapsedTimer) window.clearInterval(resources.elapsedTimer);
    resources.referenceUrls.forEach((url) => URL.revokeObjectURL(url));
    resources.candidateUrls.forEach((url) => URL.revokeObjectURL(url));
    documentResourcesRef.current.delete(documentId);
    sessionCoordinatorRef.current.closeDocument(documentId);
    void previewCoordinatorRef.current?.discard(documentId);
    void assetLifecycleRef.current.cleanupDocument(documentId);
  }, []);

  const releaseDocumentResults = useCallback(async (documentId: string) => {
    const resources = resourcesFor(documentId);
    if (resources.previewAssetId) {
      await assetLifecycleRef.current.cleanupResource(documentId, "preview-layer", resources.previewAssetId);
      resources.previewAssetId = null;
    } else {
      await previewCoordinatorRef.current?.discard(documentId);
    }
    if (resources.candidateOwner) {
      const owner = resources.candidateOwner;
      await assetLifecycleRef.current.cleanupJob(documentId, owner.jobId, owner.revision);
      resources.candidateOwner = null;
    }
    resources.candidateUrls = [];
    updateSession(documentId, (session) => ({
      ...session,
      candidates: [],
      activeCandidateId: null,
      previewCandidate: null,
      photoshopPreviewSession: null,
      previewStatus: "idle",
      workspaceView: "config",
      generationResultStatus: "idle",
      writeStatus: "idle",
      writeError: null,
    }));
  }, [resourcesFor, updateSession]);

  const notify = useCallback((text: string, kind: ToastMessage["kind"] = "info") => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, kind });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const writeSingleCandidate = useCallback(async (documentId: string, candidate: Candidate) => {
    if (!candidate.asset) throw new Error("已生成图片资源缺失，已停止写入");
    const resources = resourcesFor(documentId);
    if (resources.insertInFlight) return;
    resources.insertInFlight = true;
    updateSession(documentId, (session) => ({
      ...session,
      writeStatus: "writing",
      writeError: null,
    }));
    const owner = resources.candidateOwner
      ? assetOwner(resources.candidateOwner)
      : assetOwner({ documentId, jobId: "write", revision: resources.previewRevision });
    try {
      await photoshopGateway.insert(
        [candidate.asset],
        candidate.outputTarget ?? "current-document",
        candidate.sourceDocumentId ?? documentId,
        owner,
      );
      updateSession(documentId, (session) => ({ ...session, writeStatus: "completed", writeError: null }));
      await releaseDocumentResults(documentId);
      notify(
        candidate.outputTarget === "new-document" ? "图片已生成并写入新文档" : "图片已生成并写入 Photoshop",
        "success",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Photoshop 写入失败";
      updateSession(documentId, (session) => ({
        ...session,
        generationResultStatus: "succeeded",
        writeStatus: "failed",
        writeError: message,
        workspaceView: "write-recovery",
      }));
      notify("图片已生成，重试写入", "warning");
    } finally {
      resources.insertInFlight = false;
    }
  }, [assetOwner, notify, photoshopGateway, releaseDocumentResults, resourcesFor, updateSession]);

  const retryGeneratedWrite = useCallback(() => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId) return;
    const candidate = documentSessionsRef.current[documentId]?.candidates[0];
    if (!candidate?.asset) {
      notify("已生成图片资源缺失，无法重试写入", "warning");
      return;
    }
    void writeSingleCandidate(documentId, candidate);
  }, [notify, writeSingleCandidate]);

  const discardGeneratedResult = useCallback(() => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId) return;
    void releaseDocumentResults(documentId)
      .then(() => notify("已放弃生成结果并释放临时资源"))
      .catch((error) => notify(error instanceof Error ? error.message : "释放生成结果失败", "warning"));
  }, [notify, releaseDocumentResults]);

  const commitPromptNotes = useCallback((next: PromptNote[]) => {
    const normalized = normalizePromptNotes(next);
    promptNotesRef.current = normalized;
    setPromptNotesState(normalized);
    void savePromptNotes(normalized).catch(() => notify("提示词本保存失败", "warning"));
  }, [notify]);

  const savePromptNote = useCallback((input: Omit<PromptNote, "createdAt" | "updatedAt" | "order"> & { order?: number }) => {
    const now = Date.now();
    const existing = promptNotesRef.current.find((note) => note.id === input.id);
    const nextNote: PromptNote = {
      ...input,
      order: input.order ?? existing?.order ?? promptNotesRef.current.length,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? promptNotesRef.current.map((note) => note.id === input.id ? nextNote : note)
      : [...promptNotesRef.current, nextNote];
    commitPromptNotes(next);
  }, [commitPromptNotes]);

  const deletePromptNote = useCallback((id: string) => {
    commitPromptNotes(promptNotesRef.current.filter((note) => note.id !== id));
  }, [commitPromptNotes]);

  const togglePromptNotePinned = useCallback((id: string) => {
    commitPromptNotes(promptNotesRef.current.map((note) => note.id === id
      ? { ...note, pinned: !note.pinned, updatedAt: Date.now() }
      : note));
  }, [commitPromptNotes]);

  const reorderPromptNote = useCallback((id: string, toIndex: number) => {
    const notes = [...promptNotesRef.current];
    const fromIndex = notes.findIndex((note) => note.id === id);
    if (fromIndex < 0) return;
    const [moved] = notes.splice(fromIndex, 1);
    notes.splice(Math.max(0, Math.min(toIndex, notes.length)), 0, moved);
    commitPromptNotes(notes.map((note, order) => ({ ...note, order })));
  }, [commitPromptNotes]);

  const commitPromptHistory = useCallback((next: PromptHistoryEntry[]) => {
    promptHistoryRef.current = next;
    setPromptHistoryState(next);
    void savePromptHistory(next).catch(() => notify("提示词历史保存失败", "warning"));
  }, [notify]);

  const recordSuccessfulPrompt = useCallback((prompt: string, mode: GenerationDraft["mode"]) => {
    const next = recordPromptHistory(promptHistoryRef.current, prompt, mode);
    if (next !== promptHistoryRef.current) commitPromptHistory(next);
  }, [commitPromptHistory]);

  const deletePromptHistory = useCallback((id: string) => {
    commitPromptHistory(promptHistoryRef.current.filter((entry) => entry.id !== id));
  }, [commitPromptHistory]);

  const clearPromptHistory = useCallback(() => commitPromptHistory([]), [commitPromptHistory]);

  useEffect(() => {
    let disposed = false;
    void loadPromptNotes()
      .then((notes) => {
        if (disposed) return;
        const normalized = normalizePromptNotes(notes);
        promptNotesRef.current = normalized;
        setPromptNotesState(normalized);
        setPromptNotesReady(true);
      })
      .catch(() => {
        if (!disposed) {
          promptNotesRef.current = [];
          setPromptNotesState([]);
          setPromptNotesReady(true);
          notify("提示词本读取失败，已显示空列表", "warning");
        }
      });
    return () => { disposed = true; };
  }, [notify]);

  useEffect(() => {
    let disposed = false;
    void loadPromptHistory()
      .then((entries) => {
        if (disposed) return;
        promptHistoryRef.current = entries;
        setPromptHistoryState(entries);
        setPromptHistoryReady(true);
      })
      .catch(() => {
        if (!disposed) {
          promptHistoryRef.current = [];
          setPromptHistoryState([]);
          setPromptHistoryReady(true);
          notify("提示词历史读取失败，已显示空列表", "warning");
        }
      });
    return () => { disposed = true; };
  }, [notify]);

  useEffect(() => {
    let disposed = false;
    void loadGenerationSettingsMemory()
      .then((memory) => {
        if (disposed) return;
        generationSettingsMemoryRef.current = memory;
        setRememberLastSettingsState(memory.enabled);
        if (memory.enabled) {
          setDocumentSessions((sessions) => Object.fromEntries(Object.entries(sessions).map(([documentId, session]) => [
            documentId,
            { ...session, draft: applyRememberedSettings(session.draft, memory) },
          ])));
        }
        setGenerationSettingsReady(true);
      })
      .catch(() => {
        if (!disposed) {
          setGenerationSettingsReady(true);
          notify("生成设置记忆读取失败，已使用默认值", "warning");
        }
      });
    return () => { disposed = true; };
  }, [notify]);

  const setSettings = useCallback((next: ConnectionSettings) => {
    const current = settingsRef.current;
    const identityChanged = next.apiKey !== current.apiKey || next.baseUrl !== current.baseUrl;
    if (!identityChanged) {
      settingsRef.current = next;
      setSettingsState(next);
      return;
    }
    setCredentialSaveStatus("idle");
    if (next.apiKey !== current.apiKey) credentialEditedRef.current = true;
    providerRefreshAbortRef.current?.abort();
    balanceRefreshAbortRef.current?.abort();
    setBalance(EMPTY_BALANCE);
    setDocumentSessions((sessions) => Object.fromEntries(
      Object.entries(sessions).map(([documentId, session]) => [documentId, {
        ...session,
        draft: { ...session.draft, model: "", resolution: "api-default" },
      }]),
    ));
    const reset = resetProviderConnection(current, next);
    settingsRef.current = reset;
    setSettingsState(reset);
  }, []);

  const saveApiKey = useCallback(async () => {
    setCredentialSaveStatus("saving");
    try {
      const apiKey = settingsRef.current.apiKey.trim();
      if (apiKey) await credentialStore.saveApiKey(apiKey);
      else await credentialStore.deleteApiKey();
      setCredentialSaveStatus("saved");
      notify(apiKey ? "API Key 已安全保存" : "已删除保存的 API Key", "success");
      refreshAllRef.current();
    } catch {
      setCredentialSaveStatus("error");
      notify("API Key 安全存储写入失败", "warning");
    }
  }, [notify]);

  const updateDraft = useCallback((patch: Partial<GenerationDraft>) => {
    updateActiveSession((session) => {
      const patched = { ...session.draft, ...patch };
      const next = patch.mode && patch.mode !== session.draft.mode
        ? applyRememberedSettings(patched, generationSettingsMemoryRef.current, patch.mode)
        : patched;
      if (patch.model === undefined) return { ...session, draft: next };
      const capability = capabilityForModel(settings.providerSnapshot, next.model);
      if (!capability) {
        return { ...session, draft: { ...next, resolution: "api-default" } };
      }
      const resolution = capability.resolutions.includes(next.resolution)
        ? next.resolution
        : capability.defaultResolution;
      const quality = capability.qualityOptions.length && !capability.qualityOptions.includes(next.quality)
        ? capability.qualityOptions[0]
        : next.quality;
      const aspectRatio = next.aspectRatio === "auto"
        || (next.aspectRatio !== "custom" && capability.aspectRatios.includes(next.aspectRatio))
        ? next.aspectRatio
        : "auto";
      return { ...session, draft: { ...next, resolution, quality, aspectRatio } };
    });
  }, [settings.providerSnapshot, updateActiveSession]);

  useEffect(() => {
    if (!generationSettingsReady || !rememberLastSettings || !activeDocumentId) return;
    const current = generationSettingsMemoryRef.current;
    const next: GenerationSettingsMemory = {
      version: 1,
      enabled: true,
      byMode: { ...current.byMode, [draft.mode]: settingsFromDraft(draft) },
    };
    generationSettingsMemoryRef.current = next;
    void saveGenerationSettingsMemory(next).catch(() => notify("生成设置记忆保存失败", "warning"));
  }, [
    activeDocumentId,
    draft.aspectRatio,
    draft.count,
    draft.customHeight,
    draft.customWidth,
    draft.mode,
    draft.model,
    draft.outputTarget,
    draft.quality,
    draft.resolution,
    generationSettingsReady,
    notify,
    rememberLastSettings,
  ]);

  const setRememberLastSettings = useCallback((enabled: boolean) => {
    const current = generationSettingsMemoryRef.current;
    const next: GenerationSettingsMemory = {
      version: 1,
      enabled,
      byMode: enabled ? current.byMode : {},
    };
    generationSettingsMemoryRef.current = next;
    setRememberLastSettingsState(enabled);
    void saveGenerationSettingsMemory(next).catch(() => notify("生成设置记忆保存失败", "warning"));
  }, [notify]);

  const restoreDefaultGenerationSettings = useCallback(() => {
    const nextMemory: GenerationSettingsMemory = {
      version: 1,
      enabled: rememberLastSettings,
      byMode: {},
    };
    generationSettingsMemoryRef.current = nextMemory;
    setDocumentSessions((sessions) => Object.fromEntries(Object.entries(sessions).map(([documentId, session]) => {
      const defaults = settingsFromDraft({
        ...INITIAL_DRAFT,
        mode: session.draft.mode,
        outputTarget: session.draft.mode === "text" ? INITIAL_DRAFT.outputTarget : "current-document",
      });
      return [documentId, {
        ...session,
        draft: {
          ...session.draft,
          ...defaults,
          prompt: session.draft.prompt,
          references: session.draft.references,
        },
      }];
    })));
    void saveGenerationSettingsMemory(nextMemory).catch(() => notify("恢复默认设置保存失败", "warning"));
    notify("已恢复两种模式的默认生成设置", "success");
  }, [notify, rememberLastSettings]);

  const setCount = useCallback((value: number) => {
    const count = Number.isFinite(value) ? Math.min(4, Math.max(1, Math.round(value))) : 1;
    updateDraft({ count });
  }, [updateDraft]);

  const setCustomDimension = useCallback((key: "customWidth" | "customHeight", value: number) => {
    const normalized = Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : 1;
    updateDraft({ [key]: normalized, aspectRatio: "custom" });
  }, [updateDraft]);

  const addReferencesToDocument = useCallback((documentId: string, files: FileList | File[]) => {
    updateSession(documentId, (session) => {
      const plan = planReferenceFiles(session.draft.references, Array.from(files));
      if (plan.overflowCount) {
        window.setTimeout(() => notify("参考图最多 9 张", "warning"), 0);
      } else if (plan.duplicateCount) {
        window.setTimeout(() => notify("已忽略重复参考图", "info"), 0);
      } else if (plan.ignoredCount) {
        window.setTimeout(() => notify("只能添加图片文件", "warning"), 0);
      }
      const additions: ReferenceImage[] = plan.accepted.map((file, index) => {
        const url = URL.createObjectURL(file);
        const referenceId = `ref-${Date.now()}-${referenceIdSequence += 1}`;
        const assetId = `ps-fill-reference-${referenceId}`;
        const resources = resourcesFor(documentId);
        resources.referenceUrls.push(url);
        resources.referenceAssetIds.set(url, assetId);
        assetLifecycleRef.current.register(assetId, "blob-url", {
          documentId,
          jobId: "session",
          revision: 0,
          ownerPrefix: "ps-fill",
        }, () => URL.revokeObjectURL(url));
        return {
          id: referenceId,
          name: file.name,
          url,
          order: session.draft.references.length + index,
          file,
        };
      });
      return { ...session, draft: { ...session.draft, references: [...session.draft.references, ...additions] } };
    });
  }, [notify, resourcesFor, updateSession]);

  const addReferences = useCallback((files: FileList | File[]) => {
    const documentId = activeDocumentIdRef.current;
    if (documentId) addReferencesToDocument(documentId, files);
  }, [addReferencesToDocument]);

  const pickReferenceFiles = useCallback(() => {
    if (!UXP_RUNTIME) return;
    void pickUxpReferenceFiles()
      .then((files) => {
        if (files.length) addReferences(files);
      })
      .catch((error) => notify(
        error instanceof Error ? error.message : "无法打开本地图片选择器",
        "warning",
      ));
  }, [addReferences, notify]);

  const addSelectionReference = useCallback(() => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId || referenceCaptureInFlightRef.current) return;
    if ((documentSessionsRef.current[documentId]?.draft.references.length ?? 9) >= 9) {
      notify("参考图最多 9 张", "warning");
      return;
    }
    if (!UXP_RUNTIME) {
      notify("浏览器演示模式不能读取 Photoshop 选区", "warning");
      return;
    }
    referenceCaptureInFlightRef.current = true;
    setReferenceCaptureStatus("capturing");
    const resources = resourcesFor(documentId);
    const captureOwner = assetOwner({
      documentId,
      jobId: `reference-${Date.now()}`,
      revision: resources.previewRevision,
    });
    void photoshopGateway.captureReference("selection", documentId, captureOwner)
      .then((capture) => {
        if (!documentSessionsRef.current[documentId]) {
          throw new Error("选区对应的 Photoshop 文档已关闭");
        }
        addReferencesToDocument(documentId, [fileFromCapturedReference(capture)]);
        notify("已将当前选区加入参考图", "success");
      })
      .catch((error) => notify(
        error instanceof Error ? error.message : "无法截取 Photoshop 当前选区",
        "warning",
      ))
      .finally(() => {
        referenceCaptureInFlightRef.current = false;
        setReferenceCaptureStatus("idle");
      });
  }, [addReferencesToDocument, assetOwner, notify, resourcesFor]);

  const removeReference = useCallback((id: string) => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId) return;
    updateSession(documentId, (session) => {
      const result = removeReferenceById(session.draft.references, id);
      const removed = result.removed;
      if (removed) {
        const resources = resourcesFor(documentId);
        resources.referenceUrls = resources.referenceUrls.filter((url) => url !== removed.url);
        const assetId = resources.referenceAssetIds.get(removed.url);
        if (assetId) void assetLifecycleRef.current.cleanupResource(documentId, "blob-url", assetId);
        resources.referenceAssetIds.delete(removed.url);
      }
      return {
        ...session,
        draft: {
          ...session.draft,
          references: result.references,
        },
      };
    });
  }, [resourcesFor, updateSession]);

  const clearReferences = useCallback(() => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId) return;
    updateSession(documentId, (session) => {
      if (!session.draft.references.length) return session;
      const removedUrls = new Set(session.draft.references.map((reference) => reference.url));
      const resources = resourcesFor(documentId);
      resources.referenceUrls = resources.referenceUrls.filter((url) => !removedUrls.has(url));
      for (const url of removedUrls) {
        const assetId = resources.referenceAssetIds.get(url);
        if (assetId) void assetLifecycleRef.current.cleanupResource(documentId, "blob-url", assetId);
        resources.referenceAssetIds.delete(url);
      }
      return {
        ...session,
        draft: {
          ...session.draft,
          references: [],
        },
      };
    });
  }, [resourcesFor, updateSession]);

  const reorderReference = useCallback((id: string, toIndex: number) => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId) return;
    updateSession(documentId, (session) => {
      const fromIndex = session.draft.references.findIndex((item) => item.id === id);
      if (fromIndex < 0) return session;
      const targetIndex = Math.max(0, Math.min(Math.round(toIndex), session.draft.references.length - 1));
      if (fromIndex === targetIndex) return session;
      const references = [...session.draft.references];
      const [moved] = references.splice(fromIndex, 1);
      references.splice(targetIndex, 0, moved);
      return {
        ...session,
        draft: {
          ...session.draft,
          references: references.map((item, order) => ({ ...item, order })),
        },
      };
    });
  }, [updateSession]);

  const outputRatio = useMemo(() => {
    if (draft.mode === "redraw") return ratioFromDocument(context);
    if (draft.aspectRatio === "auto") return "API 返回比例";
    if (draft.aspectRatio === "custom") return `${draft.customWidth}:${draft.customHeight}`;
    return draft.aspectRatio;
  }, [context, draft]);

  const validationMessage = useMemo(() => {
    return realGenerationBlocker(draft, settings.apiKey, UXP_RUNTIME, context);
  }, [context, draft, settings.apiKey]);

  const finishGeneration = useCallback((snapshot: GenerationDraft, ratio: string, token: DocumentTaskToken) => {
    if (!sessionCoordinatorRef.current.accepts(token)) return;
    const { documentId, jobId } = token;
    const currentJob = documentSessionsRef.current[documentId]?.jobs.find((job) => job.id === jobId);
    if (!currentJob || !["queued", "running"].includes(currentJob.status)) return;
    const next = createCandidates(snapshot.count, snapshot.prompt, ratio);
    setDocumentSessions((sessions) => completeDocumentSession(sessions, documentId, jobId, next));
    sessionCoordinatorRef.current.finish(token);
    notify(`已生成 ${snapshot.count} 个候选，比例 ${ratio}`, "success");
  }, [notify]);

  const finishRemoteGeneration = useCallback((
  snapshot: GenerationDraft,
  contextSnapshot: PhotoshopContext | null,
  ratio: string,
  token: DocumentTaskToken,
  assets: GeneratedImageAsset[],
) => {
    if (!sessionCoordinatorRef.current.accepts(token)) return;
    const { documentId, jobId } = token;
    assetLifecycleRef.current.assertCandidateCount(assets.length);
    assets.forEach((asset) => assetLifecycleRef.current.assertImage(measureImageBytes(asset.bytes)));
    const currentJob = documentSessionsRef.current[documentId]?.jobs.find((job) => job.id === jobId);
    if (!currentJob || !["queued", "running"].includes(currentJob.status)) return;
    const resources = resourcesFor(documentId);
    resources.candidateUrls.forEach((url) => URL.revokeObjectURL(url));
    resources.candidateUrls = [];
    const next = assets.map((asset, index) => {
      const url = assetPreviewUrl(asset);
      resources.candidateUrls.push(url);
      const owner = assetOwner(token);
      assetLifecycleRef.current.registerBytes(`ps-fill-candidate-${jobId}-${index}`, owner, asset);
      assetLifecycleRef.current.register(
        `ps-fill-blob-${jobId}-${index}`,
        "blob-url",
        owner,
        () => URL.revokeObjectURL(url),
      );
      return {
      id: `remote-${jobId}-${index}`,
      title: `方案 ${String(index + 1).padStart(2, "0")}`,
      url,
      aspectRatio: ratio,
      selected: index === 0,
      asset,
      sourceDocumentId: contextSnapshot?.documentId ?? documentId,
      outputTarget: snapshot.outputTarget,
      generationMode: snapshot.mode,
    };
    });
    resources.candidateOwner = token;
    const directWrite = next.length === 1;
    setDocumentSessions((sessions) => completeDocumentSession(sessions, documentId, jobId, next, directWrite));
    sessionCoordinatorRef.current.finish(token);
    if (directWrite) {
      notify("图片已生成，正在写入 Photoshop", "success");
      void writeSingleCandidate(documentId, next[0]);
    } else {
      notify(`API 已完成 ${next.length} 个候选`, "success");
    }
  }, [assetOwner, notify, resourcesFor, writeSingleCandidate]);

  const stagePreviewForDocument = useCallback((documentId: string) => {
    if (!UXP_RUNTIME || activeDocumentIdRef.current !== documentId) return;
    const session = documentSessionsRef.current[documentId];
    if (!session || !canStagePreview(session)) return;
    const resources = resourcesFor(documentId);
    if (resources.previewStaging) return;
    resources.previewStaging = true;
    const previewRevision = resources.previewRevision + 1;
    resources.previewRevision = previewRevision;
    const first = session.candidates.find((candidate) => candidate.id === session.activeCandidateId)
      ?? session.candidates[0];
    if (!first?.asset) {
      resources.previewStaging = false;
      return;
    }
    updateSession(documentId, (current) => ({
      ...current,
      previewRevision,
      previewStatus: "staging",
    }));
    void (async () => {
      if (resources.previewAssetId) {
        await assetLifecycleRef.current.cleanupResource(documentId, "preview-layer", resources.previewAssetId);
        resources.previewAssetId = null;
      }
      await previewCoordinatorRef.current!.show(first.sourceDocumentId ?? documentId, first.asset!);
      const currentPreview = previewCoordinatorRef.current!.current(first.sourceDocumentId ?? documentId);
      if (!currentPreview) throw new Error("Photoshop 未返回候选预览层");
      return currentPreview.session;
    })().then((previewSession) => {
      const current = documentSessionsRef.current[documentId];
      if (!current || current.previewRevision !== previewRevision || resources.previewRevision !== previewRevision) {
        resources.previewCleanup = true;
        return previewCoordinatorRef.current!.discard(previewSession.documentId)
          .catch(() => undefined)
          .finally(() => {
            resources.previewCleanup = false;
          });
      }
      const previewAssetId = `ps-fill-preview-${documentId}-${previewRevision}`;
      resources.previewAssetId = previewAssetId;
      const ownerToken = resources.candidateOwner ?? { documentId, jobId: "preview", revision: previewRevision };
      assetLifecycleRef.current.register(previewAssetId, "preview-layer", assetOwner(ownerToken), () => (
        previewCoordinatorRef.current!.discard(previewSession.documentId)
      ));
      setDocumentSessions((sessions) => {
        const committed = commitPreviewSession(sessions, documentId, previewRevision, previewSession);
        if (committed === sessions) return sessions;
        return updateDocumentSession(committed, documentId, (next) => ({
          ...next,
          candidates: next.candidates.map((candidate) => ({
            ...candidate,
            photoshopLayerId: candidate.id === first.id ? previewSession.layerIds[0] : undefined,
          })),
        }), INITIAL_DRAFT);
      });
    }).catch((error) => {
      const current = documentSessionsRef.current[documentId];
      if (current && current.previewRevision === previewRevision && resources.previewRevision === previewRevision) {
        updateSession(documentId, (current) => ({ ...current, previewStatus: "idle" }));
      }
      if (activeDocumentIdRef.current === documentId) {
        notify(error instanceof Error ? error.message : "候选预览写入失败", "warning");
      }
    }).finally(() => {
      resources.previewStaging = false;
      if (resources.previewRevision === previewRevision && !resources.previewCleanup) {
        resources.previewCleanup = false;
      }
    });
  }, [assetOwner, notify, resourcesFor, updateSession]);

  const startGeneration = useCallback(() => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId || !documentSessionsRef.current[documentId]) {
      notify("请先打开 Photoshop 文档", "warning");
      return false;
    }
    if (validationMessage) {
      notify(validationMessage, "warning");
      return false;
    }
    const resources = resourcesFor(documentId);
    if (sessionCoordinatorRef.current.current(documentId)) {
      notify("当前文档已有生成任务", "warning");
      return false;
    }
    if (resources.previewStaging || resources.previewCleanup) {
      notify("正在清理候选预览，请稍后再生成", "warning");
      return false;
    }
    if (resources.insertInFlight) {
      notify("已生成图片正在写入 Photoshop，请稍后", "warning");
      return false;
    }
    if (remoteRequestCoordinator.isBusy()) {
      notify("已有一个付费远程任务正在运行，请等待完成后再试", "warning");
      return false;
    }
    if (resources.timer) window.clearInterval(resources.timer);
    if (resources.startTimer) window.clearTimeout(resources.startTimer);
    if (resources.elapsedTimer) window.clearInterval(resources.elapsedTimer);
    resources.abort?.abort();
    const previewRevision = resources.previewRevision + 1;
    resources.previewRevision = previewRevision;
    const snapshot = cloneDraft(draft);
    const contextSnapshot = cloneContext(context);
    const ratio = outputRatio;
    const token = sessionCoordinatorRef.current.begin(
      documentId,
      () => `job-${Date.now()}-${localRequestSequence += 1}`,
    );
    const id = token.jobId;
    resources.jobId = id;
    const job: GenerationJob = {
      id,
      createdAt: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date()),
      draft: snapshot,
      context: contextSnapshot,
      outputRatio: ratio,
      status: "queued",
      progress: 0,
      candidates: [],
    };
    updateSession(documentId, (session) => ({
      ...session,
      previewRevision,
      candidates: [],
      activeCandidateId: null,
      previewCandidate: null,
      photoshopPreviewSession: null,
      previewStatus: "idle",
      workspaceView: "config",
      status: "queued",
      progress: 0,
      stage: snapshot.references.length ? "uploading" : "submitting",
      elapsedSeconds: 0,
      jobs: [job, ...session.jobs],
    }));
    const startedAt = Date.now();
    resources.elapsedTimer = window.setInterval(() => {
      updateSession(documentId, (session) => ({
        ...session,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
      }));
    }, 1000);
    const canRunRealGeneration = UXP_RUNTIME && settings.apiKey.trim();
    if (canRunRealGeneration) {
      const abortController = new AbortController();
      resources.abort = abortController;
      const updateJob = (update: (item: GenerationJob) => GenerationJob) => {
        if (!sessionCoordinatorRef.current.accepts(token)) return;
        updateSession(documentId, (session) => ({
          ...session,
          jobs: session.jobs.map((item) => item.id === id ? update(item) : item),
        }));
      };
      const updateStage = (nextStage: GenerationStage) => {
        if (!sessionCoordinatorRef.current.accepts(token)) return;
        updateSession(documentId, (session) => {
          const job = session.jobs.find((item) => item.id === id);
          return job && ["queued", "running"].includes(job.status)
            ? { ...session, stage: nextStage }
            : session;
        });
      };
      const updateProgress = (nextProgress: number) => {
        if (!sessionCoordinatorRef.current.accepts(token)) return;
        updateSession(documentId, (session) => {
          const job = session.jobs.find((item) => item.id === id);
          return job && ["queued", "running"].includes(job.status)
            ? {
              ...session,
              progress: nextProgress,
              jobs: session.jobs.map((item) => item.id === id
                ? { ...item, progress: nextProgress }
                : item),
            }
            : session;
        });
      };
      void (async () => {
        try {
          let liveContext = contextSnapshot;
          let requestSnapshot = snapshot;
          let liveRatio = ratio;
          const needsLiveContext = snapshot.mode !== "text"
            || snapshot.outputTarget === "current-document";
          if (needsLiveContext && activeDocumentIdRef.current === documentId) {
            updateStage("capturing");
            const currentContext = await photoshopGateway.getContext();
            if (!sessionCoordinatorRef.current.accepts(token)) return;
            if (currentContext.documentId === documentId) {
              liveContext = currentContext;
              activateDocumentContext(currentContext);
            }
            const blocker = realGenerationBlocker(snapshot, settings.apiKey.trim(), true, liveContext);
            if (blocker) throw new Error(blocker);
            liveRatio = snapshot.mode === "redraw"
              ? ratioFromDocument(liveContext)
              : ratio;
            updateJob((item) => ({ ...item, context: liveContext, outputRatio: liveRatio }));
          }
          if (snapshot.mode === "redraw" && liveContext) {
            const captures = [await photoshopGateway.captureReference(
              "document",
              documentId,
              assetOwner(token),
            )];
            if (!sessionCoordinatorRef.current.accepts(token)) return;
            const contextReferences: ReferenceImage[] = captures.map((capture, index) => {
              const bytes = capture.bytes.buffer.slice(
                capture.bytes.byteOffset,
                capture.bytes.byteOffset + capture.bytes.byteLength,
              ) as ArrayBuffer;
              return {
                id: `context-${id}-${index}`,
                name: capture.fileName,
                url: `blob:photoshop-context-${index}`,
                order: index,
                file: new Blob([bytes], { type: capture.mimeType }),
                kind: "photoshop-context",
              };
            });
            const availableManualSlots = 9 - contextReferences.length;
            requestSnapshot = {
              ...snapshot,
              outputTarget: "current-document",
              references: [...contextReferences, ...snapshot.references.slice(0, availableManualSlots).map((reference, index) => ({
                ...reference,
                order: index + contextReferences.length,
              }))],
            };
            updateJob((item) => ({ ...item, context: liveContext, draft: requestSnapshot, outputRatio: liveRatio }));
          }
          const provider = new OpenAIImageProvider({
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey.trim(),
            model: generationModel(
              requestSnapshot.model,
              settings.modelOptions,
              settings.providerSnapshot,
            ),
          });
          const sessionUploader = {
            upload: (file: Blob, fileName: string, signal: AbortSignal) => {
              let fingerprint = referenceFingerprintsRef.current.get(file);
              if (!fingerprint) {
                fingerprint = `blob-${referenceFingerprintSequenceRef.current += 1}`;
                referenceFingerprintsRef.current.set(file, fingerprint);
              }
              return assetLifecycleRef.current.reuseUpload(documentId, fingerprint, () => (
                referenceUploader.upload(file, fileName, signal)
              )).then((url) => {
                assetLifecycleRef.current.register(
                  `ps-fill-upload-${token.jobId}-${fingerprint}`,
                  "upload-result",
                  assetOwner(token),
                );
                return url;
              });
            },
          };
          updateSession(documentId, (session) => ({ ...session, status: "running" }));
          updateJob((item) => ({ ...item, status: "running" }));
          const assets = await new GenerationService().generate({
            draft: requestSnapshot,
            modelOptions: settings.modelOptions,
            apiKey: settings.apiKey.trim(),
            signal: abortController.signal,
            onProgress: updateProgress,
            uploader: sessionUploader,
            onStage: updateStage,
            context: liveContext ?? undefined,
            providerSnapshot: settings.providerSnapshot,
            remoteProvider: provider,
            remoteAudit: {
              localRequestId: token.jobId,
              documentId,
              mode: requestSnapshot.mode,
              submittedAt: Date.now(),
              promptHash: hashPrompt(requestSnapshot.prompt),
            },
          });
          if (assets.length > 0 && requestSnapshot.prompt.trim()) {
            recordSuccessfulPrompt(requestSnapshot.prompt, requestSnapshot.mode);
          }
          if (!sessionCoordinatorRef.current.accepts(token)) return;
          updateStage("downloading");
          finishRemoteGeneration(requestSnapshot, liveContext, liveRatio, token, assets);
          refreshBalanceRef.current(false);
          refreshCloudTasksRef.current();
        } catch (error) {
          if ((error as Error).name === "AbortError") return;
          if (!sessionCoordinatorRef.current.accepts(token)) return;
          const failedJob = documentSessionsRef.current[documentId]?.jobs.find((item) => item.id === id);
          if (!failedJob || !["queued", "running"].includes(failedJob.status)) return;
          console.error("[generative-fill] generation failed", error);
          updateSession(documentId, (session) => ({
            ...session,
            status: session.jobs.find((item) => item.id === id)?.status === "running"
              || session.jobs.find((item) => item.id === id)?.status === "queued"
              ? "idle"
              : session.status,
            stage: session.jobs.find((item) => item.id === id)?.status === "running"
              || session.jobs.find((item) => item.id === id)?.status === "queued"
              ? "idle"
              : session.stage,
            jobs: session.jobs.map((item) => item.id === id && ["queued", "running"].includes(item.status)
              ? { ...item, status: "cancelled" }
              : item),
          }));
          notify(readableGenerationError(error), "warning");
          await assetLifecycleRef.current.cleanupJob(documentId, token.jobId, token.revision);
          sessionCoordinatorRef.current.finish(token);
        } finally {
          if (resources.abort === abortController) resources.abort = null;
          if (resources.jobId === id) {
            if (resources.elapsedTimer) window.clearInterval(resources.elapsedTimer);
            resources.elapsedTimer = null;
            resources.jobId = null;
          }
        }
      })();
      return true;
    }
    if (UXP_RUNTIME) {
      notify("请先配置 API Key", "warning");
      updateSession(documentId, (session) => ({
        ...session,
        status: "idle",
        stage: "idle",
        jobs: session.jobs.map((item) => item.id === id ? { ...item, status: "cancelled" } : item),
      }));
      if (resources.elapsedTimer) window.clearInterval(resources.elapsedTimer);
      resources.elapsedTimer = null;
      resources.jobId = null;
      sessionCoordinatorRef.current.finish(token);
      return false;
    }
    resources.startTimer = window.setTimeout(() => {
      updateSession(documentId, (session) => ({
        ...session,
        status: session.status === "queued" ? "running" : session.status,
        stage: "generating",
        jobs: session.jobs.map((item) => item.id === id && item.status === "queued"
          ? { ...item, status: "running" }
          : item),
      }));
      resources.startTimer = null;
    }, 400);
    let simulatedProgress = 0;
    resources.timer = window.setInterval(() => {
      simulatedProgress = Math.min(100, simulatedProgress + 8);
      updateSession(documentId, (session) => ({
        ...session,
        progress: simulatedProgress,
        status: simulatedProgress < 100 ? "running" : session.status,
        jobs: session.jobs.map((item) => item.id === id
          ? { ...item, progress: simulatedProgress, status: simulatedProgress < 100 ? "running" : item.status }
          : item),
      }));
      if (simulatedProgress === 100) {
        if (resources.timer) window.clearInterval(resources.timer);
        resources.timer = null;
        window.setTimeout(() => {
          finishGeneration(snapshot, ratio, token);
          if (resources.jobId === id) {
            resources.jobId = null;
            if (resources.elapsedTimer) window.clearInterval(resources.elapsedTimer);
            resources.elapsedTimer = null;
          }
        }, 180);
      }
    }, 180);
    return true;
  }, [activateDocumentContext, context, draft, finishGeneration, finishRemoteGeneration, notify, outputRatio, recordSuccessfulPrompt, resourcesFor, settings, updateSession, validationMessage]);

  const cancelGeneration = useCallback(() => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId) return;
    const resources = resourcesFor(documentId);
    const token = sessionCoordinatorRef.current.cancel(documentId);
    if (!token) return;
    if (resources.timer) window.clearInterval(resources.timer);
    if (resources.startTimer) window.clearTimeout(resources.startTimer);
    resources.abort?.abort();
    resources.abort = null;
    resources.timer = null;
    resources.startTimer = null;
    if (resources.elapsedTimer) window.clearInterval(resources.elapsedTimer);
    resources.elapsedTimer = null;
    setDocumentSessions((sessions) => cancelDocumentJob(sessions, documentId, token.jobId));
    void assetLifecycleRef.current.cleanupJob(documentId, token.jobId, token.revision);
    resources.jobId = null;
    sessionCoordinatorRef.current.finishCancellation(token);
    notify("已取消当前任务");
  }, [notify, resourcesFor, updateSession]);

  const activateCandidate = useCallback((id: string) => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId) return;
    const candidate = candidates.find((item) => item.id === id);
    if (!candidate) return;
    updateSession(documentId, (session) => ({
      ...session,
      activeCandidateId: id,
      candidates: session.candidates.map((item) => ({ ...item, selected: item.id === id })),
    }));
    if (!UXP_RUNTIME || !candidate.asset || candidate.outputTarget === "new-document") return;
    updateSession(documentId, (session) => ({ ...session, previewStatus: "switching" }));
    const resources = resourcesFor(documentId);
    const previewRevision = resources.previewRevision;
    resources.previewQueue = resources.previewQueue
      .catch(() => undefined)
      .then(() => {
        const current = documentSessionsRef.current[documentId];
        if (!current || current.previewRevision !== previewRevision || resources.previewRevision !== previewRevision) return;
        return (async () => {
          if (resources.previewAssetId) {
            await assetLifecycleRef.current.cleanupResource(documentId, "preview-layer", resources.previewAssetId);
            resources.previewAssetId = null;
          }
          await previewCoordinatorRef.current!.show(
            candidate.sourceDocumentId ?? documentId,
            candidate.asset!,
          );
          const preview = previewCoordinatorRef.current!.current(candidate.sourceDocumentId ?? documentId);
          if (!preview) throw new Error("Photoshop 未返回候选预览层");
          const previewAssetId = `ps-fill-preview-${documentId}-${previewRevision}-${candidate.id}`;
          resources.previewAssetId = previewAssetId;
          const ownerToken = resources.candidateOwner ?? { documentId, jobId: "preview", revision: previewRevision };
          assetLifecycleRef.current.register(previewAssetId, "preview-layer", assetOwner(ownerToken), () => (
            previewCoordinatorRef.current!.discard(preview.session.documentId)
          ));
          updateSession(documentId, (session) => ({
            ...session,
            photoshopPreviewSession: preview.session,
            candidates: session.candidates.map((item) => ({
              ...item,
              photoshopLayerId: item.id === candidate.id ? preview.session.layerIds[0] : undefined,
            })),
          }));
        })();
      })
      .then(() => {
        const current = documentSessionsRef.current[documentId];
        if (current?.previewRevision === previewRevision && resources.previewRevision === previewRevision) {
          updateSession(documentId, (session) => ({ ...session, previewStatus: "ready" }));
        }
      })
      .catch((error) => {
        const current = documentSessionsRef.current[documentId];
        if (current?.previewRevision === previewRevision && resources.previewRevision === previewRevision) {
          updateSession(documentId, (session) => ({ ...session, previewStatus: "ready" }));
          notify(error instanceof Error ? error.message : "候选预览切换失败", "warning");
        }
      });
  }, [assetOwner, candidates, notify, resourcesFor, updateSession]);

  const toggleCandidate = activateCandidate;
  const selectAllCandidates = useCallback(() => {
    const first = candidates[0];
    if (first) activateCandidate(first.id);
  }, [activateCandidate, candidates]);

  const selectedCount = activeCandidateId ? 1 : 0;

  const insertSelected = useCallback(() => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId) {
      notify("请先打开 Photoshop 文档", "warning");
      return;
    }
    if (!selectedCount) {
      notify("请先选择候选图", "warning");
      return;
    }
    const selected = candidates.filter((candidate) => candidate.id === activeCandidateId);
    const resources = resourcesFor(documentId);
    if (resources.insertInFlight) return;
    if (photoshopPreviewSession && selected[0]?.photoshopLayerId) {
      resources.insertInFlight = true;
      const previewRevision = resources.previewRevision + 1;
      resources.previewRevision = previewRevision;
      resources.previewCleanup = true;
      updateSession(documentId, (session) => ({
        ...session,
        previewRevision,
        previewStatus: "committing",
      }));
      void previewCoordinatorRef.current!.commit(documentId).then(async () => {
        if (resources.previewRevision !== previewRevision) return;
        await releaseDocumentResults(documentId);
        notify("已确认当前候选并释放临时资源", "success");
      }).catch((error) => {
        if (resources.previewRevision === previewRevision) {
          updateSession(documentId, (session) => ({ ...session, previewStatus: "ready" }));
          notify(error instanceof Error ? error.message : "确认候选失败", "warning");
        }
      }).finally(() => {
        resources.insertInFlight = false;
        if (resources.previewRevision === previewRevision) resources.previewCleanup = false;
      });
      return;
    }
    const assets = selected.flatMap((candidate) => candidate.asset ? [candidate.asset] : []);
    const resultTarget = selected[0]?.outputTarget ?? draft.outputTarget;
    const sourceDocumentId = selected[0]?.sourceDocumentId;
    if (!UXP_RUNTIME || assets.length !== selected.length) {
      notify(`浏览器演示：已模拟${resultTarget === "new-document" ? "新建文档" : "插入图层"}（${selectedCount} 张）`, "info");
      return;
    }
    resources.insertInFlight = true;
    const previewRevision = resources.previewRevision + 1;
    resources.previewRevision = previewRevision;
    updateSession(documentId, (session) => ({
      ...session,
      previewRevision,
      previewStatus: "committing",
    }));
    const insertionOwner = resources.candidateOwner
      ? assetOwner(resources.candidateOwner)
      : assetOwner({ documentId, jobId: "insert", revision: previewRevision });
    void photoshopGateway.insert(
      assets,
      resultTarget,
      sourceDocumentId ?? documentId,
      insertionOwner,
    )
      .then(async () => {
        if (resources.previewRevision !== previewRevision) return;
        await releaseDocumentResults(documentId);
        notify(
          resultTarget === "new-document"
            ? `已新建文档并插入 ${selectedCount} 个候选`
            : `已插入 ${selectedCount} 个命名图层`,
          "success",
        );
      })
      .catch((error) => {
        if (resources.previewRevision === previewRevision) {
          updateSession(documentId, (session) => ({ ...session, previewStatus: "ready" }));
          notify(error instanceof Error ? error.message : "Photoshop 写入失败", "warning");
        }
      })
      .finally(() => {
        resources.insertInFlight = false;
      });
  }, [activeCandidateId, assetOwner, candidates, draft.outputTarget, notify, photoshopPreviewSession, releaseDocumentResults, resourcesFor, selectedCount, updateSession]);

  const commitSnapshot = useCallback((
    snapshot: NonNullable<ConnectionSettings["providerSnapshot"]>,
    baseUrl: string,
    apiKey: string,
  ) => {
    const currentSettings = settingsRef.current;
    if (currentSettings.baseUrl !== baseUrl || currentSettings.apiKey.trim() !== apiKey) return;
    const modelOptions = snapshotModelOptions(snapshot);
    setSettingsState((current) => ({
      ...current,
      connectionStatus: providerConnectionStatus(snapshot, balanceRef.current),
      providerSnapshot: snapshot,
      modelOptions,
    }));
    setDocumentSessions((sessions) => Object.fromEntries(
      Object.entries(sessions).map(([documentId, session]) => {
        const current = session.draft;
        const model = modelOptions.includes(current.model)
          ? current.model
          : modelOptions.includes("auto")
            ? "auto"
            : "";
        const capability = capabilityForModel(snapshot, model);
        return [documentId, {
          ...session,
          draft: {
            ...current,
            model,
            resolution: capability
              ? capability.resolutions.includes(current.resolution)
                ? current.resolution
                : capability.defaultResolution
              : "api-default",
            quality: capability?.qualityOptions.length && !capability.qualityOptions.includes(current.quality)
              ? capability.qualityOptions[0]
              : current.quality,
            aspectRatio: !capability
              || current.aspectRatio === "custom"
              || (
                current.aspectRatio !== "auto"
                && !capability.aspectRatios.includes(current.aspectRatio)
              )
              ? "auto"
              : current.aspectRatio,
          },
        }];
      }),
    ));
  }, []);

  const refreshBalance = useCallback((showLoading = true) => {
    const current = settingsRef.current;
    const apiKey = current.apiKey.trim();
    if (!apiKey) {
      setBalance(EMPTY_BALANCE);
      return;
    }
    balanceRefreshAbortRef.current?.abort();
    const controller = new AbortController();
    balanceRefreshAbortRef.current = controller;
    if (showLoading) {
      setBalance((previous) => ({ ...previous, status: "loading", unit: "积分", error: undefined }));
    }
    const provider = new OpenAIImageProvider({
      baseUrl: current.baseUrl,
      apiKey,
      model: generationModel(current.modelOptions[0] ?? "", current.modelOptions, current.providerSnapshot),
    });
    void provider.getBalance(controller.signal).then((next) => {
      if (
        settingsRef.current.baseUrl === current.baseUrl
        && settingsRef.current.apiKey.trim() === apiKey
      ) {
        setBalance(next);
        if (next.status === "available") {
          setSettingsState((value) => ({ ...value, connectionStatus: "connected" }));
        }
      }
    }).catch((error) => {
      if ((error as Error).name === "AbortError") return;
      if (
        settingsRef.current.baseUrl === current.baseUrl
        && settingsRef.current.apiKey.trim() === apiKey
      ) {
        setBalance({
          status: "error",
          unit: "积分",
          updatedAt: Date.now(),
          error: error instanceof Error ? error.message : "余额查询失败",
        });
        if ((error as Error).name === "AuthenticationError") {
          setSettingsState((value) => ({ ...value, connectionStatus: "failed" }));
        }
      }
    }).finally(() => {
      if (balanceRefreshAbortRef.current === controller) balanceRefreshAbortRef.current = null;
    });
  }, []);
  refreshBalanceRef.current = refreshBalance;

  const refreshModels = useCallback((showToast = true) => {
    const current = settingsRef.current;
    const apiKey = current.apiKey.trim();
    if (!apiKey) {
      if (showToast) notify("请先填写 API Key", "warning");
      return;
    }
    providerRefreshAbortRef.current?.abort();
    const controller = new AbortController();
    providerRefreshAbortRef.current = controller;
    setSettingsState((value) => ({ ...value, connectionStatus: "testing" }));
    const provider = new OpenAIImageProvider({
      baseUrl: current.baseUrl,
      apiKey,
      model: generationModel(current.modelOptions[0] ?? "", current.modelOptions, current.providerSnapshot),
    });
    void provider.discover(controller.signal).then((snapshot) => {
      commitSnapshot(snapshot, current.baseUrl, apiKey);
      if (showToast) notify(`已刷新 ${snapshot.models.length} 个模型`, "success");
    }).catch((error) => {
      if ((error as Error).name === "AbortError") return;
      const latest = settingsRef.current;
      if (latest.baseUrl !== current.baseUrl || latest.apiKey.trim() !== apiKey) return;
      setSettingsState((value) => ({
        ...value,
        connectionStatus: "failed",
        providerSnapshot: value.providerSnapshot
          ? { ...value.providerSnapshot, source: "cache", stale: true }
          : null,
      }));
      if (showToast) notify(error instanceof Error ? error.message : "模型刷新失败", "warning");
    }).finally(() => {
      if (providerRefreshAbortRef.current === controller) providerRefreshAbortRef.current = null;
    });
  }, [commitSnapshot, notify]);

  refreshAllRef.current = () => {
    refreshModels(false);
    refreshBalance(false);
  };

  useEffect(() => {
    let disposed = false;
    void credentialStore.loadApiKey().then((apiKey) => {
      if (disposed || credentialEditedRef.current || !apiKey) return;
      setSettingsState((current) => {
        const next = { ...current, apiKey };
        settingsRef.current = next;
        return next;
      });
      setCredentialSaveStatus("saved");
    }).catch(() => notify("无法读取 UXP 安全存储中的 API Key", "warning"));
    return () => { disposed = true; };
  }, [notify]);

  useEffect(() => {
    if (credentialSaveStatus === "saved" && settings.apiKey.trim()) refreshAllRef.current();
  }, [credentialSaveStatus, settings.apiKey, settings.baseUrl]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        refreshBalanceRef.current(false);
      }
    };
    const timer = window.setInterval(refreshWhenVisible, 60_000);
    document.addEventListener?.("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener?.("visibilitychange", refreshWhenVisible);
    };
  }, []);

  const testConnection = useCallback(() => {
    const current = settingsRef.current;
    const apiKey = current.apiKey.trim();
    if (!apiKey) {
      notify("请先填写 API Key", "warning");
      return;
    }
    providerRefreshAbortRef.current?.abort();
    balanceRefreshAbortRef.current?.abort();
    setCloudRecordsOpen(false);
    const controller = new AbortController();
    providerRefreshAbortRef.current = controller;
    setSettingsState((value) => ({ ...value, connectionStatus: "testing" }));
    setBalance((previous) => ({ ...previous, status: "loading", unit: "积分", error: undefined }));
    const provider = new OpenAIImageProvider({
      baseUrl: current.baseUrl,
      apiKey,
      model: generationModel(current.modelOptions[0] ?? "", current.modelOptions, current.providerSnapshot),
    });
    void provider.testConnection(controller.signal).then((result) => {
      commitSnapshot(result.snapshot, current.baseUrl, apiKey);
      if (
        settingsRef.current.baseUrl === current.baseUrl
        && settingsRef.current.apiKey.trim() === apiKey
      ) setBalance(result.balance);
      notify(
        result.snapshot.credentialVerified ? "API 连接及凭据验证正常" : "API 服务可达",
        result.snapshot.credentialVerified ? "success" : "info",
      );
    }).catch((error) => {
      if ((error as Error).name === "AbortError") return;
      setSettingsState((value) => ({ ...value, connectionStatus: "failed" }));
      setBalance({
        status: "error",
        unit: "积分",
        updatedAt: Date.now(),
        error: error instanceof Error ? error.message : "连接测试失败",
      });
      notify(error instanceof Error ? error.message : "连接测试失败", "warning");
    }).finally(() => {
      if (providerRefreshAbortRef.current === controller) providerRefreshAbortRef.current = null;
    });
  }, [commitSnapshot, notify, setCloudRecordsOpen]);

  useEffect(() => {
    let disposed = false;
    if (UXP_RUNTIME) {
      void photoshopGateway.getContext()
        .then((next) => {
          if (disposed) return;
          activateDocumentContext(next);
        })
        .catch((error) => {
          if (!disposed) setActiveDocumentId(null);
          notify(error instanceof Error ? error.message : "无法读取 Photoshop 文档", "warning");
        });
    }
    return () => { disposed = true; };
  }, [activateDocumentContext, notify]);

  useEffect(() => {
    if (UXP_RUNTIME) void photoshopGateway.cleanupPluginResiduals().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!UXP_RUNTIME) return undefined;
    let disposed = false;
    let inFlight = false;
    const refreshActiveDocument = () => {
      if (disposed || inFlight) return;
      inFlight = true;
      void Promise.all([
        photoshopGateway.getContext().catch(() => null),
        photoshopGateway.getOpenDocumentIds().then((ids) => ids).catch(() => null),
      ]).then(([next, openIds]) => {
        if (disposed) return;
        if (openIds) {
          const knownIds = new Set(openIds);
          for (const documentId of Object.keys(documentSessionsRef.current)) {
            if (!knownIds.has(documentId)) {
              cleanupDocumentResources(documentId);
              setDocumentSessions((sessions) => removeDocumentSession(sessions, documentId));
            }
          }
        }
        if (next) activateDocumentContext(next);
        else if (openIds?.length === 0) setActiveDocumentId(null);
        else if (openIds && activeDocumentIdRef.current && !openIds.includes(activeDocumentIdRef.current)) {
          setActiveDocumentId(null);
        }
      }).finally(() => {
        inFlight = false;
      });
    };
    refreshActiveDocument();
    const timer = window.setInterval(refreshActiveDocument, 400);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activateDocumentContext, cleanupDocumentResources]);

  useEffect(() => {
    if (!activeDocumentId || !activeSession) return;
    stagePreviewForDocument(activeDocumentId);
  }, [activeDocumentId, activeSession, stagePreviewForDocument]);

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    for (const documentId of Array.from(documentResourcesRef.current.keys())) cleanupDocumentResources(documentId);
  }, [cleanupDocumentResources]);

  const returnToConfiguration = useCallback(() => {
    const documentId = activeDocumentIdRef.current;
    if (!documentId) return;
    const resources = resourcesFor(documentId);
    const previewRevision = resources.previewRevision + 1;
    resources.previewRevision = previewRevision;
    resources.previewCleanup = true;
    updateSession(documentId, (session) => ({
      ...session,
      previewRevision,
      previewStatus: "committing",
      workspaceView: "config",
    }));
    void releaseDocumentResults(documentId)
      .then(() => {
        if (resources.previewRevision !== previewRevision) return;
        updateSession(documentId, (session) => ({
          ...session,
          previewRevision,
          previewStatus: "idle",
          workspaceView: "config",
        }));
      })
      .catch((error) => {
        if (resources.previewRevision === previewRevision) {
          updateSession(documentId, (session) => ({ ...session, previewStatus: "ready" }));
          notify(error instanceof Error ? error.message : "清理候选预览失败", "warning");
        }
      })
      .finally(() => {
        if (resources.previewRevision === previewRevision) resources.previewCleanup = false;
      });
  }, [notify, releaseDocumentResults, resourcesFor, updateSession]);
  const currentModelCapability = useMemo(
    () => capabilityForModel(settings.providerSnapshot, draft.model),
    [draft.model, settings.providerSnapshot],
  );
  const setPreviewCandidate = useCallback((candidate: Candidate | null) => {
    updateActiveSession((session) => ({ ...session, previewCandidate: candidate }));
  }, [updateActiveSession]);

  return {
    runtimeMode: UXP_RUNTIME ? "uxp" as const : "browser" as const,
    draft, updateDraft, setCount, setCustomDimension,
    context, outputRatio, validationMessage,
    settings, setSettings, settingsOpen, setSettingsOpen,
    cloudRecordsOpen, setCloudRecordsOpen, cloudRecords, cloudRecordsStatus, cloudRecordsError,
    cloudTaskImages, refreshCloudTasks, loadCloudTaskImage,
    rememberLastSettings, generationSettingsReady, setRememberLastSettings, restoreDefaultGenerationSettings,
    promptNotes, promptNotesReady, savePromptNote, deletePromptNote,
    togglePromptNotePinned, reorderPromptNote,
    promptHistory, promptHistoryReady, deletePromptHistory, clearPromptHistory,
    saveApiKey, credentialSaveStatus, balance, currentModelCapability,
    theme, setTheme, workspaceView, returnToConfiguration,
    generationResultStatus, writeStatus, writeError, retryGeneratedWrite, discardGeneratedResult,
    status, progress, stage, elapsedSeconds, candidates, jobs, selectedCount,
    activeCandidateId, previewStatus, activateCandidate,
    previewCandidate, setPreviewCandidate, toast, notify,
    addReferences, addSelectionReference, referenceCaptureStatus,
    pickReferenceFiles, reorderReference, removeReference, clearReferences,
    startGeneration, cancelGeneration, toggleCandidate,
    selectAllCandidates, insertSelected, testConnection,
    refreshModels: () => refreshModels(true),
    refreshBalance: () => refreshBalance(true),
  };
}

export type PrototypeController = ReturnType<typeof usePrototypeState>;
