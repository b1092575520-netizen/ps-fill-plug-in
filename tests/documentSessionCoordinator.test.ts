import { describe, expect, it, vi } from "vitest";
import { DocumentSessionCoordinator } from "../src/documentSessionCoordinator";

describe("DocumentSessionCoordinator", () => {
  it("turns a rapid double click into one active task", () => {
    const coordinator = new DocumentSessionCoordinator();
    const first = coordinator.begin("doc-a", () => "job-a");
    const second = coordinator.begin("doc-a", () => "job-b");

    expect(second).toEqual(first);
    expect(coordinator.sessionCount()).toBe(1);
  });

  it("keeps the original job id while cancellation reaches a terminal state", () => {
    const coordinator = new DocumentSessionCoordinator();
    const token = coordinator.begin("doc-a", () => "job-a");
    expect(coordinator.cancel("doc-a")?.jobId).toBe("job-a");
    expect(coordinator.current("doc-a")?.jobId).toBe("job-a");
    coordinator.finishCancellation(token);
    expect(coordinator.current("doc-a")).toBeNull();
  });

  it("rejects late callbacks after a newer revision starts", () => {
    const coordinator = new DocumentSessionCoordinator();
    const old = coordinator.begin("doc-a", () => "job-a");
    coordinator.finish(old);
    const current = coordinator.begin("doc-a", () => "job-b");

    expect(coordinator.accepts(old)).toBe(false);
    expect(coordinator.accepts(current)).toBe(true);
  });

  it("deduplicates an in-flight poll without blocking another document", async () => {
    const coordinator = new DocumentSessionCoordinator();
    const pollA = vi.fn(async () => "a");
    const pollB = vi.fn(async () => "b");
    const first = coordinator.poll("doc-a", "job-a", pollA);
    const duplicate = coordinator.poll("doc-a", "job-a", pollA);
    const other = coordinator.poll("doc-b", "job-b", pollB);

    await expect(Promise.all([first, duplicate, other])).resolves.toEqual(["a", "a", "b"]);
    expect(pollA).toHaveBeenCalledOnce();
    expect(pollB).toHaveBeenCalledOnce();
  });
});
