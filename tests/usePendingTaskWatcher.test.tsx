import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  reconcilePendingTasks,
  usePendingTaskWatcher,
  type PendingTaskOutcome,
} from "../src/hooks/usePendingTaskWatcher";
import { RemoteRequestCoordinator, type RemoteRequestStorage } from "../src/remoteRequestLedger";
import type { CloudTaskRecord } from "../src/types";

const NOW = Date.now();

function memoryStorage(): RemoteRequestStorage {
  let value: unknown = [];
  return {
    load: async () => value,
    save: async (records) => { value = structuredClone(records); },
  };
}

function task(taskId: string, status: string): CloudTaskRecord {
  return {
    taskId, model: "gpt-image-2-oai", status, createdAt: NOW, completedAt: null,
    thumbnailUrl: null, origin: "external-or-unknown",
  };
}

async function cancelAfterAccept(coordinator: RemoteRequestCoordinator, localRequestId: string, taskId: string) {
  const controller = new AbortController();
  const running = coordinator.run({
    localRequestId, documentId: "doc", mode: "text", submittedAt: NOW, promptHash: "sha256:x",
  }, "gpt-image-2-oai", async (controls) => {
    await controls.beforeGenerationPost();
    await controls.taskAccepted(taskId);
    await new Promise((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")));
    });
  });
  await vi.waitFor(() => expect(coordinator.submissionState(localRequestId)).toBe("accepted"));
  controller.abort();
  await running.catch(() => undefined);
}

function Harness(props: Parameters<typeof usePendingTaskWatcher>[0]) {
  usePendingTaskWatcher(props);
  return null;
}

describe("pending task follow-up", () => {
  it("unlocks the account once a cancelled task finishes upstream, without submitting again", async () => {
    const coordinator = new RemoteRequestCoordinator(memoryStorage(), () => NOW);
    await cancelAfterAccept(coordinator, "job-1", "task-1");
    expect(coordinator.isBusy()).toBe(true);

    const batchGetTasks = vi.fn(async () => [task("task-1", "succeeded")]);
    const outcome = await reconcilePendingTasks({ batchGetTasks }, coordinator, new AbortController().signal);

    expect(batchGetTasks).toHaveBeenCalledWith(["task-1"], expect.any(AbortSignal));
    expect(outcome).toEqual({ completed: 1, failed: 0, unknown: 0, pending: 0 });
    expect(coordinator.isBusy()).toBe(false);
  });

  it("stops holding the account when Xinbao reports the task outcome as uncertain", async () => {
    const coordinator = new RemoteRequestCoordinator(memoryStorage(), () => NOW);
    await cancelAfterAccept(coordinator, "job-u", "task-u");

    const outcome = await reconcilePendingTasks(
      { batchGetTasks: vi.fn(async () => [task("task-u", "uncertain")]) },
      coordinator,
      new AbortController().signal,
    );

    expect(outcome).toEqual({ completed: 0, failed: 0, unknown: 1, pending: 0 });
    expect(coordinator.isBusy()).toBe(false);
    expect(coordinator.snapshot()[0]).toMatchObject({ status: "unknown" });
  });

  it("asks nothing when no submitted task is waiting", async () => {
    const coordinator = new RemoteRequestCoordinator(memoryStorage(), () => NOW);
    const batchGetTasks = vi.fn(async () => []);
    await expect(reconcilePendingTasks({ batchGetTasks }, coordinator, new AbortController().signal))
      .resolves.toEqual({ completed: 0, failed: 0, unknown: 0, pending: 0 });
    expect(batchGetTasks).not.toHaveBeenCalled();
  });

  it("starts watching when a task detaches and reports the result once", async () => {
    const coordinator = new RemoteRequestCoordinator(memoryStorage(), () => NOW);
    const statuses = ["running", "running", "succeeded"];
    const batchGetTasks = vi.fn(async () => [task("task-2", statuses.shift() ?? "succeeded")]);
    const onResolved = vi.fn<(outcome: PendingTaskOutcome) => void>();
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Harness
        settings={{ baseUrl: "https://async.xinbao-ai.com", apiKey: "key" }}
        enabled
        onResolved={onResolved}
        ledger={coordinator}
        providerFactory={() => ({ batchGetTasks })}
        intervalMs={5}
      />);
    });

    await act(async () => { await cancelAfterAccept(coordinator, "job-2", "task-2"); });
    await act(async () => {
      await vi.waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    });

    expect(onResolved).toHaveBeenCalledWith({ completed: 1, failed: 0, unknown: 0, pending: 0 });
    expect(coordinator.isBusy()).toBe(false);
    const calls = batchGetTasks.mock.calls.length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(batchGetTasks).toHaveBeenCalledTimes(calls);
    act(() => tree.unmount());
  });

  it("keeps trying after a network error and stays idle without an API key", async () => {
    const coordinator = new RemoteRequestCoordinator(memoryStorage(), () => NOW);
    await cancelAfterAccept(coordinator, "job-3", "task-3");
    const batchGetTasks = vi.fn()
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValue([task("task-3", "failed")]);
    const onResolved = vi.fn();

    let idle!: ReturnType<typeof create>;
    await act(async () => {
      idle = create(<Harness
        settings={{ baseUrl: "https://async.xinbao-ai.com", apiKey: " " }}
        enabled
        onResolved={onResolved}
        ledger={coordinator}
        providerFactory={() => ({ batchGetTasks })}
        intervalMs={5}
      />);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(batchGetTasks).not.toHaveBeenCalled();
    act(() => idle.unmount());

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Harness
        settings={{ baseUrl: "https://async.xinbao-ai.com", apiKey: "key" }}
        enabled
        onResolved={onResolved}
        ledger={coordinator}
        providerFactory={() => ({ batchGetTasks })}
        intervalMs={5}
      />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(onResolved).toHaveBeenCalledWith({ completed: 0, failed: 1, unknown: 0, pending: 0 }));
    });
    expect(batchGetTasks).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });
});
