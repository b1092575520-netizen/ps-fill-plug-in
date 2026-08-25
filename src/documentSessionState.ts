import type { PhotoshopPreviewSession } from "./backend/contracts";
import type {
  Candidate,
  GenerationDraft,
  GenerationJob,
  GenerationStage,
  JobStatus,
  PhotoshopContext,
} from "./types";

export type DocumentWorkspaceView = "config" | "results" | "write-recovery";
export type DocumentPreviewStatus = "idle" | "staging" | "ready" | "switching" | "committing";
export type GenerationResultStatus = "idle" | "succeeded";
export type ResultWriteStatus = "idle" | "pending" | "writing" | "failed" | "completed";

export interface DocumentSession {
  documentId: string;
  draft: GenerationDraft;
  context: PhotoshopContext | null;
  status: JobStatus;
  progress: number;
  stage: GenerationStage;
  elapsedSeconds: number;
  candidates: Candidate[];
  jobs: GenerationJob[];
  previewCandidate: Candidate | null;
  photoshopPreviewSession: PhotoshopPreviewSession | null;
  activeCandidateId: string | null;
  previewStatus: DocumentPreviewStatus;
  previewRevision: number;
  workspaceView: DocumentWorkspaceView;
  generationResultStatus: GenerationResultStatus;
  writeStatus: ResultWriteStatus;
  writeError: string | null;
}

export type DocumentSessionMap = Record<string, DocumentSession>;

function cloneContext(context: PhotoshopContext | null) {
  return context
    ? { ...context, selection: context.selection ? { ...context.selection } : null }
    : null;
}

export function cloneDraftForSession(draft: GenerationDraft): GenerationDraft {
  return {
    ...draft,
    references: draft.references.map((reference) => ({ ...reference })),
  };
}

export function createDocumentSession(
  documentId: string,
  draft: GenerationDraft,
  context: PhotoshopContext | null = null,
): DocumentSession {
  return {
    documentId,
    draft: cloneDraftForSession(draft),
    context: cloneContext(context),
    status: "idle",
    progress: 0,
    stage: "idle",
    elapsedSeconds: 0,
    candidates: [],
    jobs: [],
    previewCandidate: null,
    photoshopPreviewSession: null,
    activeCandidateId: null,
    previewStatus: "idle",
    previewRevision: 0,
    workspaceView: "config",
    generationResultStatus: "idle",
    writeStatus: "idle",
    writeError: null,
  };
}

export function upsertDocumentSession(
  sessions: DocumentSessionMap,
  session: DocumentSession,
): DocumentSessionMap {
  return { ...sessions, [session.documentId]: session };
}

export function updateDocumentSession(
  sessions: DocumentSessionMap,
  documentId: string,
  update: (session: DocumentSession) => DocumentSession,
  fallbackDraft?: GenerationDraft,
): DocumentSessionMap {
  const current = sessions[documentId] ?? createDocumentSession(documentId, fallbackDraft ?? {
    mode: "text",
    prompt: "",
    model: "auto",
    resolution: "api-default",
    quality: "medium",
    count: 1,
    aspectRatio: "auto",
    customWidth: 1,
    customHeight: 1,
    outputTarget: "current-document",
    references: [],
  });
  const next = update(current);
  return next === current ? sessions : upsertDocumentSession(sessions, next);
}

export function removeDocumentSession(
  sessions: DocumentSessionMap,
  documentId: string,
): DocumentSessionMap {
  if (!sessions[documentId]) return sessions;
  const next = { ...sessions };
  delete next[documentId];
  return next;
}

export function cancelDocumentJob(
  sessions: DocumentSessionMap,
  documentId: string,
  jobId?: string,
): DocumentSessionMap {
  const current = sessions[documentId];
  if (!current) return sessions;
  const targetId = jobId ?? current.jobs.find((job) => ["queued", "running"].includes(job.status))?.id;
  if (!targetId) return sessions;
  const target = current.jobs.find((job) => job.id === targetId);
  if (!target || !["queued", "running"].includes(target.status)) return sessions;
  return updateDocumentSession(sessions, documentId, (session) => ({
    ...session,
    stage: "idle",
    status: "cancelled",
    progress: 0,
    elapsedSeconds: 0,
    jobs: session.jobs.map((job) => job.id === targetId ? { ...job, status: "cancelled" } : job),
  }));
}

export function canStagePreview(session: DocumentSession): boolean {
  return session.workspaceView === "results"
    && session.previewStatus === "idle"
    && !session.photoshopPreviewSession
    && session.candidates.length > 0
    // Creating a new Photoshop document is an explicit user action. It must
    // never be replayed by the document-switch preview restore effect.
    && session.candidates.every((candidate) => candidate.outputTarget !== "new-document"
      && Boolean(candidate.asset));
}

export function commitPreviewSession(
  sessions: DocumentSessionMap,
  documentId: string,
  previewRevision: number,
  photoshopPreviewSession: PhotoshopPreviewSession,
): DocumentSessionMap {
  const current = sessions[documentId];
  if (!current || current.previewRevision !== previewRevision || current.workspaceView !== "results") {
    return sessions;
  }
  return updateDocumentSession(sessions, documentId, (session) => ({
    ...session,
    photoshopPreviewSession,
    previewStatus: "ready",
  }));
}

export function completeDocumentSession(
  sessions: DocumentSessionMap,
  documentId: string,
  jobId: string,
  candidates: Candidate[],
  directWrite = false,
): DocumentSessionMap {
  if (!sessions[documentId]) return sessions;
  const job = sessions[documentId].jobs.find((item) => item.id === jobId);
  if (!job || !["queued", "running"].includes(job.status)) return sessions;
  return updateDocumentSession(sessions, documentId, (session) => ({
    ...session,
    candidates,
    activeCandidateId: candidates[0]?.id ?? null,
    previewStatus: "idle",
    progress: 100,
    stage: "completed",
    status: "completed",
    workspaceView: directWrite ? "config" : "results",
    generationResultStatus: "succeeded",
    writeStatus: directWrite ? "pending" : "idle",
    writeError: null,
    jobs: session.jobs.map((job) => job.id === jobId
      ? { ...job, status: "completed", progress: 100, candidates }
      : job),
  }));
}
