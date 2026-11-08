import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  insert: vi.fn(),
  captureReference: vi.fn(),
  uploadReference: vi.fn(),
  context: {
    documentId: "doc-paid-once",
    documentName: "paid-once.psd",
    width: 512,
    height: 512,
    colorMode: "RGB / 8 位",
    selection: null,
  },
  openDocumentIds: ["doc-paid-once"],
}));

vi.mock("../src/backend/runtime", () => ({
  isUxpRuntime: () => true,
  createCredentialStore: () => ({
    loadApiKey: async () => "",
    saveApiKey: async () => undefined,
    deleteApiKey: async () => undefined,
  }),
  pickUxpReferenceFiles: async () => [],
  createPhotoshopGateway: () => ({
    getContext: async () => host.context,
    getOpenDocumentIds: async () => host.openDocumentIds,
    insert: host.insert,
    captureReference: host.captureReference,
    preview: vi.fn(),
    discardPreview: vi.fn(async () => undefined),
    cleanupPluginResiduals: vi.fn(async () => undefined),
    cleanupSelectionChannel: vi.fn(async () => undefined),
  }),
}));

vi.mock("../src/backend/referenceUploader", () => ({
  TemporaryReferenceUploader: class {
    upload = host.uploadReference;
  },
}));

import {
  loadCloudTaskRecords,
  usePrototypeState,
  type PrototypeController,
} from "../src/usePrototypeState";
import { OpenAIImageProvider } from "../src/backend/provider";
import {
  RemoteRequestCoordinator,
  type RemoteRequestRecord,
  type RemoteRequestStorage,
} from "../src/remoteRequestLedger";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function Harness({ expose }: { expose: (controller: PrototypeController) => void }) {
  const controller = usePrototypeState();
  expose(controller);
  return null;
}

async function waitFor(predicate: () => boolean, message: string, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  throw new Error(message);
}

describe("usePrototypeState paid generation and write recovery", () => {
  beforeEach(() => {
    host.context = {
      documentId: "doc-paid-once",
      documentName: "paid-once.psd",
      width: 512,
      height: 512,
      colorMode: "RGB / 8 位",
      selection: null,
    };
    host.openDocumentIds = [host.context.documentId];
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        localStorage: {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => values.set(key, value),
          removeItem: (key: string) => values.delete(key),
        },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        visibilityState: "visible",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    host.insert.mockReset();
    host.captureReference.mockReset();
    host.uploadReference.mockReset().mockResolvedValue("https://cdn.example/reference.png");
    host.insert
      .mockRejectedValueOnce(new Error("Photoshop 写入失败"))
      .mockResolvedValueOnce({ documentId: host.context.documentId, layerIds: ["layer-final"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("recovers an uncertain paid task through batch-get and exposes the existing result without generation", async () => {
    const taskId = "img_7v2dfybbmw2gic3s";
    let stored: RemoteRequestRecord[] = [{
      localRequestId: "paid-real-task",
      documentId: "doc-paid-once",
      mode: "text",
      model: "gpt-image-2-oai",
      submittedAt: Date.now(),
      promptHash: "sha256:recovery",
      postCount: 1,
      providerTaskId: taskId,
      status: "uncertain",
    }];
    const storage: RemoteRequestStorage = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (records) => { stored = structuredClone(records); }),
    };
    const coordinator = new RemoteRequestCoordinator(storage);
    const resultUrl = "https://cdn.example/existing-paid-result.png";
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const task = url === "https://async.xinbao-ai.com/v1/tasks/batch-get"
        ? { id: taskId, status: "succeeded", model: "gpt-image-2-oai", created_at: new Date().toISOString(), result: { data: [{ url: resultUrl }] } }
        : { id: taskId, status: "running", model: "gpt-image-2-oai", created_at: new Date().toISOString() };
      return new Response(JSON.stringify({ items: [task] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = new OpenAIImageProvider({
      baseUrl: "https://async.xinbao-ai.com",
      apiKey: "header-only-key",
      model: "gpt-image-2-oai",
    }, { fetchFn });

    const records = await loadCloudTaskRecords(provider, coordinator, new AbortController().signal);

    expect(records).toEqual([expect.objectContaining({
      taskId,
      status: "succeeded",
      thumbnailUrl: resultUrl,
      origin: "plugin",
    })]);
    expect((await coordinator.listRecords())[0]).toMatchObject({ providerTaskId: taskId, status: "completed" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
      "https://task.xinbao-ai.com/api/v1/tasks?limit=100",
      "https://async.xinbao-ai.com/v1/tasks/batch-get",
    ]));
    const batchCall = fetchFn.mock.calls.find(([input]) => String(input).endsWith("/v1/tasks/batch-get"));
    expect(batchCall?.[1]?.method).toBe("POST");
    expect(fetchFn.mock.calls.every(([, init]) => (init?.headers as Record<string, string>)?.Authorization === "Bearer header-only-key")).toBe(true);
    expect(fetchFn.mock.calls.every(([input]) => !String(input).includes("header-only-key"))).toBe(true);
    expect(fetchFn.mock.calls.filter(([input]) => String(input).endsWith("/v1/images/generations"))).toHaveLength(0);
  });

  it("automatically hydrates a first-page list task through detail and displays its image", async () => {
    const taskId = "task-detail-needed";
    const resultUrl = "https://cdn.example/task-detail-needed.png";
    const createObjectURL = vi.fn(() => "blob:task-detail-needed");
    const revokeObjectURL = vi.fn();
    class TestURL extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal("URL", TestURL);
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://task.xinbao-ai.com/api/v1/tasks?limit=100") {
        return new Response(JSON.stringify({ items: [{
          id: taskId,
          model: "gpt-image-2-oai",
          status: "succeeded",
          created_at: new Date().toISOString(),
        }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === `https://task.xinbao-ai.com/api/v1/tasks/${taskId}`) {
        return new Response(JSON.stringify({
          id: taskId,
          model: "gpt-image-2-oai",
          status: "succeeded",
          result: { data: [{ url: resultUrl }] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === resultUrl) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchFn);

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === host.context.documentId, "Photoshop context was not activated");
    act(() => current.setSettings({
      ...current.settings,
      baseUrl: "https://async.xinbao-ai.com",
      apiKey: "detail-only-key",
    }));
    await act(async () => undefined);
    act(() => current.setCloudRecordsOpen(true));
    await waitFor(() => current.cloudRecords.length === 1, "cloud list did not load");
    await waitFor(() => current.cloudTaskImages[taskId]?.status === "ready", "cloud detail image did not load");

    expect(current.cloudTaskImages[taskId]).toMatchObject({ status: "ready", url: "blob:task-detail-needed" });
    expect(current.cloudRecords[0]).toMatchObject({ taskId, thumbnailUrl: resultUrl, origin: "external-or-unknown" });
    expect(fetchFn.mock.calls.filter(([input]) => String(input).endsWith("/v1/images/generations"))).toHaveLength(0);
    expect(fetchFn).toHaveBeenCalledWith(
      `https://task.xinbao-ai.com/api/v1/tasks/${taskId}`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer detail-only-key" }) }),
    );
    expect(String(fetchFn.mock.calls.find(([input]) => String(input).includes(taskId))?.[0])).not.toContain("detail-only-key");

    act(() => tree.unmount());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:task-detail-needed");
  });

  it("retries Photoshop writing with retained bytes without a second paid POST", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/images/generations")) {
        return new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/v1/tasks?limit=100")) {
        return new Response(JSON.stringify({ items: [{
          id: "task-cloud-separate",
          model: "gpt-image-2-oai",
          status: "succeeded",
          created_at: new Date().toISOString(),
        }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchFn);

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === host.context.documentId, "Photoshop context was not activated");
    await waitFor(() => current.promptNotesReady && current.promptHistoryReady && current.generationSettingsReady, "local stores were not loaded");

    act(() => current.favoritePrompt("favorite prompt"));
    act(() => current.setRememberLastSettings(false));
    act(() => current.setSettings({
      ...current.settings,
      apiKey: "test-key",
      modelOptions: ["gpt-image-2-oai", "gpt-image-2"],
      connectionStatus: "connected",
    }));
    act(() => current.updateDraft({
      prompt: "single paid request",
      model: "gpt-image-2-oai",
      count: 1,
      outputTarget: "current-document",
    }));
    await act(async () => undefined);
    expect(current.startGeneration()).toBe(true);

    await waitFor(() => current.workspaceView === "write-recovery", "write failure did not enter recovery");
    expect(current.writeStatus).toBe("failed");
    expect(current.candidates).toHaveLength(1);
    expect(current.candidates[0].asset?.bytes.byteLength).toBeGreaterThan(0);
    expect(current.promptHistory).toEqual([expect.objectContaining({
      prompt: "single paid request",
      mode: "text",
    })]);
    await waitFor(() => current.cloudRecords.length === 1, "cloud history did not refresh");
    expect(current.promptNotes).toEqual(expect.arrayContaining([
      expect.objectContaining({ prompt: "favorite prompt" }),
    ]));
    expect(current.cloudRecords).toEqual([expect.objectContaining({ taskId: "task-cloud-separate" })]);
    expect(JSON.stringify(current.promptHistory)).not.toContain("task-cloud-separate");
    expect(current.rememberLastSettings).toBe(false);
    expect(host.insert).toHaveBeenCalledTimes(1);

    act(() => current.retryGeneratedWrite());
    await waitFor(() => current.writeStatus === "idle" && current.candidates.length === 0, "write retry did not finish");
    expect(host.insert).toHaveBeenCalledTimes(2);
    const generationPosts = fetchFn.mock.calls.filter(([input, init]) => (
      String(input).endsWith("/v1/images/generations") && init?.method === "POST"
    ));
    expect(generationPosts).toHaveLength(1);
    expect(fetchFn.mock.calls.some(([input]) => String(input).includes("/api/v1/tasks?limit=100"))).toBe(true);

    act(() => tree.unmount());
  });

  it("returns the footer to its idle state after a single direct write succeeds", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => (
      String(input) === "https://litterbox.catbox.moe/resources/internals/api.php"
        ? new Response("https://cdn.example/reference.png", { status: 200 })
        : String(input).endsWith("/v1/images/generations")
          ? new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ items: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
    ));
    vi.stubGlobal("fetch", fetchFn);
    host.captureReference.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      fileName: "document.png",
    });
    host.insert.mockReset().mockResolvedValue({ documentId: host.context.documentId, layerIds: ["layer-final"] });

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === host.context.documentId, "Photoshop context was not activated");
    act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
    act(() => current.updateDraft({
      mode: "redraw",
      prompt: "保留人物并修复衣服边缘",
      model: "gpt-image-2-oai",
      count: 1,
      outputTarget: "current-document",
    }));
    await act(async () => undefined);

    expect(current.startGeneration()).toBe(true);
    await waitFor(() => host.insert.mock.calls.length === 1, "successful single result was not written");
    await waitFor(() => current.candidates.length === 0, "written result was not released");
    expect(host.captureReference).toHaveBeenCalledWith("document", host.context.documentId, expect.anything());

    expect(current.workspaceView).toBe("config");
    expect(current.status).toBe("idle");
    expect(current.stage).toBe("idle");
    expect(current.progress).toBe(0);
    expect(current.elapsedSeconds).toBe(0);
    expect(current.generationResultStatus).toBe("idle");
    expect(current.writeStatus).toBe("idle");

    act(() => tree.unmount());
  });

  it("keeps candidates in write recovery when a results insertion hits a modal error", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/v1/images/generations")
        ? new Response(JSON.stringify({ data: [
            { b64_json: ONE_PIXEL_PNG },
            { b64_json: ONE_PIXEL_PNG },
          ] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } })
    ));
    vi.stubGlobal("fetch", fetchFn);
    host.insert.mockReset()
      .mockRejectedValueOnce({ message: "host is in a modal state" })
      .mockResolvedValueOnce({ documentId: host.context.documentId, layerIds: ["layer-retry"] });

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === host.context.documentId, "Photoshop context was not activated");
    act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
    act(() => current.updateDraft({ prompt: "two candidates", model: "gpt-image-2-oai", count: 2 }));
    await act(async () => undefined);
    expect(current.startGeneration()).toBe(true);
    await waitFor(() => current.workspaceView === "results", "candidates did not arrive");

    act(() => current.insertSelected());
    await waitFor(() => current.toast?.text.includes("modal state") === true, "insertion failure was not reported");
    // Nothing was kept, so the results and the user's ticks stay put for another try.
    expect(current.workspaceView).toBe("results");
    expect(current.candidates).toHaveLength(2);
    expect(current.selectedCount).toBe(1);

    await waitFor(() => current.previewStatus === "idle" || current.previewStatus === "ready", "preview did not settle");
    act(() => current.insertSelected());
    await waitFor(() => current.workspaceView === "config" && current.candidates.length === 0, "second keep did not complete");
    act(() => tree.unmount());
  });

  it("keeps several results, with the image on screen placed first and visible", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/v1/images/generations")
        ? new Response(JSON.stringify({ data: [
            { b64_json: ONE_PIXEL_PNG },
            { b64_json: ONE_PIXEL_PNG },
            { b64_json: ONE_PIXEL_PNG },
          ] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } })
    ));
    vi.stubGlobal("fetch", fetchFn);
    let layer = 0;
    host.insert.mockReset().mockImplementation(async () => ({
      documentId: host.context.documentId,
      layerIds: [`layer-${layer += 1}`],
    }));

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === host.context.documentId, "Photoshop context was not activated");
    act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
    act(() => current.updateDraft({ prompt: "three candidates", model: "gpt-image-2-oai", count: 3 }));
    await act(async () => undefined);
    expect(current.startGeneration()).toBe(true);
    await waitFor(() => current.workspaceView === "results" && current.previewStatus === "ready", "candidates did not arrive");
    const [first, second, third] = current.candidates;

    // With only the previewed image ticked, the tick follows the preview.
    act(() => current.activateCandidate(third.id));
    expect(current.candidates.map((item) => item.selected)).toEqual([false, false, true]);
    // Once a second image is ticked, previewing no longer changes the ticks.
    act(() => current.toggleCandidate(first.id));
    act(() => current.activateCandidate(second.id));
    expect(current.candidates.map((item) => item.selected)).toEqual([true, false, true]);
    act(() => current.activateCandidate(third.id));
    await waitFor(() => current.previewStatus === "ready", "preview did not settle");
    expect(current.selectedCount).toBe(2);

    host.insert.mockClear();
    act(() => current.insertSelected());
    await waitFor(() => current.workspaceView === "config" && current.candidates.length === 0, "kept images were not placed");
    const placed = host.insert.mock.calls.at(-1)!;
    expect(placed[0]).toEqual([third.asset, first.asset]);
    expect(placed[1]).toBe("current-document");
    expect(current.toast?.text).toContain("已保留 2 张");
    act(() => tree.unmount());
  });

  it("blocks rapid double-click and a six-second repeat while allowing a second document", async () => {
    const resolveGenerations: Array<(response: Response) => void> = [];
    const fetchFn = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/images/generations")) {
        return new Promise<Response>((resolve) => { resolveGenerations.push(resolve); });
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchFn);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    host.insert.mockReset().mockResolvedValue({ documentId: "doc-paid-once", layerIds: ["layer-paid-once"] });

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === "doc-paid-once", "first Photoshop context was not activated");
    act(() => current.setSettings({
      ...current.settings,
      apiKey: "test-key",
      modelOptions: ["gpt-image-2-oai", "gpt-image-2"],
      connectionStatus: "connected",
    }));
    act(() => current.updateDraft({ prompt: "one active request", model: "gpt-image-2-oai", count: 1 }));
    await act(async () => undefined);

    expect(current.startGeneration()).toBe(true);
    expect(current.startGeneration()).toBe(false);
    await waitFor(() => fetchFn.mock.calls.some(([input]) => String(input).endsWith("/v1/images/generations")), "paid POST did not start");
    now += 6_000;
    expect(current.startGeneration()).toBe(false);

    host.context = {
      ...host.context,
      documentId: "doc-second",
      documentName: "second.psd",
    };
    host.openDocumentIds = ["doc-paid-once", "doc-second"];
    await waitFor(() => current.context?.documentId === "doc-second", "second Photoshop context was not activated");
    act(() => current.updateDraft({ prompt: "second document request", model: "gpt-image-2-oai", count: 1 }));
    await act(async () => undefined);
    expect(current.startGeneration()).toBe(true);
    await waitFor(() => resolveGenerations.length === 2, "second document did not submit independently");
    expect(fetchFn.mock.calls.filter(([input, init]) => (
      String(input).endsWith("/v1/images/generations") && init?.method === "POST"
    ))).toHaveLength(2);

    resolveGenerations.forEach((resolve) => resolve(new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })));
    await waitFor(() => host.insert.mock.calls.length === 2, "both document results did not finish writing");
    act(() => tree.unmount());
  });

  it("discards a retained write failure and zeroes the generated bytes", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/v1/images/generations")
        ? new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
    ));
    vi.stubGlobal("fetch", fetchFn);

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === host.context.documentId, "Photoshop context was not activated");
    act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
    act(() => current.updateDraft({ prompt: "discard retained result", model: "gpt-image-2-oai", count: 1 }));
    await act(async () => undefined);
    expect(current.startGeneration()).toBe(true);
    await waitFor(() => current.workspaceView === "write-recovery", "write failure did not enter recovery");
    const retainedAsset = current.candidates[0].asset!;
    expect(retainedAsset.bytes.byteLength).toBeGreaterThan(0);

    act(() => current.discardGeneratedResult());
    await waitFor(() => current.candidates.length === 0, "discard did not clear the session result");
    expect(retainedAsset.bytes.byteLength).toBe(0);
    expect(fetchFn.mock.calls.filter(([input, init]) => (
      String(input).endsWith("/v1/images/generations") && init?.method === "POST"
    ))).toHaveLength(1);
    act(() => tree.unmount());
  });

  it("keeps one paid POST when the accepted task later fails during polling", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/images/generations")) {
        return new Response(JSON.stringify({ id: "task-poll-failed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/tasks/batch-get")) {
        return new Response(JSON.stringify({ items: [{ id: "task-poll-failed", status: "failed" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchFn);

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === host.context.documentId, "Photoshop context was not activated");
    act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
    act(() => current.updateDraft({ prompt: "poll once then fail", model: "gpt-image-2-oai", count: 1 }));
    await act(async () => undefined);

    vi.useFakeTimers();
    expect(current.startGeneration()).toBe(true);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchFn.mock.calls.filter(([input, init]) => (
      String(input).endsWith("/v1/images/generations") && init?.method === "POST"
    ))).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await act(async () => { await Promise.resolve(); });

    expect(current.status).toBe("idle");
    expect(current.stage).toBe("idle");
    expect(current.progress).toBe(0);
    expect(current.elapsedSeconds).toBe(0);
    expect(current.candidates).toHaveLength(0);
    expect(fetchFn.mock.calls.filter(([input, init]) => (
      String(input).endsWith("/v1/images/generations") && init?.method === "POST"
    ))).toHaveLength(1);
    act(() => tree.unmount());
  });

  it("tells the truth about charges on cancel and reports the finished image in the background", async () => {
    let upstreamStatus = "running";
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith("/v1/images/generations")
        ? { id: "task-cancelled-upstream", status: "accepted" }
        : url.endsWith("/v1/tasks/batch-get")
          ? { items: [{ id: "task-cancelled-upstream", status: upstreamStatus }] }
          : { items: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchFn);

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === host.context.documentId, "Photoshop context was not activated");
    act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
    act(() => current.updateDraft({ prompt: "cancel after accept", model: "gpt-image-2-oai", count: 1 }));
    await act(async () => undefined);
    expect(current.startGeneration()).toBe(true);
    await waitFor(() => fetchFn.mock.calls.some(([input]) => String(input).endsWith("/v1/images/generations")), "paid POST did not start");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

    // Panel timers use the captured real window timers; only the background
    // follow-up interval runs on the faked global clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => current.cancelGeneration());
    expect(current.toast?.text).toContain("仍会出图并扣分");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(current.toast?.text).toContain("仍会出图并扣分");

    upstreamStatus = "succeeded";
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(current.toast?.text).toContain("已在心宝生成好");
    expect(fetchFn.mock.calls.filter(([input]) => String(input).endsWith("/v1/images/generations"))).toHaveLength(1);
    act(() => tree.unmount());
  });

  it.each(["text", "redraw"] as const)("generates %s in two documents at once and routes out-of-order results to their original documents", async (mode) => {
    const responses = new Map<string, () => void>();
    const signals = new Map<string, AbortSignal>();
    const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/v1/images/generations")) {
        const marker = JSON.parse(String(init?.body)).prompt.endsWith("A result") ? "A" : "B";
        signals.set(marker, init!.signal!);
        return new Promise<Response>((resolve) => {
          responses.set(marker, () => resolve(new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }))));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [] })));
    });
    vi.stubGlobal("fetch", fetchFn);
    const documentA = { ...host.context, documentId: `doc-concurrent-${mode}-a`, documentName: "a.psd" };
    const documentB = { ...host.context, documentId: `doc-concurrent-${mode}-b`, documentName: "b.psd" };
    host.context = documentA;
    host.openDocumentIds = [documentA.documentId, documentB.documentId];
    host.captureReference.mockImplementation(async (_scope, documentId) => ({
      bytes: new Uint8Array(Buffer.from(ONE_PIXEL_PNG, "base64")), mimeType: "image/png", fileName: `${documentId}.png`,
    }));
    host.insert.mockReset().mockImplementation(async (_assets, _target, documentId) => {
      if (host.context.documentId !== documentId) throw new Error("生成期间 Photoshop 当前文档已切换，已拒绝写入");
      return { documentId, layerIds: [`layer-${documentId}`] };
    });
    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(value) => { current = value; }} />); });
    try {
      await waitFor(() => current.context?.documentId === documentA.documentId, "document A was not activated");
      act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
      act(() => current.updateDraft({ mode, prompt: "A result", model: "gpt-image-2-oai", count: 1, outputTarget: "current-document" }));
      act(() => {
        expect(current.startGeneration()).toBe(true);
        expect(current.startGeneration()).toBe(false);
      });
      await waitFor(() => responses.has("A"), "A did not submit");
      host.context = documentB;
      await waitFor(() => current.context?.documentId === documentB.documentId, "document B was not activated");
      act(() => current.updateDraft({ mode, prompt: "B result", model: "gpt-image-2-oai", count: 1, outputTarget: "current-document" }));
      act(() => { expect(current.startGeneration()).toBe(true); });
      await waitFor(() => responses.size === 2, "B was blocked by A's running request");
      expect(host.insert).not.toHaveBeenCalled();
      expect(signals.get("A")?.aborted).toBe(false);
      if (mode === "redraw") {
        expect(host.captureReference.mock.calls.map((call) => call[1])).toEqual([documentA.documentId, documentB.documentId]);
        expect(host.uploadReference).toHaveBeenCalledTimes(2);
      } else {
        expect(host.captureReference).not.toHaveBeenCalled();
      }

      await act(async () => { responses.get("B")!(); });
      await waitFor(() => host.insert.mock.calls.length === 1 && current.status === "idle", "B did not finish independently");
      expect(host.insert.mock.calls[0][2]).toBe(documentB.documentId);
      expect(host.insert.mock.calls[0][0][0].layerName).toBe("Bresult");
      await act(async () => { responses.get("A")!(); });
      await waitFor(() => host.insert.mock.calls.length === 2 && Boolean(current.toast?.text.includes("切回")), "A's result was not held for its original document");
      expect(host.insert.mock.calls[1][2]).toBe(documentA.documentId);
      expect(current.context?.documentId).toBe(documentB.documentId);
      host.context = documentA;
      await waitFor(() => host.insert.mock.calls.length === 3, "returning to A did not restore its own result");
      expect(host.insert.mock.calls[2][2]).toBe(documentA.documentId);
      expect(host.insert.mock.calls[2][0][0].layerName).toBe("Aresult");
      expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/v1/images/generations"))).toHaveLength(2);
    } finally {
      act(() => tree.unmount());
    }
  });

  it.each(["cancel", "close"] as const)("keeps document A running when document B is %s", async (action) => {
    const signals = new Map<string, AbortSignal>();
    let finishA!: () => void;
    const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith("/v1/images/generations")) return Promise.resolve(new Response(JSON.stringify({ items: [] })));
      const prompt = JSON.parse(String(init?.body)).prompt;
      signals.set(prompt, init!.signal!);
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
        if (prompt.includes("surviving A")) finishA = () => resolve(new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] })));
      });
    });
    vi.stubGlobal("fetch", fetchFn);
    const documentA = { ...host.context, documentId: `doc-${action}-a`, documentName: "a.psd" };
    const documentB = { ...host.context, documentId: `doc-${action}-b`, documentName: "b.psd" };
    host.context = documentA;
    host.openDocumentIds = [documentA.documentId, documentB.documentId];
    host.insert.mockReset().mockResolvedValue({ documentId: documentA.documentId, layerIds: ["layer-a"] });
    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(value) => { current = value; }} />); });
    try {
      await waitFor(() => current.context?.documentId === documentA.documentId, "A was not activated");
      act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
      act(() => current.updateDraft({ mode: "text", prompt: "surviving A", model: "gpt-image-2-oai", count: 1, outputTarget: "current-document" }));
      act(() => { expect(current.startGeneration()).toBe(true); });
      await waitFor(() => Boolean(finishA), "A did not submit");
      host.context = documentB;
      await waitFor(() => current.context?.documentId === documentB.documentId, "B was not activated");
      act(() => current.updateDraft({ mode: "text", prompt: "stop B", model: "gpt-image-2-oai", count: 1, outputTarget: "current-document" }));
      act(() => { expect(current.startGeneration()).toBe(true); });
      await waitFor(() => signals.size === 2, "both documents did not submit");
      if (action === "cancel") act(() => current.cancelGeneration());
      else host.openDocumentIds = [documentA.documentId];
      host.context = documentA;
      await waitFor(() => signals.get("创建图片,stop B")?.aborted === true, "B did not stop", 260);
      await waitFor(() => current.context?.documentId === documentA.documentId, "A was not restored");
      expect(signals.get("创建图片,surviving A")?.aborted).toBe(false);
      expect(current.status).toBe("running");
      await act(async () => { finishA(); });
      await waitFor(() => host.insert.mock.calls.length === 1 && current.status === "idle", "A was affected by stopping B");
      expect(host.insert.mock.calls[0][2]).toBe(documentA.documentId);
      expect(fetchFn.mock.calls.filter(([url]) => String(url).endsWith("/v1/images/generations"))).toHaveLength(2);
    } finally {
      act(() => tree.unmount());
    }
  });

  it("places the image automatically once the user returns to the original document", async () => {
    let answerPost!: () => void;
    const fetchFn = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/images/generations")) {
        return new Promise<Response>((resolve) => {
          answerPost = () => resolve(new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchFn);
    host.insert.mockReset()
      .mockRejectedValueOnce(new Error("生成期间 Photoshop 当前文档已切换，已拒绝写入"))
      .mockResolvedValueOnce({ documentId: "doc-paid-once", layerIds: ["layer-a"] });
    const documentA = { ...host.context };
    const documentB = { ...host.context, documentId: "doc-other", documentName: "other.psd" };

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === documentA.documentId, "Photoshop context was not activated");
    act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
    act(() => current.updateDraft({ prompt: "switch away", model: "gpt-image-2-oai", count: 1, outputTarget: "current-document" }));
    await act(async () => undefined);
    expect(current.startGeneration()).toBe(true);
    await waitFor(() => Boolean(answerPost), "paid POST did not start");

    host.openDocumentIds = [documentA.documentId, documentB.documentId];
    host.context = documentB;
    await waitFor(() => current.context?.documentId === documentB.documentId, "did not follow the switch to document B");
    await act(async () => { answerPost(); });
    await waitFor(() => host.insert.mock.calls.length === 1 && Boolean(current.toast?.text.includes("就会自动放进去")), "write was not deferred");
    expect(current.toast?.text).toContain("「paid-once.psd」");

    host.context = documentA;
    await waitFor(() => host.insert.mock.calls.length === 2, "returning did not place the image");
    await waitFor(() => Boolean(current.toast?.text.includes("已生成并写入 Photoshop")), "write success was not reported");
    expect(fetchFn.mock.calls.filter(([input]) => String(input).endsWith("/v1/images/generations"))).toHaveLength(1);
    act(() => tree.unmount());
  });

  it("points to cloud records instead of waiting when the original document was closed", async () => {
    let answerPost!: () => void;
    const fetchFn = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/images/generations")) {
        return new Promise<Response>((resolve) => {
          answerPost = () => resolve(new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchFn);
    host.insert.mockReset()
      .mockRejectedValueOnce(new Error("生成任务对应的 Photoshop 文档已关闭"))
      .mockResolvedValueOnce({ documentId: "doc-paid-once", layerIds: ["layer-a"] });
    const documentA = { ...host.context };
    const documentB = { ...host.context, documentId: "doc-other", documentName: "other.psd" };

    let current!: PrototypeController;
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === documentA.documentId, "Photoshop context was not activated");
    act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
    act(() => current.updateDraft({ prompt: "switch away", model: "gpt-image-2-oai", count: 1, outputTarget: "current-document" }));
    await act(async () => undefined);
    expect(current.startGeneration()).toBe(true);
    await waitFor(() => Boolean(answerPost), "paid POST did not start");

    host.openDocumentIds = [documentA.documentId, documentB.documentId];
    host.context = documentB;
    await waitFor(() => current.context?.documentId === documentB.documentId, "did not follow the switch to document B");
    await act(async () => { answerPost(); });
    await waitFor(() => host.insert.mock.calls.length === 1 && Boolean(current.toast?.text.includes("原文档已关闭")), "closed document was not reported");
    expect(current.toast?.text).toContain("云端记录");

    host.context = documentA;
    await waitFor(() => current.context?.documentId === documentA.documentId, "did not follow the switch back");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(host.insert).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it("keeps a posted request locked across hook unmount and rebuild", async () => {
    const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith("/v1/images/generations")) {
        return Promise.resolve(new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchFn);

    let current!: PrototypeController;
    let firstTree!: ReturnType<typeof create>;
    await act(async () => { firstTree = create(<Harness expose={(controller) => { current = controller; }} />); });
    await waitFor(() => current.context?.documentId === host.context.documentId, "Photoshop context was not activated");
    act(() => current.setSettings({ ...current.settings, apiKey: "test-key", connectionStatus: "connected" }));
    act(() => current.updateDraft({ prompt: "rebuild paid request", model: "gpt-image-2-oai", count: 1 }));
    await act(async () => undefined);
    expect(current.startGeneration()).toBe(true);
    await waitFor(() => fetchFn.mock.calls.some(([input]) => String(input).endsWith("/v1/images/generations")), "paid POST did not start");
    act(() => firstTree.unmount());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    let rebuilt!: PrototypeController;
    let secondTree!: ReturnType<typeof create>;
    await act(async () => { secondTree = create(<Harness expose={(controller) => { rebuilt = controller; }} />); });
    await waitFor(() => rebuilt.context?.documentId === host.context.documentId, "rebuilt context was not activated");
    act(() => rebuilt.setSettings({ ...rebuilt.settings, apiKey: "test-key", connectionStatus: "connected" }));
    act(() => rebuilt.updateDraft({ prompt: "must not resubmit", model: "gpt-image-2-oai", count: 1 }));
    await act(async () => undefined);
    expect(rebuilt.startGeneration()).toBe(false);
    expect(fetchFn.mock.calls.filter(([input, init]) => (
      String(input).endsWith("/v1/images/generations") && init?.method === "POST"
    ))).toHaveLength(1);

    act(() => secondTree.unmount());
  });
});
