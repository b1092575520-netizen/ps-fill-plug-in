import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  insert: vi.fn(),
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
    captureReference: vi.fn(),
    captureInpaintSnapshot: vi.fn(),
    preview: vi.fn(),
    discardPreview: vi.fn(async () => undefined),
    cleanupPluginResiduals: vi.fn(async () => undefined),
    cleanupSelectionChannel: vi.fn(async () => undefined),
  }),
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

async function waitFor(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
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

    act(() => current.savePromptNote({
      id: "favorite-separate",
      title: "手工收藏",
      prompt: "favorite prompt",
      mode: "all",
      pinned: false,
    }));
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
      expect.objectContaining({ id: "favorite-separate", prompt: "favorite prompt" }),
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

  it("blocks rapid double-click, a six-second repeat, and a second document while one POST is active", async () => {
    let resolveGeneration!: (response: Response) => void;
    const fetchFn = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/images/generations")) {
        return new Promise<Response>((resolve) => { resolveGeneration = resolve; });
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
    expect(current.startGeneration()).toBe(false);
    expect(fetchFn.mock.calls.filter(([input, init]) => (
      String(input).endsWith("/v1/images/generations") && init?.method === "POST"
    ))).toHaveLength(1);

    resolveGeneration(new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await waitFor(() => host.insert.mock.calls.length === 1, "first document result did not finish writing");
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
    expect(current.candidates).toHaveLength(0);
    expect(fetchFn.mock.calls.filter(([input, init]) => (
      String(input).endsWith("/v1/images/generations") && init?.method === "POST"
    ))).toHaveLength(1);
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
