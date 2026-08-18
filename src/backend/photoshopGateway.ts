import type { LocalInpaintModel, OutputTarget, SelectionSnapshot } from "../types";
import type { AssetOwner } from "../assetLifecycleManager";
import type {
  CapturedReference,
  GeneratedImageAsset,
  PhotoshopPreviewSession,
  PhotoshopRuntime,
  PhotoshopWriter,
  ReferenceCaptureScope,
} from "./contracts";

export class PhotoshopGateway implements PhotoshopWriter {
  private previewModalQueue: Promise<void> = Promise.resolve();

  constructor(private readonly runtime: PhotoshopRuntime) {}

  private enqueuePreviewModal<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.previewModalQueue.then(operation, operation);
    this.previewModalQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  getContext() {
    return this.runtime.getContext();
  }

  getOpenDocumentIds(): Promise<string[] | null> {
    if (this.runtime.getOpenDocumentIds) return this.runtime.getOpenDocumentIds();
    // A missing enumerator is not proof that every other document closed.
    return Promise.resolve(null);
  }

  async captureReference(
    scope: ReferenceCaptureScope,
    documentId?: string,
    owner?: AssetOwner,
  ): Promise<CapturedReference> {
    let capture: CapturedReference | undefined;
    try {
      await this.runtime.executeAsModal(async () => {
        capture = owner
          ? await this.runtime.captureVisibleComposite(scope, documentId, owner)
          : await this.runtime.captureVisibleComposite(scope, documentId);
      }, scope === "selection" ? "截取当前选区" : "截取当前画面");
      if (!capture) throw new Error("Photoshop 未返回参考图");
      return capture;
    } finally {
      if (owner) await this.runtime.cleanupTemporaryFiles(owner);
      else await this.runtime.cleanupTemporaryFiles();
    }
  }

  async insert(
    assets: GeneratedImageAsset[],
    target: OutputTarget,
    documentId?: string,
    selection?: import("../types").SelectionBounds | SelectionSnapshot | null,
    owner?: AssetOwner,
  ) {
    if (!assets.length) throw new Error("没有可插入的候选图");
    return this.enqueuePreviewModal(async () => {
      let layerIds: string[] = [];
      let activeDocumentId: string | undefined;
      try {
        if (target === "new-document") {
          layerIds = owner
            ? await this.runtime.createDocumentFromImages(assets, owner)
            : await this.runtime.createDocumentFromImages(assets);
          activeDocumentId = (await this.runtime.getContext()).documentId;
        } else {
          await this.runtime.executeAsModal(async () => {
            layerIds = owner
              ? await this.runtime.insertIntoCurrentDocument(assets, documentId, selection, owner)
              : await this.runtime.insertIntoCurrentDocument(assets, documentId, selection);
            activeDocumentId = (await this.runtime.getContext()).documentId;
          }, "插入生成图层");
        }
        if (layerIds.length !== assets.length) {
          throw new Error("Photoshop 未返回完整的候选图层");
        }
        return {
          documentId: target === "new-document"
            ? activeDocumentId!
            : documentId ?? activeDocumentId!,
          layerIds,
        } satisfies PhotoshopPreviewSession;
      } finally {
        if (owner) await this.runtime.cleanupTemporaryFiles(owner);
        else await this.runtime.cleanupTemporaryFiles();
      }
    });
  }

  async preview(session: PhotoshopPreviewSession, activeLayerId: string) {
    await this.enqueuePreviewModal(async () => {
      await this.runtime.executeAsModal(
        () => this.runtime.setPreviewLayer(session.documentId, session.layerIds, activeLayerId),
        "切换生成候选",
      );
    });
  }

  async discardPreview(session: PhotoshopPreviewSession, keepLayerId?: string) {
    await this.enqueuePreviewModal(async () => {
      await this.runtime.executeAsModal(
        () => this.runtime.discardPreviewLayers(session.documentId, session.layerIds, keepLayerId),
        keepLayerId ? "确认生成候选" : "取消生成候选",
      );
    });
  }

  async cleanupPluginResiduals() {
    await this.runtime.cleanupPluginResiduals?.();
  }

  async cleanupSelectionChannel(documentId: string, channelName: string) {
    if (!channelName.startsWith("ps-fill-selection-")) return;
    await this.enqueuePreviewModal(async () => {
      await this.runtime.executeAsModal(
        () => this.runtime.cleanupSelectionChannel?.(documentId, channelName) ?? Promise.resolve(),
        "清理生成填充选区",
      );
    });
  }

  async captureInpaintSnapshot(
    documentId: string | undefined,
    model: LocalInpaintModel,
    owner?: AssetOwner,
  ) {
    let snapshot: SelectionSnapshot | undefined;
    try {
      await this.runtime.executeAsModal(async () => {
        snapshot = owner
          ? await this.runtime.captureInpaintSnapshot(documentId, model, owner)
          : await this.runtime.captureInpaintSnapshot(documentId, model);
      }, "保存局部重绘选区");
      if (!snapshot) throw new Error("Photoshop 未返回局部重绘快照");
      return snapshot;
    } finally {
      if (owner) await this.runtime.cleanupTemporaryFiles(owner);
      else await this.runtime.cleanupTemporaryFiles();
    }
  }
}
