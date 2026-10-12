import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCloudLibrary, type CloudLibraryController } from "../src/hooks/useCloudLibrary";
import type { CloudTaskRecord } from "../src/types";

const task: CloudTaskRecord = { taskId: "cloud-1", model: "model", status: "succeeded", createdAt: null, completedAt: null, thumbnailUrl: "https://cdn.example/1.png", origin: "plugin" };
const asset = { id: "cloud-1", bytes: new Uint8Array([1, 2]), mimeType: "image/png" };
afterEach(() => vi.restoreAllMocks());

async function setup(options: Partial<Parameters<typeof useCloudLibrary>[0]> = {}) {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const writer = { getContext: vi.fn().mockResolvedValue({ documentId: "doc-7" }), insert: vi.fn().mockResolvedValue({ documentId: "doc-7", layerIds: ["1"] }) };
  const recover = vi.fn().mockResolvedValue({ task, asset });
  const save = vi.fn().mockResolvedValue(true);
  const props = { settings: { baseUrl: "https://example.com", apiKey: "test" }, writer, runtimeMode: "uxp" as const, recover, save, ...options };
  let current!: CloudLibraryController;
  function Harness({ apiKey = "test" }: { apiKey?: string }) { current = useCloudLibrary({ ...props, settings: { ...props.settings, apiKey } }); return null; }
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<Harness />); });
  return { get current() { return current; }, writer, recover, save, tree, Harness };
}

describe("cloud result recovery", () => {
  it("retains downloaded bytes after write failure and retries without downloading again", async () => {
    const h = await setup();
    await act(async () => h.current.select(task));
    h.writer.insert.mockRejectedValueOnce(new Error("host busy"));
    await act(async () => h.current.transfer("current-document"));
    expect(h.current.phase).toBe("error");
    expect(h.current.hasAsset).toBe(true);
    await act(async () => h.current.transfer("current-document"));
    expect(h.current.phase).toBe("done");
    expect(h.recover).toHaveBeenCalledOnce();
    expect(h.writer.insert).toHaveBeenLastCalledWith([asset], "current-document", "doc-7", expect.objectContaining({ documentId: "doc-7" }));
    act(() => h.tree.unmount());
  });

  it("blocks double-click writes and navigation until insertion settles", async () => {
    const h = await setup();
    await act(async () => h.current.select(task));
    let finish!: () => void;
    h.writer.insert.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = h.current.transfer("new-document"); });
    await act(async () => { await h.current.transfer("new-document"); h.current.close(); await h.current.select({ ...task, taskId: "other" }); });
    expect(h.writer.insert).toHaveBeenCalledOnce();
    expect(h.current.task?.taskId).toBe(task.taskId);
    await act(async () => { finish(); await pending; });
    act(() => h.tree.unmount());
  });

  it("does not write after the target lookup outlives an account change", async () => {
    const h = await setup();
    await act(async () => h.current.select(task));
    let finish!: (value: { documentId: string }) => void;
    h.writer.getContext.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = h.current.transfer("current-document"); });
    await act(async () => h.tree.update(<h.Harness apiKey="different" />));
    await act(async () => { finish({ documentId: "doc-7" }); await pending; });
    expect(h.writer.insert).not.toHaveBeenCalled();
    expect(h.current.hasAsset).toBe(false);
    act(() => h.tree.unmount());
  });

  it("ignores late downloads after cancellation", async () => {
    let finish!: (value: { task: CloudTaskRecord; asset: typeof asset }) => void;
    const recover = vi.fn(() => new Promise<{ task: CloudTaskRecord; asset: typeof asset }>((resolve) => { finish = resolve; }));
    const h = await setup({ recover });
    let pending!: Promise<void>;
    act(() => { pending = h.current.select(task); });
    act(() => h.current.close());
    await act(async () => { finish({ task, asset }); await pending; });
    expect(h.current.task).toBeNull();
    expect(h.current.hasAsset).toBe(false);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    act(() => h.tree.unmount());
  });

  it("saves cached original bytes and supports a cancelled file picker", async () => {
    const h = await setup();
    await act(async () => h.current.select(task));
    h.save.mockResolvedValueOnce(false);
    await act(async () => h.current.transfer("save"));
    expect(h.current.phase).toBe("ready");
    await act(async () => h.current.transfer("save"));
    expect(h.save).toHaveBeenLastCalledWith(asset);
    expect(h.writer.insert).not.toHaveBeenCalled();
    expect(h.recover).toHaveBeenCalledOnce();
    act(() => h.tree.unmount());
  });
});
