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
    )).rejects.toThrow("已有一个付费远程任务");
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

  it("keeps the account locked when a submitted POST has an uncertain outcome", async () => {
    const memory = memoryStorage();
    const coordinator = new RemoteRequestCoordinator(memory.storage, () => NOW);
    await expect(coordinator.run(audit("uncertain"), "gpt-image-2-oai", async (controls) => {
      await controls.beforeGenerationPost();
      throw new TypeError("network reset");
    })).rejects.toThrow("network reset");

    expect(coordinator.snapshot()[0]).toMatchObject({ postCount: 1, status: "uncertain" });
    await expect(coordinator.run(
      audit("next", "doc-b"),
      "gpt-image-2-oai",
      vi.fn(async () => undefined),
    )).rejects.toThrow("已有一个付费远程任务");
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
    await coordinator.reconcileProviderTask("task-reconcile", " SUCCESS ");
    expect(coordinator.isBusy()).toBe(false);
    expect(coordinator.snapshot()[0]).toMatchObject({ status: "completed" });
  });
});
