import { describe, expect, it, vi } from "vitest";
import { PhotoshopGateway } from "../src/backend/photoshopGateway";
import { UxpPhotoshopRuntime } from "../src/backend/runtime";
import { AssetLifecycleManager } from "../src/assetLifecycleManager";

const assets = [
  { id: "one", bytes: new Uint8Array([1]), mimeType: "image/png" },
  { id: "two", bytes: new Uint8Array([2]), mimeType: "image/png" },
];

function decodeStoredGrayscalePng(png: Uint8Array) {
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const readUint32 = (offset: number) => (
    (png[offset] * 0x1000000)
    + (png[offset + 1] << 16)
    + (png[offset + 2] << 8)
    + png[offset + 3]
  ) >>> 0;
  const width = readUint32(16);
  const height = readUint32(20);
  let offset = 8;
  let idat = new Uint8Array();
  while (offset < png.length) {
    const length = readUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === "IDAT") {
      const next = new Uint8Array(idat.length + length);
      next.set(idat);
      next.set(png.subarray(offset + 8, offset + 8 + length), idat.length);
      idat = next;
    }
    offset += 12 + length;
  }
  const inflated: number[] = [];
  let cursor = 2;
  while (cursor < idat.length - 4) {
    const final = idat[cursor] & 1;
    const length = idat[cursor + 1] | (idat[cursor + 2] << 8);
    const inverse = idat[cursor + 3] | (idat[cursor + 4] << 8);
    expect((length ^ inverse) & 0xffff).toBe(0xffff);
    inflated.push(...idat.subarray(cursor + 5, cursor + 5 + length));
    cursor += 5 + length;
    if (final) break;
  }
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    expect(inflated[y * (width + 1)]).toBe(0);
    pixels.set(
      inflated.slice(y * (width + 1) + 1, (y + 1) * (width + 1)),
      y * width,
    );
  }
  return { width, height, pixels };
}

describe("PhotoshopGateway", () => {
  it("ignores selection channels that do not carry the plugin owner prefix", async () => {
    const runtime = {
      executeAsModal: vi.fn(async (operation: () => Promise<void>) => operation()),
      cleanupSelectionChannel: vi.fn(async () => undefined),
    };
    const gateway = new PhotoshopGateway(runtime as any);

    await gateway.cleanupSelectionChannel("doc-7", "用户蒙版");

    expect(runtime.executeAsModal).not.toHaveBeenCalled();
    expect(runtime.cleanupSelectionChannel).not.toHaveBeenCalled();
  });

  it("cleans an owned selection channel inside a Photoshop modal", async () => {
    const runtime = {
      executeAsModal: vi.fn(async (operation: () => Promise<void>) => operation()),
      cleanupSelectionChannel: vi.fn(async () => undefined),
    };
    const gateway = new PhotoshopGateway(runtime as any);

    await gateway.cleanupSelectionChannel("doc-7", "ps-fill-selection-123");

    expect(runtime.executeAsModal).toHaveBeenCalledOnce();
    expect(runtime.cleanupSelectionChannel).toHaveBeenCalledWith(
      "doc-7",
      "ps-fill-selection-123",
    );
  });

  it("startup residual cleanup deletes only plugin-prefixed temporary entries", async () => {
    const owned = { name: "ps-fill-generated-123-0.png", delete: vi.fn(async () => undefined) };
    const lockedOwned = { name: "ps-fill-selection-locked.png", delete: vi.fn(async () => { throw new Error("locked"); }) };
    const userFile = { name: "portrait.png", delete: vi.fn(async () => undefined) };
    const similarFile = { name: "ps-filler-not-owned.png", delete: vi.fn(async () => undefined) };
    const folder = { getEntries: vi.fn(async () => [owned, lockedOwned, userFile, similarFile]) };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop"
        ? { app: { documents: [] } }
        : { storage: { localFileSystem: { getTemporaryFolder: vi.fn(async () => folder) } } }
    ));

    await expect(runtime.cleanupPluginResiduals()).resolves.toBeUndefined();

    expect(owned.delete).toHaveBeenCalledOnce();
    expect(lockedOwned.delete).toHaveBeenCalledOnce();
    expect(userFile.delete).not.toHaveBeenCalled();
    expect(similarFile.delete).not.toHaveBeenCalled();
  });

  it("registers temporary files by owner and cleans one document without touching another", async () => {
    const manager = new AssetLifecycleManager();
    const files = new Map<string, { name: string; read: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }>();
    const createFile = vi.fn(async (name: string) => {
      const file = {
        name,
        read: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
        delete: vi.fn(async () => undefined),
      };
      files.set(name, file);
      return file;
    });
    const makeDocument = (id: number) => ({
      id,
      width: 100,
      height: 80,
      duplicate: vi.fn(async () => ({
        flatten: vi.fn(async () => undefined),
        saveAs: { jpg: vi.fn(async () => undefined) },
        closeWithoutSaving: vi.fn(async () => undefined),
      })),
    });
    const documents = [makeDocument(7), makeDocument(8)];
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop"
        ? { app: { documents, activeDocument: documents[0] } }
        : {
            storage: {
              formats: { binary: "binary" },
              localFileSystem: {
                getTemporaryFolder: vi.fn(async () => ({ createFile })),
              },
            },
          }
    ), manager);
    const ownerA = { documentId: "7", jobId: "job-a", revision: 1, ownerPrefix: "ps-fill" };
    const ownerB = { documentId: "8", jobId: "job-b", revision: 1, ownerPrefix: "ps-fill" };

    await runtime.captureVisibleComposite("document", "7", ownerA);
    await runtime.captureVisibleComposite("document", "8", ownerB);
    expect(manager.stats("7").temporaryFiles).toBe(1);
    expect(manager.stats("8").temporaryFiles).toBe(1);

    await runtime.cleanupTemporaryFiles(ownerA);

    expect(manager.stats("7").temporaryFiles).toBe(0);
    expect(manager.stats("8").temporaryFiles).toBe(1);
    const [fileA, fileB] = Array.from(files.values());
    expect(fileA.delete).toHaveBeenCalledOnce();
    expect(fileB.delete).not.toHaveBeenCalled();
  });

  it("enumerates open document IDs without using document names", async () => {
    const documents = [{ id: 11 }, { id: 12 }];
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop"
        ? { app: { documents, activeDocument: documents[1] } }
        : { storage: {} }
    ));

    await expect(runtime.getOpenDocumentIds()).resolves.toEqual(["11", "12"]);
  });

  it("does not fabricate a closed-document list when the host cannot enumerate documents", async () => {
    const runtime = {
      getContext: vi.fn(async () => ({ documentId: "doc-active" })),
      executeAsModal: vi.fn(async (operation: () => Promise<void>) => operation()),
      captureVisibleComposite: vi.fn(),
      captureInpaintSnapshot: vi.fn(),
      insertIntoCurrentDocument: vi.fn(),
      createDocumentFromImages: vi.fn(),
      setPreviewLayer: vi.fn(),
      discardPreviewLayers: vi.fn(),
      cleanupTemporaryFiles: vi.fn(async () => undefined),
    };
    const gateway = new PhotoshopGateway(runtime);

    await expect(gateway.getOpenDocumentIds()).resolves.toBeNull();
  });

  it("treats an empty document collection with an active document as an unknown read", async () => {
    const active = { id: 7 };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop"
        ? { app: { documents: [], activeDocument: active } }
        : { storage: {} }
    ));

    await expect(runtime.getOpenDocumentIds()).resolves.toBeNull();
  });

  it("uses a modal operation for current-document named layers", async () => {
    const runtime = {
      getContext: vi.fn(async () => ({ documentId: "doc-7" })),
      executeAsModal: vi.fn(async (operation: () => Promise<void>) => operation()),
      captureVisibleComposite: vi.fn(),
      insertIntoCurrentDocument: vi.fn(async () => ["layer-1", "layer-2"]),
      createDocumentFromImages: vi.fn(async () => undefined),
      cleanupTemporaryFiles: vi.fn(async () => undefined),
    };
    const gateway = new PhotoshopGateway(runtime);
    const selection = { x: 1, y: 2, width: 3, height: 4 };
    await gateway.insert(assets, "current-document", "doc-7", selection);
    expect(runtime.executeAsModal).toHaveBeenCalledOnce();
    expect(runtime.insertIntoCurrentDocument).toHaveBeenCalledWith(assets, "doc-7", selection);
    expect(runtime.cleanupTemporaryFiles).toHaveBeenCalledOnce();
  });

  it("stages multiple candidates and switches the visible Photoshop layer", async () => {
    const runtime = {
      getContext: vi.fn(async () => ({ documentId: "doc-7" })),
      executeAsModal: vi.fn(async (operation: () => Promise<void>) => operation()),
      captureVisibleComposite: vi.fn(),
      insertIntoCurrentDocument: vi.fn(async () => ["layer-1", "layer-2"]),
      createDocumentFromImages: vi.fn(),
      setPreviewLayer: vi.fn(async () => undefined),
      discardPreviewLayers: vi.fn(async () => undefined),
      cleanupTemporaryFiles: vi.fn(async () => undefined),
    };
    const gateway = new PhotoshopGateway(runtime);

    const session = await gateway.insert(assets, "current-document", "doc-7");
    await gateway.preview(session, "layer-2");
    await gateway.discardPreview(session, "layer-2");

    expect(session).toEqual({
      documentId: "doc-7",
      layerIds: ["layer-1", "layer-2"],
    });
    expect(runtime.setPreviewLayer).toHaveBeenCalledWith(
      "doc-7",
      ["layer-1", "layer-2"],
      "layer-2",
    );
    expect(runtime.discardPreviewLayers).toHaveBeenCalledWith(
      "doc-7",
      ["layer-1", "layer-2"],
      "layer-2",
    );
  });

  it("returns the newly created document ID for an explicit new-document insert", async () => {
    const runtime = {
      getContext: vi.fn(async () => ({ documentId: "generated-doc" })),
      executeAsModal: vi.fn(async (operation: () => Promise<void>) => operation()),
      captureVisibleComposite: vi.fn(),
      insertIntoCurrentDocument: vi.fn(),
      createDocumentFromImages: vi.fn(async () => ["generated-layer"]),
      cleanupTemporaryFiles: vi.fn(async () => undefined),
    };
    const gateway = new PhotoshopGateway(runtime);

    await expect(gateway.insert(assets.slice(0, 1), "new-document", "source-doc"))
      .resolves.toEqual({ documentId: "generated-doc", layerIds: ["generated-layer"] });
    expect(runtime.createDocumentFromImages).toHaveBeenCalledOnce();
    expect(runtime.executeAsModal).not.toHaveBeenCalled();
  });

  it("serializes preview modal operations so returning during staging cannot overlap Photoshop modals", async () => {
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let activeModals = 0;
    let maximumActiveModals = 0;
    const runtime = {
      getContext: vi.fn(async () => ({ documentId: "doc-7" })),
      executeAsModal: vi.fn(async (operation: () => Promise<void>) => {
        activeModals += 1;
        maximumActiveModals = Math.max(maximumActiveModals, activeModals);
        try {
          await operation();
        } finally {
          activeModals -= 1;
        }
      }),
      captureVisibleComposite: vi.fn(),
      insertIntoCurrentDocument: vi.fn(),
      createDocumentFromImages: vi.fn(),
      setPreviewLayer: vi.fn(async () => firstDone),
      discardPreviewLayers: vi.fn(async () => undefined),
      cleanupTemporaryFiles: vi.fn(async () => undefined),
    };
    const gateway = new PhotoshopGateway(runtime);
    const session = { documentId: "doc-7", layerIds: ["layer-1", "layer-2"] };

    const preview = gateway.preview(session, "layer-1");
    const discard = gateway.discardPreview(session);
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.executeAsModal).toHaveBeenCalledOnce();
    expect(maximumActiveModals).toBe(1);

    releaseFirst();
    await Promise.all([preview, discard]);
    expect(runtime.executeAsModal).toHaveBeenCalledTimes(2);
  });

  it("cleans temporary files after new-document failure", async () => {
    const runtime = {
      getContext: vi.fn(),
      executeAsModal: vi.fn(async (operation: () => Promise<void>) => operation()),
      captureVisibleComposite: vi.fn(),
      insertIntoCurrentDocument: vi.fn(),
      createDocumentFromImages: vi.fn(async () => { throw new Error("failed"); }),
      cleanupTemporaryFiles: vi.fn(async () => undefined),
    };
    const gateway = new PhotoshopGateway(runtime);
    await expect(gateway.insert(assets, "new-document")).rejects.toThrow("failed");
    expect(runtime.cleanupTemporaryFiles).toHaveBeenCalledOnce();
  });

  it("captures a visible selection in a short modal operation and cleans its file", async () => {
    const capture = {
      bytes: new Uint8Array([1, 2]),
      mimeType: "image/png",
      fileName: "selection.png",
    };
    const runtime = {
      getContext: vi.fn(),
      executeAsModal: vi.fn(async (operation: () => Promise<void>) => operation()),
      captureVisibleComposite: vi.fn(async () => capture),
      insertIntoCurrentDocument: vi.fn(),
      createDocumentFromImages: vi.fn(),
      cleanupTemporaryFiles: vi.fn(async () => undefined),
    };
    const gateway = new PhotoshopGateway(runtime);
    await expect(gateway.captureReference("selection", "doc-7")).resolves.toBe(capture);
    expect(runtime.captureVisibleComposite).toHaveBeenCalledWith("selection", "doc-7");
    expect(runtime.executeAsModal).toHaveBeenCalledOnce();
    expect(runtime.cleanupTemporaryFiles).toHaveBeenCalledOnce();
  });

  it("shrinks a large document reference and exports it as a high-quality JPEG", async () => {
    const file = {
      read: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
      delete: vi.fn(async () => undefined),
    };
    const duplicate = {
      resizeImage: vi.fn(async () => undefined),
      flatten: vi.fn(async () => undefined),
      saveAs: {
        jpg: vi.fn(async () => undefined),
        png: vi.fn(async () => undefined),
      },
      closeWithoutSaving: vi.fn(async () => undefined),
    };
    const document = {
      id: 7,
      width: 6000,
      height: 4000,
      duplicate: vi.fn(async () => duplicate),
    };
    const createFile = vi.fn(async () => file);
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop"
        ? { app: { documents: [document], activeDocument: document } }
        : {
            storage: {
              formats: { binary: "binary" },
              localFileSystem: {
                getTemporaryFolder: vi.fn(async () => ({ createFile })),
              },
            },
          }
    ));

    const capture = await runtime.captureVisibleComposite("document", "7");

    expect(duplicate.resizeImage).toHaveBeenCalledWith(3072, 2048);
    expect(duplicate.saveAs.jpg).toHaveBeenCalledWith(file, { quality: 9 }, true);
    expect(duplicate.saveAs.png).not.toHaveBeenCalled();
    expect(createFile).toHaveBeenCalledWith(
      expect.stringMatching(/^ps-fill-document-\d+\.jpg$/),
      { overwrite: true },
    );
    expect(capture).toMatchObject({ mimeType: "image/jpeg" });
    expect(capture.fileName).toMatch(/^ps-fill-document-\d+\.jpg$/);
    expect(duplicate.closeWithoutSaving).toHaveBeenCalledOnce();
  });

  it("keeps a small document reference at native size while exporting JPEG", async () => {
    const file = {
      read: vi.fn(async () => new Uint8Array([1]).buffer),
      delete: vi.fn(async () => undefined),
    };
    const duplicate = {
      resizeImage: vi.fn(async () => undefined),
      flatten: vi.fn(async () => undefined),
      saveAs: { jpg: vi.fn(async () => undefined), png: vi.fn(async () => undefined) },
      closeWithoutSaving: vi.fn(async () => undefined),
    };
    const document = {
      id: 8,
      width: 2400,
      height: 1600,
      duplicate: vi.fn(async () => duplicate),
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop"
        ? { app: { documents: [document], activeDocument: document } }
        : {
            storage: {
              formats: { binary: "binary" },
              localFileSystem: {
                getTemporaryFolder: vi.fn(async () => ({
                  createFile: vi.fn(async () => file),
                })),
              },
            },
          }
    ));

    const capture = await runtime.captureVisibleComposite("document", "8");

    expect(duplicate.resizeImage).not.toHaveBeenCalled();
    expect(duplicate.saveAs.jpg).toHaveBeenCalledWith(file, { quality: 9 }, true);
    expect(capture).toMatchObject({ mimeType: "image/jpeg" });
  });

  it("reduces an oversized JPEG reference again before returning it for upload", async () => {
    const oversized = new Uint8Array(1_800_001).buffer;
    const reduced = new Uint8Array([1, 2, 3]).buffer;
    const file = {
      read: vi.fn()
        .mockResolvedValueOnce(oversized)
        .mockResolvedValueOnce(reduced),
      delete: vi.fn(async () => undefined),
    };
    const duplicate = {
      resizeImage: vi.fn(async () => undefined),
      flatten: vi.fn(async () => undefined),
      saveAs: { jpg: vi.fn(async () => undefined), png: vi.fn(async () => undefined) },
      closeWithoutSaving: vi.fn(async () => undefined),
    };
    const document = {
      id: 10,
      width: 6000,
      height: 4000,
      duplicate: vi.fn(async () => duplicate),
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop"
        ? { app: { documents: [document], activeDocument: document } }
        : {
            storage: {
              formats: { binary: "binary" },
              localFileSystem: {
                getTemporaryFolder: vi.fn(async () => ({
                  createFile: vi.fn(async () => file),
                })),
              },
            },
          }
    ));

    const capture = await runtime.captureVisibleComposite("document", "10");

    expect(duplicate.resizeImage).toHaveBeenNthCalledWith(1, 3072, 2048);
    expect(duplicate.resizeImage).toHaveBeenNthCalledWith(2, 2048, 1365);
    expect(duplicate.saveAs.jpg).toHaveBeenNthCalledWith(1, file, { quality: 9 }, true);
    expect(duplicate.saveAs.jpg).toHaveBeenNthCalledWith(2, file, { quality: 8 }, true);
    expect(file.read).toHaveBeenCalledTimes(2);
    expect(capture.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("keeps selection references lossless PNG", async () => {
    const file = {
      read: vi.fn(async () => new Uint8Array([1]).buffer),
      delete: vi.fn(async () => undefined),
    };
    const duplicate = {
      crop: vi.fn(async () => undefined),
      resizeImage: vi.fn(async () => undefined),
      flatten: vi.fn(async () => undefined),
      saveAs: { jpg: vi.fn(async () => undefined), png: vi.fn(async () => undefined) },
      closeWithoutSaving: vi.fn(async () => undefined),
    };
    const document = {
      id: 9,
      width: 6000,
      height: 4000,
      selection: { bounds: { left: 10, top: 20, right: 110, bottom: 220 } },
      duplicate: vi.fn(async () => duplicate),
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop"
        ? { app: { documents: [document], activeDocument: document } }
        : {
            storage: {
              formats: { binary: "binary" },
              localFileSystem: {
                getTemporaryFolder: vi.fn(async () => ({
                  createFile: vi.fn(async () => file),
                })),
              },
            },
          }
    ));

    const capture = await runtime.captureVisibleComposite("selection", "9");

    expect(duplicate.resizeImage).not.toHaveBeenCalled();
    expect(duplicate.saveAs.png).toHaveBeenCalledWith(
      file,
      { compression: 6, interlaced: false },
      true,
    );
    expect(duplicate.saveAs.jpg).not.toHaveBeenCalled();
    expect(capture.fileName).toMatch(/^ps-fill-selection-\d+\.png$/);
    expect(capture.mimeType).toBe("image/png");
  });

  it("keeps the opened image as the only layer in a new document", async () => {
    const operationOrder: string[] = [];
    const originalBackground = {
      id: 42,
      name: "背景",
      visible: false,
      delete: vi.fn(async () => undefined),
    };
    const document = {
      activeLayers: [originalBackground],
      layers: [originalBackground],
      createLayerGroup: vi.fn(),
    };
    const file = {
      write: vi.fn(async () => { operationOrder.push("write"); }),
      delete: vi.fn(async () => undefined),
    };
    const photoshop = {
      app: { open: vi.fn(async () => { operationOrder.push("open"); return document; }) },
      action: { batchPlay: vi.fn() },
      core: {
        executeAsModal: vi.fn(async (operation: () => Promise<void>) => {
          operationOrder.push("modal");
          return operation();
        }),
      },
      constants: { ElementPlacement: { PLACEINSIDE: "inside" } },
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({
            createFile: vi.fn(async () => file),
          })),
          createSessionToken: vi.fn(() => "token"),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    await runtime.createDocumentFromImages([{ ...assets[0], layerName: "黑色小狗" }]);

    expect(operationOrder).toEqual(["write", "modal", "open"]);
    expect(document.createLayerGroup).not.toHaveBeenCalled();
    expect(photoshop.action.batchPlay).toHaveBeenCalledWith(
      [expect.objectContaining({
        _obj: "set",
        _target: [{ _ref: "layer", _id: 42 }],
        to: expect.objectContaining({ _obj: "layer", name: "黑色小狗" }),
      })],
      expect.objectContaining({ synchronousExecution: true }),
    );
    expect(originalBackground.visible).toBe(true);
    expect(originalBackground.delete).not.toHaveBeenCalled();
  });

  it("closes a partially created document when new-document insertion fails", async () => {
    const background = { id: 42, visible: false };
    const document = {
      activeLayers: [background],
      layers: [background],
      closeWithoutSaving: vi.fn(async () => undefined),
    };
    const file = {
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const photoshop = {
      app: { open: vi.fn(async () => document) },
      action: { batchPlay: vi.fn(async () => { throw new Error("rename failed"); }) },
      core: { executeAsModal: vi.fn(async (operation: () => Promise<void>) => operation()) },
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({
            createFile: vi.fn(async () => file),
          })),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    await expect(runtime.createDocumentFromImages([assets[0]])).rejects.toThrow("rename failed");
    expect(document.closeWithoutSaving).toHaveBeenCalledOnce();
  });

  it("places generated images directly into the current document without a group", async () => {
    const placedLayer = {
      id: 42,
      name: "",
      visible: false,
      move: vi.fn(),
    };
    const document = {
      id: 7,
      activeLayers: [placedLayer],
      layers: [] as typeof placedLayer[],
      createLayerGroup: vi.fn(),
    };
    const file = {
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const photoshop = {
      app: { documents: [document], activeDocument: document },
      action: {
        batchPlay: vi.fn(async (descriptors: Array<{ _obj?: string }>) => {
          if (descriptors[0]?._obj === "placeEvent") document.layers.push(placedLayer);
          if (descriptors[0]?._obj === "get") return [{ layerID: placedLayer.id }];
        }),
      },
      constants: { ElementPlacement: { PLACEINSIDE: "inside" } },
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({
            createFile: vi.fn(async () => file),
          })),
          createSessionToken: vi.fn(() => "token"),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    await runtime.insertIntoCurrentDocument([{ ...assets[0], layerName: "白色小花" }], "7");

    expect(document.createLayerGroup).not.toHaveBeenCalled();
    expect(placedLayer.move).not.toHaveBeenCalled();
    expect(placedLayer.name).toBe("白色小花");
    expect(placedLayer.visible).toBe(true);
  });

  it("uses the placed layer id instead of a stale activeLayers cache", async () => {
    const staleLayer = { id: 41, name: "existing", visible: true };
    const placedLayer = { id: 42, name: "", visible: false };
    const document = {
      id: 7,
      activeLayers: [staleLayer],
      layers: [staleLayer],
    };
    const file = {
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const batchPlay = vi.fn(async (descriptors: Array<{ _obj?: string }>) => {
      if (descriptors[0]?._obj === "placeEvent") document.layers.push(placedLayer);
      return descriptors[0]?._obj === "get" ? [{ layerID: 42 }] : undefined;
    });
    const photoshop = {
      app: { documents: [document], activeDocument: document },
      action: { batchPlay },
      constants: { AnchorPosition: { TOPLEFT: "top-left" } },
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({
            createFile: vi.fn(async () => file),
          })),
          createSessionToken: vi.fn(() => "token"),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    await runtime.insertIntoCurrentDocument(
      [{ ...assets[0], layerName: "候选一" }],
      "7",
    );

    expect(staleLayer.name).toBe("existing");
    expect(placedLayer.name).toBe("候选一");
    expect(placedLayer.visible).toBe(true);
  });

  it("never claims a user layer omitted from the pre-place DOM snapshot", async () => {
    const originalLayer = { id: 2, name: "图层 1", visible: true };
    const userLayer = { id: 3, name: "Acceptance edit during generation", visible: true };
    const placedLayer = { id: 4, name: "", visible: false };
    const anchorLayer = { id: 99, name: "ps-fill-place-anchor", visible: true };
    const document = {
      id: 84,
      activeLayers: [userLayer],
      layers: [userLayer, originalLayer] as Array<typeof originalLayer>,
    };
    const file = {
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const batchPlay = vi.fn(async (descriptors: Array<{ _obj?: string }>) => {
      if (descriptors[0]?._obj === "make") {
        document.activeLayers = [anchorLayer];
        document.layers = [anchorLayer, userLayer, originalLayer];
        return [{ layerID: anchorLayer.id }];
      }
      if (descriptors[0]?._obj === "placeEvent") {
        const replacedId = document.activeLayers[0]?.id;
        document.layers = [placedLayer, ...document.layers.filter((layer) => layer.id !== replacedId)];
        document.activeLayers = [placedLayer];
        return [{ ID: placedLayer.id }];
      }
      return descriptors[0]?._obj === "get"
        ? [{ layerID: document.activeLayers[0]?.id }]
        : undefined;
    });
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop"
        ? {
            app: { documents: [document], activeDocument: document },
            action: { batchPlay },
          }
        : {
            storage: {
              formats: { binary: "binary" },
              localFileSystem: {
                getTemporaryFolder: vi.fn(async () => ({
                  createFile: vi.fn(async () => file),
                })),
                createSessionToken: vi.fn(() => "token"),
              },
            },
          }
    ));

    await runtime.insertIntoCurrentDocument(
      [{ ...assets[0], layerName: "候选预览" }],
      "84",
    );

    expect(userLayer.name).toBe("Acceptance edit during generation");
    expect(document.layers.map((layer) => layer.id)).toContain(userLayer.id);
    expect(placedLayer.name).toBe("候选预览");
  });

  it("aligns every candidate to the same crop bounds when activeLayers stays stale", async () => {
    type MutableBounds = { left: number; top: number; right: number; bottom: number };
    const makeLayer = (id: number) => {
      const state: MutableBounds = { left: 0, top: 589, right: 4410, bottom: 3997 };
      const layer = {
        id,
        name: "",
        visible: true,
        state,
        scale: vi.fn(async (horizontal: number, vertical: number) => {
          const width = state.right - state.left;
          const height = state.bottom - state.top;
          state.right = state.left + width * horizontal / 100;
          state.bottom = state.top + height * vertical / 100;
        }),
        translate: vi.fn(async (x: number, y: number) => {
          state.left += x;
          state.right += x;
          state.top += y;
          state.bottom += y;
        }),
      };
      return layer;
    };
    const layers = [makeLayer(101), makeLayer(102), makeLayer(103)];
    const staleLayer = { id: 99, name: "existing", visible: true };
    const selectionChannel = {
      name: "Klein Selection 123",
      remove: vi.fn(async () => undefined),
    };
    const document = {
      id: 7,
      width: 2672,
      height: 3453,
      activeLayers: [staleLayer],
      layers: [staleLayer] as any[],
      channels: [selectionChannel],
      selection: {
        bounds: null,
        load: vi.fn(async () => undefined),
        deselect: vi.fn(async () => undefined),
      },
      title: "1M9A3574.psd",
    };
    let placedIndex = -1;
    let activeLayerId = staleLayer.id;
    const batchPlay = vi.fn(async (descriptors: Array<{
      _obj?: string;
      _target?: Array<{ _id?: number; _enum?: string }>;
    }>) => {
      const descriptor = descriptors[0];
      if (descriptor?._obj === "make") {
        activeLayerId = 1000 + placedIndex + 1;
        return [{ layerID: activeLayerId }];
      }
      if (descriptor?._obj === "placeEvent") {
        placedIndex += 1;
        document.layers.push(layers[placedIndex]);
        activeLayerId = layers[placedIndex].id;
        return [{ ID: activeLayerId }];
      }
      if (descriptor?._obj !== "get") return undefined;
      const target = descriptor._target?.[0];
      if (target?._enum === "ordinal") return [{ layerID: activeLayerId }];
      const layer = layers.find((item) => item.id === target?._id);
      if (!layer) return undefined;
      const { left, top, right, bottom } = layer.state;
      return [{
        bounds: {
          left: { _unit: "pixelsUnit", _value: left },
          top: { _unit: "pixelsUnit", _value: top },
          right: { _unit: "pixelsUnit", _value: right },
          bottom: { _unit: "pixelsUnit", _value: bottom },
        },
      }];
    });
    const photoshop = {
      app: { documents: [document], activeDocument: document },
      action: { batchPlay },
      constants: { AnchorPosition: { TOPLEFT: "top-left" } },
    };
    const file = {
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({
            createFile: vi.fn(async () => file),
          })),
          createSessionToken: vi.fn(() => "token"),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));
    const snapshot = {
      documentId: "7",
      documentWidth: 2672,
      documentHeight: 3453,
      selectionBounds: { x: 695, y: 1851, width: 1116, height: 609 },
      cropBounds: { x: 151, y: 1301, width: 2205, height: 1704 },
      targetWidth: 2205,
      targetHeight: 1704,
      contextBytes: new Uint8Array([1]),
      maskBytes: new Uint8Array(),
      selectionChannelName: "Klein Selection 123",
      mimeType: "image/png" as const,
    };

    await runtime.insertIntoCurrentDocument(
      [
        { ...assets[0], id: "one" },
        { ...assets[0], id: "two" },
        { ...assets[0], id: "three" },
      ],
      "7",
      snapshot,
    );

    for (const layer of layers) {
      expect(layer.state.left).toBeCloseTo(151, 5);
      expect(layer.state.top).toBeCloseTo(1301, 5);
      expect(layer.state.right).toBeCloseTo(2356, 5);
      expect(layer.state.bottom).toBeCloseTo(3005, 5);
      expect(layer.scale).toHaveBeenCalledOnce();
    }
    expect(layers[0].visible).toBe(true);
    expect(layers[1].visible).toBe(false);
    expect(layers[2].visible).toBe(false);
    expect(batchPlay.mock.calls
      .flatMap((call) => call[0])
      .some((descriptor) => descriptor._obj === "set"
        && descriptor.to?.userMaskFeather)).toBe(false);
  });

  it("refuses to write into another active document when the launch document was closed", async () => {
    const activeDocument = { id: 99, activeLayers: [] };
    const photoshop = {
      app: { documents: [activeDocument], activeDocument },
      action: { batchPlay: vi.fn(async () => undefined) },
      constants: { AnchorPosition: { TOPLEFT: "top-left" } },
    };
    const getTemporaryFolder = vi.fn();
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder,
          createSessionToken: vi.fn(),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    await expect(runtime.insertIntoCurrentDocument(assets, "launch-doc"))
      .rejects.toThrow("生成任务对应的 Photoshop 文档已关闭");
    expect(photoshop.action.batchPlay).not.toHaveBeenCalled();
    expect(getTemporaryFolder).not.toHaveBeenCalled();
  });

  it("refuses to write when the user switched to another still-open document", async () => {
    const launchDocument = { id: 7, activeLayers: [] };
    const activeDocument = { id: 99, activeLayers: [] };
    const photoshop = {
      app: { documents: [launchDocument, activeDocument], activeDocument },
      action: { batchPlay: vi.fn(async () => undefined) },
      constants: { AnchorPosition: { TOPLEFT: "top-left" } },
    };
    const getTemporaryFolder = vi.fn();
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder,
          createSessionToken: vi.fn(),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    await expect(runtime.insertIntoCurrentDocument(assets, "7"))
      .rejects.toThrow("生成期间 Photoshop 当前文档已切换，已拒绝写入");
    expect(photoshop.action.batchPlay).not.toHaveBeenCalled();
    expect(getTemporaryFolder).not.toHaveBeenCalled();
  });

  it("refuses an inpaint write when the launch document dimensions changed", async () => {
    const document = { id: 7, width: 1001, height: 800, activeLayers: [] };
    const photoshop = {
      app: { documents: [document], activeDocument: document },
      action: { batchPlay: vi.fn(async () => undefined) },
      constants: { AnchorPosition: { TOPLEFT: "top-left" } },
    };
    const getTemporaryFolder = vi.fn();
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder,
          createSessionToken: vi.fn(),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    await expect(runtime.insertIntoCurrentDocument(
      [assets[0]],
      "7",
      {
        documentId: "7",
        documentWidth: 1000,
        documentHeight: 800,
        selectionBounds: { x: 10, y: 20, width: 30, height: 40 },
        cropBounds: { x: 0, y: 0, width: 100, height: 100 },
        targetWidth: 512,
        targetHeight: 512,
        contextBytes: new Uint8Array([1]),
        maskBytes: new Uint8Array([0, 255, 0]),
        mimeType: "image/png",
      },
    )).rejects.toThrow("生成期间 Photoshop 文档尺寸已变化，已拒绝写入");
    expect(photoshop.action.batchPlay).not.toHaveBeenCalled();
    expect(getTemporaryFolder).not.toHaveBeenCalled();
  });

  it("builds an arbitrary-shape grayscale mask without the unavailable user-mask command", async () => {
    let source: any;
    const sourceSelection = {
      bounds: { left: 200, top: 250, right: 300, bottom: 330 },
      save: vi.fn(async (name: string) => {
        source.channels = [{ name, remove: vi.fn(async () => undefined) }];
      }),
    };
    const contextDuplicate = {
      id: 8,
      crop: vi.fn(async () => undefined),
      flatten: vi.fn(async () => undefined),
      saveAs: { png: vi.fn(async () => undefined) },
      closeWithoutSaving: vi.fn(async () => undefined),
    };
    source = {
      id: 7,
      width: 1000,
      height: 800,
      selection: sourceSelection,
      channels: [] as Array<{ name: string; remove: () => Promise<void> }>,
      duplicate: vi.fn().mockResolvedValueOnce(contextDuplicate),
    };
    const contextFile = {
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
      delete: vi.fn(async () => undefined),
    };
    let fileIndex = 0;
    const batchPlay = vi.fn(async () => undefined);
    const imageData = {
      width: 100,
      height: 80,
      getData: vi.fn(async () => {
        const data = new Uint8Array(100 * 80);
        data[0] = 255;
        return data;
      }),
      dispose: vi.fn(),
    };
    const photoshop = {
      app: { documents: [source], activeDocument: source },
      imaging: {
        getSelection: vi.fn(async () => ({
          imageData,
          sourceBounds: { left: 200, top: 250, right: 300, bottom: 330 },
        })),
      },
      action: { batchPlay },
      constants: { AnchorPosition: { TOPLEFT: "top-left" } },
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({
            createFile: vi.fn(async () => (fileIndex++ === 0 ? contextFile : undefined)),
          })),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    const snapshot = await runtime.captureInpaintSnapshot("7", "klein-4b");

    expect(snapshot.selectionBounds).toEqual({ x: 200, y: 250, width: 100, height: 80 });
    expect(snapshot.maskBytes).toEqual(new Uint8Array());
    expect(source.duplicate).toHaveBeenCalledOnce();
    expect(imageData.dispose).toHaveBeenCalledOnce();
    expect(batchPlay).not.toHaveBeenCalled();
    expect(batchPlay).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ _obj: "inverse" }),
        expect.objectContaining({ _obj: "clear" }),
        expect.objectContaining({ _obj: "fill" }),
      ]),
      expect.anything(),
    );
  });

  it("snapshots the selection through a native alpha channel without temporary mask commands", async () => {
    const sourceSelection = {
      bounds: { left: 200, top: 250, right: 300, bottom: 330 },
      save: vi.fn(async () => undefined),
    };
    const contextDuplicate = {
      id: 8,
      crop: vi.fn(async () => undefined),
      flatten: vi.fn(async () => undefined),
      saveAs: { png: vi.fn(async () => undefined) },
      closeWithoutSaving: vi.fn(async () => undefined),
    };
    const channel = { name: "", remove: vi.fn(async () => undefined) };
    sourceSelection.save.mockImplementationOnce(async (name: string) => {
      channel.name = name;
    });
    const source = {
      id: 7,
      width: 1000,
      height: 800,
      selection: sourceSelection,
      channels: [channel],
      duplicate: vi.fn().mockResolvedValue(contextDuplicate),
    };
    const contextFile = {
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
      delete: vi.fn(async () => undefined),
    };
    const createFile = vi.fn(async () => contextFile);
    const batchPlay = vi.fn(async () => undefined);
    const photoshop = {
      app: { documents: [source], activeDocument: source },
      action: { batchPlay },
      constants: { AnchorPosition: { TOPLEFT: "top-left" } },
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({ createFile })),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    const snapshot = await runtime.captureInpaintSnapshot("7", "klein-4b");

    expect(sourceSelection.save).toHaveBeenCalledWith(expect.stringMatching(/^ps-fill-selection-\d+$/));
    expect(createFile).toHaveBeenCalledOnce();
    expect(source.duplicate).toHaveBeenCalledOnce();
    expect(batchPlay).not.toHaveBeenCalled();
    expect(snapshot.selectionChannelName).toMatch(/^ps-fill-selection-\d+$/);
  });

  it("exports the exact selection pixels for the local model mask", async () => {
    let source: any;
    const sourceSelection = {
      bounds: { left: 400, top: 300, right: 404, bottom: 304 },
      save: vi.fn(async (name: string) => {
        source.channels.push({ name, remove: vi.fn(async () => undefined) });
      }),
    };
    const contextDuplicate = {
      crop: vi.fn(async () => undefined),
      flatten: vi.fn(async () => undefined),
      saveAs: { png: vi.fn(async () => undefined) },
      closeWithoutSaving: vi.fn(async () => undefined),
    };
    source = {
      id: 7,
      width: 1000,
      height: 800,
      selection: sourceSelection,
      channels: [],
      duplicate: vi.fn(async () => contextDuplicate),
    };
    const file = {
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
      delete: vi.fn(async () => undefined),
    };
    const imageData = {
      width: 4,
      height: 4,
      getData: vi.fn(async () => new Uint8Array([
        0, 64, 128, 255,
        32, 96, 160, 224,
        16, 80, 144, 208,
        48, 112, 176, 240,
      ])),
      dispose: vi.fn(),
    };
    const photoshop = {
      app: { documents: [source], activeDocument: source },
      imaging: {
        getSelection: vi.fn(async () => ({
          imageData,
          sourceBounds: { left: 400, top: 300, right: 404, bottom: 304 },
        })),
      },
      action: { batchPlay: vi.fn() },
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({ createFile: vi.fn(async () => file) })),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    const snapshot = await runtime.captureInpaintSnapshot("7", "klein-9b");

    expect(photoshop.imaging.getSelection).toHaveBeenCalledWith(expect.objectContaining({
      documentID: 7,
      sourceBounds: { left: 274, top: 174, right: 530, bottom: 430 },
    }));
    expect(imageData.getData).toHaveBeenCalledWith({ chunky: true });
    expect(imageData.dispose).toHaveBeenCalledOnce();
    const decoded = decodeStoredGrayscalePng(snapshot.maskBytes);
    expect(decoded.width).toBe(256);
    expect(decoded.height).toBe(256);
    expect(Array.from(decoded.pixels.slice(126 * 256 + 126, 126 * 256 + 130)))
      .toEqual([0, 64, 128, 255]);
    expect(Array.from(decoded.pixels.slice(127 * 256 + 126, 127 * 256 + 130)))
      .toEqual([32, 96, 160, 224]);
    for (let y = 0; y < decoded.height; y += 1) {
      for (let x = 0; x < decoded.width; x += 1) {
        const inside = x >= 126 && x < 130 && y >= 126 && y < 130;
        if (!inside) expect(decoded.pixels[y * decoded.width + x]).toBe(0);
      }
    }
    expect(snapshot.maskMimeType).toBe("image/png");
    const composite = decodeStoredGrayscalePng(snapshot.compositeMaskBytes ?? new Uint8Array());
    expect(composite.width).toBe(256);
    expect(composite.height).toBe(256);
    expect(Array.from(composite.pixels.slice(0, 16))).toEqual(new Array(16).fill(0));
    expect(composite.pixels.some((value) => value > 0)).toBe(true);
    expect(snapshot.compositeMaskMimeType).toBe("image/png");
  });

  it("samples the median surrounding RGB color for removal prefill", async () => {
    const sourceSelection = {
      bounds: { left: 400, top: 300, right: 404, bottom: 304 },
      save: vi.fn(async (name: string) => {
        source.channels.push({ name });
      }),
    };
    const contextDuplicate = {
      crop: vi.fn(async () => undefined),
      flatten: vi.fn(async () => undefined),
      saveAs: { png: vi.fn(async () => undefined) },
      closeWithoutSaving: vi.fn(async () => undefined),
    };
    const source = {
      id: 7,
      width: 1000,
      height: 800,
      selection: sourceSelection,
      channels: [] as Array<{ name: string }>,
      duplicate: vi.fn(async () => contextDuplicate),
    };
    const contextFile = {
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
      delete: vi.fn(async () => undefined),
    };
    const maskImageData = {
      width: 4,
      height: 4,
      getData: vi.fn(async () => new Uint8Array(16).fill(255)),
      dispose: vi.fn(),
    };
    const colorImageData = {
      width: 256,
      height: 256,
      darkBoundary: false,
      getData: vi.fn(async () => {
        const data = new Uint8Array(256 * 256 * 3);
        for (let index = 0; index < data.length; index += 3) {
          data[index] = 232;
          data[index + 1] = 233;
          data[index + 2] = 235;
        }
        if (colorImageData.darkBoundary) {
          for (let y = 126; y < 130; y += 1) {
            const offset = (y * 256 + 130) * 3;
            data[offset] = 20;
            data[offset + 1] = 20;
            data[offset + 2] = 20;
          }
        }
        return data;
      }),
      dispose: vi.fn(),
    };
    const photoshop = {
      app: { documents: [source], activeDocument: source },
      imaging: {
        getSelection: vi.fn(async () => ({
          imageData: maskImageData,
          sourceBounds: { left: 400, top: 300, right: 404, bottom: 304 },
        })),
        getPixels: vi.fn(async () => ({ imageData: colorImageData })),
      },
      action: { batchPlay: vi.fn() },
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({
            createFile: vi.fn(async () => contextFile),
          })),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    const snapshot = await runtime.captureInpaintSnapshot("7", "klein-9b");

    expect(photoshop.imaging.getPixels).toHaveBeenCalledWith(expect.objectContaining({
      documentID: 7,
      sourceBounds: { left: 274, top: 174, right: 530, bottom: 430 },
      targetSize: { width: 256, height: 256 },
    }));
    expect(colorImageData.dispose).toHaveBeenCalledOnce();
    expect(snapshot.removalFillColor).toBe(0xe8e9eb);
    expect(snapshot.removalBackgroundUniform).toBe(true);

    colorImageData.darkBoundary = true;
    const connectedBackground = await runtime.captureInpaintSnapshot("7", "klein-9b");
    expect(connectedBackground.removalFillColor).toBe(0xe8e9eb);
    expect(connectedBackground.removalBackgroundUniform).toBe(false);
    expect(colorImageData.dispose).toHaveBeenCalledTimes(2);
  });

  it("restores and removes the native selection channel during inpaint writeback", async () => {
    const state = { left: 0, top: 0, right: 100, bottom: 75 };
    const generatedLayer = {
      id: 88,
      name: "背景",
      visible: false,
      bounds: state,
      scale: vi.fn(async (horizontal: number, vertical: number) => {
        state.right = state.left + (state.right - state.left) * horizontal / 100;
        state.bottom = state.top + (state.bottom - state.top) * vertical / 100;
      }),
      translate: vi.fn(async (x: number, y: number) => {
        state.left += x;
        state.right += x;
        state.top += y;
        state.bottom += y;
      }),
    };
    const selectionChannel = {
      name: "Klein Selection 123",
      remove: vi.fn(async () => undefined),
    };
    const selection = {
      bounds: null,
      load: vi.fn(async () => undefined),
      selectRectangle: vi.fn(async () => undefined),
      deselect: vi.fn(async () => undefined),
    };
    const document = {
      id: 7,
      width: 1000,
      height: 800,
      activeLayers: [generatedLayer],
      selection,
      channels: [selectionChannel],
      createLayerGroup: vi.fn(),
    };
    const photoshop = {
      app: { documents: [document], activeDocument: document },
      action: {
        batchPlay: vi.fn(async (descriptors: Array<{ _obj?: string }>) => {
          if (descriptors[0]?._obj === "placeEvent") {
            document.activeLayers = [generatedLayer];
          }
          if (descriptors[0]?._obj === "get") {
            return descriptors[0]._target?.[0]?._enum === "ordinal"
              ? [{ layerID: generatedLayer.id }]
              : [{ bounds: { ...state } }];
          }
        }),
      },
      constants: { AnchorPosition: { TOPLEFT: "top-left" } },
    };
    const generatedFile = {
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({
            createFile: vi.fn(async () => generatedFile),
          })),
          createSessionToken: vi.fn(() => "token"),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));
    const snapshot = {
      documentId: "7",
      documentWidth: 1000,
      documentHeight: 800,
      selectionBounds: { x: 200, y: 250, width: 100, height: 80 },
      cropBounds: { x: 100, y: 150, width: 800, height: 600 },
      targetWidth: 512,
      targetHeight: 384,
      contextBytes: new Uint8Array([1]),
      maskBytes: new Uint8Array([0, 255, 127, 0]),
      selectionChannelName: "Klein Selection 123",
      mimeType: "image/png",
    };

    await runtime.insertIntoCurrentDocument(
      [{ ...assets[0], layerName: "智能填充" }],
      "7",
      snapshot,
    );

    expect(selection.selectRectangle).not.toHaveBeenCalled();
    expect(selection.load).toHaveBeenCalledWith(selectionChannel);
    expect(selectionChannel.remove).toHaveBeenCalledOnce();
    expect(generatedLayer.scale).toHaveBeenCalledWith(800, 800, "top-left");
    expect(generatedLayer.translate).toHaveBeenCalledWith(100, 150);
    expect(photoshop.action.batchPlay.mock.calls
      .flatMap((call) => call[0])
      .some((descriptor) => descriptor._obj === "matchColor")).toBe(false);
    expect(photoshop.action.batchPlay.mock.calls
      .flatMap((call) => call[0])
      .some((descriptor) => descriptor._obj === "set"
        && descriptor.to?.userMaskFeather)).toBe(false);
    expect(selection.deselect).not.toHaveBeenCalled();
  });

  it("adds a reveal-selection mask for inpaint without creating a layer group", async () => {
    const state = { left: 0, top: 0, right: 75, bottom: 100 };
    const placedLayer = {
      id: 88,
      name: "",
      visible: false,
      bounds: state,
      scale: vi.fn(async (horizontal: number, vertical: number) => {
        state.right = state.left + (state.right - state.left) * horizontal / 100;
        state.bottom = state.top + (state.bottom - state.top) * vertical / 100;
      }),
      translate: vi.fn(async (x: number, y: number) => {
        state.left += x;
        state.right += x;
        state.top += y;
        state.bottom += y;
      }),
    };
    const selection = {
      bounds: null,
      selectRectangle: vi.fn(async () => undefined),
      deselect: vi.fn(async () => undefined),
    };
    const document = {
      id: 7,
      width: 1000,
      height: 800,
      activeLayers: [placedLayer],
      selection,
      createLayerGroup: vi.fn(),
    };
    const file = {
      write: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const photoshop = {
      app: { documents: [document], activeDocument: document },
      action: {
        batchPlay: vi.fn(async (descriptors: Array<{ _obj?: string }>) => (
          descriptors[0]?._obj === "get"
            ? descriptors[0]._target?.[0]?._enum === "ordinal"
              ? [{ layerID: placedLayer.id }]
              : [{ bounds: { ...state } }]
            : undefined
        )),
      },
      constants: { AnchorPosition: { TOPLEFT: "top-left" } },
    };
    const uxp = {
      storage: {
        formats: { binary: "binary" },
        localFileSystem: {
          getTemporaryFolder: vi.fn(async () => ({
            createFile: vi.fn(async () => file),
          })),
          createSessionToken: vi.fn(() => "token"),
        },
      },
    };
    const runtime = new UxpPhotoshopRuntime((moduleName) => (
      moduleName === "photoshop" ? photoshop : uxp
    ));

    await runtime.insertIntoCurrentDocument(
      [{ ...assets[0], layerName: "智能填充" }],
      "7",
      { x: 10, y: 20, width: 30, height: 40 },
    );

    expect(document.createLayerGroup).not.toHaveBeenCalled();
    expect(selection.selectRectangle).toHaveBeenCalledWith({
      left: 10,
      top: 20,
      right: 40,
      bottom: 60,
    });
    expect(placedLayer.scale).toHaveBeenCalledWith(40, 40, "top-left");
    expect(placedLayer.translate).toHaveBeenCalledWith(10, 20);
    expect(photoshop.action.batchPlay).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          _obj: "make",
          new: { _class: "channel" },
          using: { _enum: "userMaskEnabled", _value: "revealSelection" },
        }),
      ]),
      expect.any(Object),
    );
    expect(selection.deselect).toHaveBeenCalledOnce();
    expect(placedLayer.name).toBe("智能填充");
  });
});
