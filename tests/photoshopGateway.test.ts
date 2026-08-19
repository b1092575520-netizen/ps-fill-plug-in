import { describe, expect, it, vi } from "vitest";
import { PhotoshopGateway } from "../src/backend/photoshopGateway";
import { UxpPhotoshopRuntime } from "../src/backend/runtime";
import { AssetLifecycleManager } from "../src/assetLifecycleManager";

const assets = [
  { id: "one", bytes: new Uint8Array([1]), mimeType: "image/png" },
  { id: "two", bytes: new Uint8Array([2]), mimeType: "image/png" },
];

describe("PhotoshopGateway", () => {
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
    await gateway.insert(assets, "current-document", "doc-7");
    expect(runtime.executeAsModal).toHaveBeenCalledOnce();
    expect(runtime.insertIntoCurrentDocument).toHaveBeenCalledWith(assets, "doc-7");
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
});
