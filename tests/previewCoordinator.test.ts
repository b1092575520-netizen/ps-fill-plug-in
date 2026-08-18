import { describe, expect, it, vi } from "vitest";
import { PreviewCoordinator } from "../src/previewCoordinator";
import type { GeneratedImageAsset, PhotoshopPreviewSession } from "../src/backend/contracts";

const asset = (id: string): GeneratedImageAsset => ({
  id,
  bytes: new Uint8Array([1]),
  mimeType: "image/png",
});

describe("PreviewCoordinator", () => {
  it("keeps one Photoshop preview layer while switching 3 or 4 candidates", async () => {
    let nextLayer = 0;
    let liveLayers = 0;
    let maxLiveLayers = 0;
    const stage = vi.fn(async (): Promise<PhotoshopPreviewSession> => {
      liveLayers += 1;
      maxLiveLayers = Math.max(maxLiveLayers, liveLayers);
      return { documentId: "doc-a", layerIds: [`ps-fill-preview-${++nextLayer}`] };
    });
    const discard = vi.fn(async () => { liveLayers -= 1; });
    const coordinator = new PreviewCoordinator({ stage, discard });

    await coordinator.show("doc-a", asset("a"));
    await coordinator.show("doc-a", asset("b"));
    await coordinator.show("doc-a", asset("c"));
    await coordinator.show("doc-a", asset("d"));

    expect(maxLiveLayers).toBe(1);
    expect(coordinator.current("doc-a")?.assetId).toBe("d");
    expect(coordinator.current("doc-a")?.session.layerIds).toHaveLength(1);
  });

  it("coalesces rapid clicks to the newest candidate", async () => {
    const shown: string[] = [];
    const coordinator = new PreviewCoordinator({
      stage: async (_documentId, current) => {
        shown.push(current.id);
        return { documentId: "doc-a", layerIds: [`ps-fill-preview-${current.id}`] };
      },
      discard: async () => undefined,
    }, { throttleMs: 1 });

    await Promise.all([
      coordinator.show("doc-a", asset("a")),
      coordinator.show("doc-a", asset("b")),
      coordinator.show("doc-a", asset("c")),
    ]);

    expect(coordinator.current("doc-a")?.assetId).toBe("c");
    expect(shown.at(-1)).toBe("c");
  });

  it("discards on leave or close and commits only the current layer", async () => {
    const discard = vi.fn(async () => undefined);
    const commit = vi.fn(async () => undefined);
    const coordinator = new PreviewCoordinator({
      stage: async () => ({ documentId: "doc-a", layerIds: ["ps-fill-preview-a"] }),
      discard,
      commit,
    });
    await coordinator.show("doc-a", asset("a"));
    await coordinator.commit("doc-a");
    expect(commit).toHaveBeenCalledWith({ documentId: "doc-a", layerIds: ["ps-fill-preview-a"] });
    expect(coordinator.current("doc-a")).toBeNull();

    await coordinator.show("doc-a", asset("b"));
    await coordinator.discard("doc-a");
    expect(discard).toHaveBeenCalledTimes(1);
    expect(coordinator.current("doc-a")).toBeNull();
  });
});
