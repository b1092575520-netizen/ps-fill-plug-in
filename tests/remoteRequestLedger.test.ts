import { describe, expect, it, vi } from "vitest";
import {
  hashPrompt,
  normalizeRemoteRequestRecords,
  REMOTE_REQUEST_RETENTION_MS,
  RemoteRequestCoordinator,
  type RemoteRequestAudit,
  type RemoteRequestRecord,
  type RemoteRequestStorage,
} from "../src/remoteRequestLedger";

const NOW = 1_800_000_000_000;

function audit(localRequestId: string, documentId = "doc-a"): RemoteRequestAudit {
  return {
    localRequestId,
    documentId,
    mode: "text",
    submittedAt: NOW,
    promptHash: hashPrompt("测试提示词"),
  };
}

function memoryStorage(initial: unknown = []) {
  let value = initial;
  const storage: RemoteRequestStorage = {
    load: vi.fn(async () => value),
    save: vi.fn(async (records) => { value = structuredClone(records); }),
  };
  return { storage, value: () => value as RemoteRequestRecord[] };
}

describe("remote request ledger", () => {
  it("hashes prompt text with SHA-256 without retaining the source text", () => {
    expect(hashPrompt("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashPrompt("测试提示词")).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("keeps only validated metadata from the latest three days", () => {
    const recent = {
      ...audit("recent"),
      model: "gpt-image-2-oai",
      postCount: 8,
      providerTaskId: "task-recent",
      status: "completed",
    };
    const expired = {
      ...recent,
      localRequestId: "expired",
      submittedAt: NOW - REMOTE_REQUEST_RETENTION_MS - 1,
    };
    const records = normalizeRemoteRequestRecords([expired, recent, { unexpected: true }], NOW);

    expect(records).toEqual([expect.objectContaining({
      localRequestId: "recent",
      postCount: 1,
      providerTaskId: "task-recent",
    })]);
    expect(Object.keys(records[0]).sort()).toEqual([
      "documentId", "localRequestId", "mode", "model", "postCount",
      "promptHash", "providerTaskId", "status", "submittedAt",
    ]);
  });

  it("shares one in-flight operation for the same local request", async () => {
    const memory = memoryStorage();
    const coordinator = new RemoteRequestCoordinator(memory.storage, () => NOW);
    let resolve!: (value: string) => void;
    const operation = vi.fn(async (controls) => {
      await controls.beforeGenerationPost();
      await controls.taskAccepted("task-1");
      return new Promise<string>((done) => { resolve = done; });
    });

    const first = coordinator.run(audit("same"), "gpt-image-2-oai", operation);
    const duplicate = coordinator.run(audit("same"), "gpt-image-2-oai", operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    resolve("done");

    await expect(Promise.all([first, duplicate])).resolves.toEqual(["done", "done"]);
    expect(coordinator.snapshot()[0]).toMatchObject({ postCount: 1, status: "completed" });
  });

  it("blocks another document while the account has a paid task", async () => {
    const memory = memoryStorage();
    const coordinator = new RemoteRequestCoordinator(memory.storage, () => NOW);
    let resolve!: () => void;
    const first = coordinator.run(audit("request-a", "doc-a"), "gpt-image-2-oai", async (controls) => {
      await controls.beforeGenerationPost();
      await controls.taskAccepted("task-a");
      return new Promise<void>((done) => { resolve = done; });
    });
    await vi.waitFor(() => expect(coordinator.snapshot()[0]?.postCount).toBe(1));

    await expect(coordinator.run(
      audit("request-b", "doc-b"),
      "gpt-image-2-oai",
      vi.fn(async () => undefined),
    )).rejects.toThrow("上一张图还在心宝生成中");
    resolve();
    await first;
  });

  it("never resubmits a completed local request after a component rebuild", async () => {
    const memory = memoryStorage();
    const firstCoordinator = new RemoteRequestCoordinator(memory.storage, () => NOW);
    await firstCoordinator.run(audit("completed"), "gpt-image-2-oai", async (controls) => {
      await controls.beforeGenerationPost();
      return "done";
    });
    const rebuiltCoordinator = new RemoteRequestCoordinator(memory.storage, () => NOW);
    const operation = vi.fn(async () => "duplicate");

    await expect(rebuiltCoordinator.run(audit("completed"), "gpt-image-2-oai", operation))
      .rejects.toThrow("已经提交过");
    expect(operation).not.toHaveBeenCalled();
  });

  it("holds an unconfirmed POST for three minutes only, including after a restart", async () => {
    const memory = memoryStorage();
    let now = NOW;
    const coordinator = new RemoteRequestCoordinator(memory.storage, () => now);
    await expect(coordinator.run(audit("uncertain"), "gpt-image-2-oai", async (controls) => {
      await controls.beforeGenerationPost();
      throw new TypeError("network reset");
    })).rejects.toThrow(/没收到心宝的确认.*network reset/);

    expect(coordinator.snapshot()[0]).toMatchObject({ postCount: 1, status: "uncertain" });
    expect(coordinator.submissionState("uncertain")).toBe("sent");
    await expect(coordinator.run(
      audit("next", "doc-b"),
      "gpt-image-2-oai",
      vi.fn(async () => undefined),
    )).rejects.toThrow("3 分钟内暂不能重新生成");

    const restarted = new RemoteRequestCoordinator(memory.storage, () => now);
    await restarted.listRecords();
    expect(restarted.isBusy()).toBe(true);

    now = NOW + 3 * 60 * 1000 + 1;
    expect(coordinator.isBusy()).toBe(false);
    expect(restarted.isBusy()).toBe(false);
    await expect(restarted.run({ ...audit("after-window"), submittedAt: now }, "gpt-image-2-oai", async () => "ok"))
      .resolves.toBe("ok");
  });

  it("treats a 5xx answer to the paid POST as unconfirmed, never as a free failure", async () => {
    const memory = memoryStorage();
    const coordinator = new RemoteRequestCoordinator(memory.storage, () => NOW);
    await expect(coordinator.run(audit("server-error"), "gpt-image-2-oai", async (controls) => {
      await controls.beforeGenerationPost();
      await controls.generationPostResponded(502);
      throw new Error("请求失败（502）");
    })).rejects.toThrow(/可能已扣分/);
    expect(coordinator.isBusy()).toBe(true);
  });

  it("releases a 4xx rejection immediately because nothing was charged", async () => {
    const memory = memoryStorage();
    const coordinator = new RemoteRequestCoordinator(memory.storage, () => NOW);
    await expect(coordinator.run(audit("rejected"), "gpt-image-2-oai", async (controls) => {
      await controls.beforeGenerationPost();
      await controls.generationPostResponded(400);
      throw new Error("请求失败（400）");
    })).rejects.toThrow("请求失败（400）");
    expect(coordinator.isBusy()).toBe(false);
  });

  it("keeps a cancelled task with an ID locked, lists it for follow-up and notifies once detached", async () => {
    const memory = memoryStorage();
    let now = NOW;
    const coordinator = new RemoteRequestCoordinator(memory.storage, () => now);
    const listener = vi.fn();
    coordinator.onDetachedPending(listener);
    const controller = new AbortController();
    const running = coordinator.run(audit("cancelled"), "gpt-image-2-oai", async (controls) => {
      await controls.beforeGenerationPost();
      await controls.taskAccepted("task-cancelled");
      await new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new DOMException("已取消", "AbortError")));
      });
    });
    await vi.waitFor(() => expect(coordinator.submissionState("cancelled")).toBe("accepted"));
    expect(await coordinator.detachedPendingTaskIds()).toEqual([]);

    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect(await coordinator.detachedPendingTaskIds()).toEqual(["task-cancelled"]);
    expect(coordinator.isBusy()).toBe(true);
    expect(coordinator.busyMessage()).toContain("还在心宝生成中");

    now = NOW + 20 * 60 * 1000 + 1;
    expect(await coordinator.detachedPendingTaskIds()).toEqual([]);
    expect(coordinator.isBusy()).toBe(false);
  });

  it("reconciles terminal provider aliases and releases the account lock", async () => {
    const memory = memoryStorage();
    const coordinator = new RemoteRequestCoordinator(memory.storage, () => NOW);
    await expect(coordinator.run(audit("reconcile"), "gpt-image-2-oai", async (controls) => {
      await controls.beforeGenerationPost();
      await controls.taskAccepted("task-reconcile");
      throw new TypeError("network reset");
    })).rejects.toThrow("network reset");

    expect(coordinator.isBusy()).toBe(true);
    await expect(coordinator.reconcileProviderTask("task-reconcile", "running")).resolves.toBeNull();
    await expect(coordinator.reconcileProviderTask("task-reconcile", " SUCCESS ")).resolves.toBe("completed");
    await expect(coordinator.reconcileProviderTask("task-reconcile", "succeeded")).resolves.toBeNull();
    expect(coordinator.isBusy()).toBe(false);
    expect(coordinator.snapshot()[0]).toMatchObject({ status: "completed" });
  });
});
