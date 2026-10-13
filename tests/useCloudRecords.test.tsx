import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { loadCloudTaskRecords, useCloudRecords, type CloudRecordsController } from "../src/hooks/useCloudRecords";
import type { CloudTaskRecord } from "../src/types";

function Harness({
  baseUrl = "https://async.xinbao-ai.com",
  apiKey,
  expose,
  loadRecords,
  imageCache,
}: {
  baseUrl?: string;
  apiKey: string;
  expose: (controller: CloudRecordsController) => void;
  loadRecords: (identity: { baseUrl: string; apiKey: string }, signal: AbortSignal) => Promise<CloudTaskRecord[]>;
  imageCache?: { load: (task: CloudTaskRecord, signal?: AbortSignal) => Promise<string>; releaseAll: () => void };
}) {
  const controller = useCloudRecords({
    settings: { baseUrl, apiKey },
    loadRecords,
    imageCache,
  });
  expose(controller);
  return null;
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe("useCloudRecords", () => {
  it("always reads history and merges unresolved batch recovery by taskId", async () => {
    const listTasks = vi.fn(async () => [{
      taskId: "shared", model: "model", status: "running", createdAt: 100,
      completedAt: null, thumbnailUrl: null, origin: "external-or-unknown" as const,
    }, {
      taskId: "history-only", model: "model", status: "succeeded", createdAt: null,
      completedAt: null, thumbnailUrl: "https://cdn.example/history.png", origin: "external-or-unknown" as const,
    }]);
    const batchGetTasks = vi.fn(async () => [{
      taskId: "shared", model: "model", status: "succeeded", createdAt: 100,
      completedAt: 200, thumbnailUrl: "https://cdn.example/shared.png", origin: "external-or-unknown" as const,
    }]);
    const reconcileProviderTask = vi.fn(async () => undefined);
    const records = await loadCloudTaskRecords(
      { listTasks, batchGetTasks },
      {
        listRecords: vi.fn(async () => [{ providerTaskId: "shared", status: "uncertain" }]) as never,
        reconcileProviderTask,
      },
      new AbortController().signal,
    );

    expect(listTasks).toHaveBeenCalledOnce();
    expect(batchGetTasks).toHaveBeenCalledWith(["shared"], expect.any(AbortSignal));
    expect(records).toEqual([
      expect.objectContaining({ taskId: "shared", status: "succeeded", thumbnailUrl: "https://cdn.example/shared.png", origin: "plugin" }),
      expect.objectContaining({ taskId: "history-only", createdAt: null, origin: "external-or-unknown" }),
    ]);
    expect(reconcileProviderTask).toHaveBeenCalledWith("shared", "succeeded");
  });

  it("opens with a refresh and replaces an aborted identity request with the latest result", async () => {
    const requests: Array<{
      apiKey: string;
      signal: AbortSignal;
      resolve: (records: CloudTaskRecord[]) => void;
    }> = [];
    const loadRecords = vi.fn((identity: { baseUrl: string; apiKey: string }, signal: AbortSignal) => (
      new Promise<CloudTaskRecord[]>((resolve) => requests.push({ apiKey: identity.apiKey, signal, resolve }))
    ));
    let current!: CloudRecordsController;
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(<Harness apiKey="key-a" expose={(value) => { current = value; }} loadRecords={loadRecords} />);
    });
    act(() => current.setOpen(true));
    await flush();
    expect(current.status).toBe("loading");
    expect(requests).toHaveLength(1);
    expect(requests[0].apiKey).toBe("key-a");

    await act(async () => {
      tree.update(<Harness apiKey="key-b" expose={(value) => { current = value; }} loadRecords={loadRecords} />);
    });
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].apiKey).toBe("key-b");

    await act(async () => requests[0].resolve([{
      taskId: "stale-a", model: "model", status: "succeeded", createdAt: null,
      completedAt: null, thumbnailUrl: null, origin: "plugin",
    }]));
    expect(current.records).toEqual([]);

    await act(async () => requests[1].resolve([{
      taskId: "fresh-b", model: "model", status: "succeeded", createdAt: null,
      completedAt: null, thumbnailUrl: null, origin: "plugin",
    }]));
    expect(current.status).toBe("ready");
    expect(current.records.map((record) => record.taskId)).toEqual(["fresh-b"]);

    await act(async () => {
      tree.update(<Harness baseUrl="https://second.example" apiKey="key-b" expose={(value) => { current = value; }} loadRecords={loadRecords} />);
    });
    expect(requests).toHaveLength(3);
    await act(async () => requests[2].resolve([]));
    expect(current.status).toBe("ready");
    expect(current.records).toEqual([]);

    act(() => tree.unmount());
  });

  it("exposes errors and aborts the active request when the page closes", async () => {
    let rejectRequest!: (error: Error) => void;
    let activeSignal!: AbortSignal;
    const loadRecords = vi.fn((_identity: { baseUrl: string; apiKey: string }, signal: AbortSignal) => {
      activeSignal = signal;
      return new Promise<CloudTaskRecord[]>((_resolve, reject) => { rejectRequest = reject; });
    });
    let current!: CloudRecordsController;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Harness apiKey="key" expose={(value) => { current = value; }} loadRecords={loadRecords} />);
    });
    act(() => current.setOpen(true));
    await flush();
    await act(async () => rejectRequest(new Error("历史接口失败")));
    expect(current.status).toBe("error");
    expect(current.error).toBe("历史接口失败");

    act(() => current.refresh());
    await flush();
    expect(current.status).toBe("loading");
    act(() => current.setOpen(false));
    expect(activeSignal.aborted).toBe(true);
    expect(current.status).toBe("idle");
    expect(current.records).toEqual([]);
    act(() => tree.unmount());
  });

  it("turns a hanging history request into a visible timeout error", async () => {
    vi.useFakeTimers();
    try {
      let current!: CloudRecordsController;
      let tree!: ReturnType<typeof create>;
      const loadRecords = vi.fn(() => new Promise<CloudTaskRecord[]>(() => undefined));
      await act(async () => {
        tree = create(<Harness apiKey="key" expose={(value) => { current = value; }} loadRecords={loadRecords} />);
      });
      act(() => current.setOpen(true));
      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await Promise.resolve();
      });
      expect(current.status).toBe("error");
      expect(current.error).toBe("云端记录请求超时，请检查网络后重试");
      act(() => tree.unmount());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps existing records and the newest timeout when an older refresh finishes", async () => {
    vi.useFakeTimers();
    let tree!: ReturnType<typeof create>;
    try {
      let current!: CloudRecordsController;
      const records: CloudTaskRecord[] = [{ taskId: "kept", model: "model", status: "running", createdAt: null, completedAt: null, thumbnailUrl: null, origin: "plugin" }];
      let resolveOlder!: (records: CloudTaskRecord[]) => void;
      const loadRecords = vi.fn()
        .mockResolvedValueOnce(records)
        .mockImplementationOnce(() => new Promise<CloudTaskRecord[]>(resolve => { resolveOlder = resolve; }))
        .mockImplementationOnce(() => new Promise<CloudTaskRecord[]>(() => undefined));
      await act(async () => { tree = create(<Harness apiKey="key" expose={value => { current = value; }} loadRecords={loadRecords} />); });
      await act(async () => current.setOpen(true));
      await act(async () => current.refresh());
      await act(async () => current.refresh());
      await act(async () => resolveOlder([]));
      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(current.status).toBe("error");
      expect(current.error).toContain("超时");
      expect(current.records).toEqual(records);
    } finally {
      if (tree) act(() => tree.unmount());
      vi.useRealTimers();
    }
  });

  it("invalidates an in-flight request when the API key is cleared", async () => {
    const requests: Array<{ resolve: (records: CloudTaskRecord[]) => void; signal: AbortSignal }> = [];
    const loadRecords = vi.fn((_identity: { baseUrl: string; apiKey: string }, signal: AbortSignal) => (
      new Promise<CloudTaskRecord[]>((resolve) => requests.push({ resolve, signal }))
    ));
    let current!: CloudRecordsController;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Harness apiKey="key-a" expose={(value) => { current = value; }} loadRecords={loadRecords} />);
    });
    act(() => current.setOpen(true));
    await flush();
    expect(requests).toHaveLength(1);

    await act(async () => {
      tree.update(<Harness apiKey="" expose={(value) => { current = value; }} loadRecords={loadRecords} />);
    });
    expect(requests[0].signal.aborted).toBe(true);
    expect(current.status).toBe("error");
    expect(current.error).toBe("请先在设置里填好 Key");

    await act(async () => requests[0].resolve([{
      taskId: "stale-after-clear", model: "model", status: "succeeded", createdAt: null,
      completedAt: null, thumbnailUrl: null, origin: "plugin",
    }]));
    expect(current.records).toEqual([]);
    act(() => tree.unmount());
  });

  it("automatically loads the first page with at most three image chains in flight", async () => {
    const pending: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const imageCache = {
      load: vi.fn(async (task: CloudTaskRecord) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => pending.push(resolve));
        active -= 1;
        return `blob:${task.taskId}`;
      }),
      releaseAll: vi.fn(),
    };
    const records = Array.from({ length: 5 }, (_, index): CloudTaskRecord => ({
      taskId: `task-${index + 1}`,
      model: "model",
      status: "succeeded",
      createdAt: Date.now() - index,
      completedAt: null,
      thumbnailUrl: `https://cdn.example/${index + 1}.png`,
      origin: "external-or-unknown",
    }));
    let current!: CloudRecordsController;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Harness apiKey="key" expose={(value) => { current = value; }} loadRecords={async () => records} imageCache={imageCache} />);
    });
    act(() => current.setOpen(true));
    await flush();
    await flush();
    expect(imageCache.load).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(3);
    expect(Object.values(current.images).filter((image) => image.status === "loading")).toHaveLength(5);

    await act(async () => pending.shift()?.());
    await flush();
    expect(imageCache.load).toHaveBeenCalledTimes(4);
    expect(maximumActive).toBe(3);
    act(() => current.setOpen(false));
    expect(imageCache.releaseAll).toHaveBeenCalled();
    act(() => tree.unmount());
  });
});
