import { describe, expect, it } from "vitest";
import {
  canStagePreview,
  cancelDocumentJob,
  commitPreviewSession,
  completeDocumentSession,
  createDocumentSession,
  removeDocumentSession,
  updateDocumentSession,
  upsertDocumentSession,
} from "../src/documentSessionState";
import type { GenerationDraft, PhotoshopContext } from "../src/types";

const draft: GenerationDraft = {
  mode: "inpaint",
  prompt: "移除多余头发",
  model: "klein-9b",
  resolution: "2K",
  quality: "high",
  count: 3,
  aspectRatio: "auto",
  customWidth: 1,
  customHeight: 1,
  outputTarget: "current-document",
  references: [],
  inpaintStrength: "strong",
};

const context = (documentId: string, documentName: string): PhotoshopContext => ({
  documentId,
  documentName,
  width: 4000,
  height: 3000,
  colorMode: "RGB",
  selection: { x: 100, y: 120, width: 500, height: 400 },
});

describe("document session state", () => {
  it("keeps A results isolated while a new B document stays on the default UI", () => {
    const a = createDocumentSession("doc-a", draft, context("doc-a", "同名.psd"));
    a.workspaceView = "results";
    a.candidates = [{
      id: "candidate-a",
      title: "A 候选",
      url: "blob:a",
      aspectRatio: "1:1",
      selected: true,
      sourceDocumentId: "doc-a",
    }];
    const sessions = upsertDocumentSession({}, a);
    const b = createDocumentSession("doc-b", draft, context("doc-b", "同名.psd"));
    const withB = upsertDocumentSession(sessions, b);

    expect(withB["doc-a"].workspaceView).toBe("results");
    expect(withB["doc-a"].candidates[0].sourceDocumentId).toBe("doc-a");
    expect(withB["doc-b"].workspaceView).toBe("config");
    expect(withB["doc-b"].candidates).toHaveLength(0);
  });

  it("preserves state for the same document ID when its title changes", () => {
    const first = createDocumentSession("doc-a", draft, context("doc-a", "旧名.psd"));
    first.workspaceView = "results";
    first.activeCandidateId = "candidate-a";
    const sessions = upsertDocumentSession({}, first);
    const renamed = updateDocumentSession(sessions, "doc-a", (session) => ({
      ...session,
      context: context("doc-a", "新名.psd"),
    }));

    expect(renamed["doc-a"].context?.documentName).toBe("新名.psd");
    expect(renamed["doc-a"].workspaceView).toBe("results");
    expect(renamed["doc-a"].activeCandidateId).toBe("candidate-a");
  });

  it("does not collide for two same-named documents and removes only the closed one", () => {
    const a = createDocumentSession("doc-a", draft, context("doc-a", "肖像.psd"));
    const b = createDocumentSession("doc-b", draft, context("doc-b", "肖像.psd"));
    const sessions = upsertDocumentSession(upsertDocumentSession({}, a), b);
    const remaining = removeDocumentSession(sessions, "doc-a");

    expect(Object.keys(remaining)).toEqual(["doc-b"]);
    expect(remaining["doc-b"].context?.documentName).toBe("肖像.psd");
  });

  it("routes a late completion to A without changing the active B session", () => {
    const a = createDocumentSession("doc-a", draft, context("doc-a", "A.psd"));
    const b = createDocumentSession("doc-b", draft, context("doc-b", "B.psd"));
    a.jobs = [{
      id: "job-a",
      createdAt: "16:00",
      draft,
      context: a.context,
      outputRatio: "1:1",
      status: "running",
      progress: 42,
      candidates: [],
    }];
    b.jobs = [{
      id: "job-b",
      createdAt: "16:01",
      draft,
      context: b.context,
      outputRatio: "4:3",
      status: "running",
      progress: 19,
      candidates: [],
    }];
    const sessions = upsertDocumentSession(upsertDocumentSession({}, a), b);
    const completed = completeDocumentSession(sessions, "doc-a", "job-a", [{
      id: "candidate-a",
      title: "A 完成",
      url: "blob:a",
      aspectRatio: "1:1",
      selected: true,
      sourceDocumentId: "doc-a",
    }]);

    expect(completed["doc-a"].workspaceView).toBe("results");
    expect(completed["doc-a"].jobs[0].status).toBe("completed");
    expect(completed["doc-b"].workspaceView).toBe("config");
    expect(completed["doc-b"].progress).toBe(0);
    expect(completed["doc-b"].jobs[0].status).toBe("running");
  });

  it("keeps one generated asset in-session for direct write without entering results", () => {
    const a = createDocumentSession("doc-a", { ...draft, count: 1 }, context("doc-a", "A.psd"));
    a.status = "running";
    a.jobs = [{
      id: "job-a",
      createdAt: "16:00",
      draft: { ...draft, count: 1 },
      context: a.context,
      outputRatio: "1:1",
      status: "running",
      progress: 95,
      candidates: [],
    }];
    const candidate = {
      id: "single",
      title: "单图",
      url: "blob:single",
      aspectRatio: "1:1",
      selected: true,
      asset: { id: "asset-single", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
    };
    const completed = completeDocumentSession({ "doc-a": a }, "doc-a", "job-a", [candidate], true);

    expect(completed["doc-a"]).toMatchObject({
      workspaceView: "config",
      generationResultStatus: "succeeded",
      writeStatus: "pending",
      candidates: [expect.objectContaining({ id: "single" })],
    });
  });

  it.each([
    ["text", "new-document"],
    ["text", "current-document"],
    ["redraw", "current-document"],
    ["inpaint", "current-document"],
  ] as const)("routes one %s image for %s directly to the write phase", (mode, outputTarget) => {
    const singleDraft = { ...draft, mode, outputTarget, count: 1 };
    const session = createDocumentSession("doc-direct", singleDraft, context("doc-direct", "direct.psd"));
    session.status = "running";
    session.jobs = [{
      id: "job-direct",
      createdAt: "16:00",
      draft: singleDraft,
      context: session.context,
      outputRatio: "1:1",
      status: "running",
      progress: 95,
      candidates: [],
    }];
    const completed = completeDocumentSession({ "doc-direct": session }, "doc-direct", "job-direct", [{
      id: "single",
      title: "单图",
      url: "blob:single",
      aspectRatio: "1:1",
      selected: true,
      generationMode: mode,
      outputTarget,
    }], true);

    expect(completed["doc-direct"]).toMatchObject({
      workspaceView: "config",
      generationResultStatus: "succeeded",
      writeStatus: "pending",
    });
  });

  it("keeps multiple generated assets on the candidate results page", () => {
    const a = createDocumentSession("doc-a", { ...draft, count: 3 }, context("doc-a", "A.psd"));
    a.status = "running";
    a.jobs = [{
      id: "job-a",
      createdAt: "16:00",
      draft,
      context: a.context,
      outputRatio: "1:1",
      status: "running",
      progress: 95,
      candidates: [],
    }];
    const candidates = [0, 1, 2].map((index) => ({
      id: `candidate-${index}`,
      title: `候选 ${index}`,
      url: `blob:${index}`,
      aspectRatio: "1:1",
      selected: index === 0,
    }));
    const completed = completeDocumentSession({ "doc-a": a }, "doc-a", "job-a", candidates);

    expect(completed["doc-a"]).toMatchObject({
      workspaceView: "results",
      generationResultStatus: "succeeded",
      writeStatus: "idle",
    });
    expect(completed["doc-a"].candidates).toHaveLength(3);
  });

  it("rejects a late completion after the task was cancelled", () => {
    const a = createDocumentSession("doc-a", draft, context("doc-a", "A.psd"));
    a.jobs = [{
      id: "job-a",
      createdAt: "16:00",
      draft,
      context: a.context,
      outputRatio: "1:1",
      status: "cancelled",
      progress: 42,
      candidates: [],
    }];
    const sessions = upsertDocumentSession({}, a);
    const result = completeDocumentSession(sessions, "doc-a", "job-a", [{
      id: "late",
      title: "不应写入",
      url: "blob:late",
      aspectRatio: "1:1",
      selected: true,
    }]);

    expect(result).toBe(sessions);
    expect(result["doc-a"].workspaceView).toBe("config");
    expect(result["doc-a"].candidates).toHaveLength(0);
  });

  it("keeps each document progress and cancellation control isolated", () => {
    const a = createDocumentSession("doc-a", draft, context("doc-a", "A.psd"));
    const b = createDocumentSession("doc-b", draft, context("doc-b", "B.psd"));
    a.jobs = [{
      id: "job-a",
      createdAt: "16:00",
      draft,
      context: a.context,
      outputRatio: "1:1",
      status: "running",
      progress: 32,
      candidates: [],
    }];
    b.jobs = [{
      id: "job-b",
      createdAt: "16:01",
      draft,
      context: b.context,
      outputRatio: "4:3",
      status: "running",
      progress: 71,
      candidates: [],
    }];
    const sessions = upsertDocumentSession(upsertDocumentSession({}, a), b);
    const progressedA = updateDocumentSession(sessions, "doc-a", (session) => ({
      ...session,
      status: "running",
      progress: 86,
      jobs: session.jobs.map((job) => job.id === "job-a" ? { ...job, progress: 86 } : job),
    }));
    const cancelledB = cancelDocumentJob(progressedA, "doc-b", "job-b");

    expect(cancelledB["doc-a"].progress).toBe(86);
    expect(cancelledB["doc-a"].jobs[0].status).toBe("running");
    expect(cancelledB["doc-b"].status).toBe("cancelled");
    expect(cancelledB["doc-b"].jobs[0].status).toBe("cancelled");
  });

  it("rejects a late preview session after the user returned to configuration", () => {
    const a = createDocumentSession("doc-a", draft, context("doc-a", "A.psd"));
    a.workspaceView = "results";
    a.previewRevision = 1;
    const sessions = upsertDocumentSession({}, a);
    const returned = updateDocumentSession(sessions, "doc-a", (session) => ({
      ...session,
      previewRevision: 2,
      workspaceView: "config",
      previewStatus: "idle",
    }));
    const late = commitPreviewSession(returned, "doc-a", 1, {
      documentId: "doc-a",
      layerIds: ["late-layer"],
    });

    expect(late).toBe(returned);
    expect(late["doc-a"].workspaceView).toBe("config");
    expect(late["doc-a"].photoshopPreviewSession).toBeNull();
  });

  it("does not restart Photoshop preview after returning to configuration", () => {
    const a = createDocumentSession("doc-a", draft, context("doc-a", "A.psd"));
    a.workspaceView = "results";
    a.candidates = [{
      id: "candidate-a",
      title: "候选",
      url: "blob:a",
      aspectRatio: "1:1",
      selected: true,
      sourceDocumentId: "doc-a",
      asset: { id: "asset-a", bytes: new Uint8Array([1]), mimeType: "image/png" },
    }];
    expect(canStagePreview(a)).toBe(true);

    const returned = updateDocumentSession({ "doc-a": a }, "doc-a", (session) => ({
      ...session,
      workspaceView: "config",
      previewStatus: "idle",
    }));
    expect(canStagePreview(returned["doc-a"])).toBe(false);
  });

  it("does not auto-stage candidates whose target is a new document", () => {
    const a = createDocumentSession("doc-a", { ...draft, outputTarget: "new-document" }, context("doc-a", "A.psd"));
    a.workspaceView = "results";
    a.candidates = [{
      id: "candidate-a",
      title: "候选",
      url: "blob:a",
      aspectRatio: "1:1",
      selected: true,
      sourceDocumentId: "doc-a",
      outputTarget: "new-document",
      asset: { id: "asset-a", bytes: new Uint8Array([1]), mimeType: "image/png" },
    }];

    expect(canStagePreview(a)).toBe(false);
  });

  it("does not re-stage a current-document candidate after it was committed", () => {
    const a = createDocumentSession("doc-a", draft, context("doc-a", "A.psd"));
    a.workspaceView = "results";
    a.previewStatus = "ready";
    a.candidates = [{
      id: "candidate-a",
      title: "已保留候选",
      url: "blob:a",
      aspectRatio: "1:1",
      selected: true,
      sourceDocumentId: "doc-a",
      outputTarget: "current-document",
      asset: { id: "asset-a", bytes: new Uint8Array([1]), mimeType: "image/png" },
    }];

    expect(canStagePreview(a)).toBe(false);
  });
});
