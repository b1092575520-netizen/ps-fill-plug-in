import type { OutputTarget } from "../types";
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
  private hostModalQueue: Promise<void> = Promise.resolve();

  constructor(private readonly runtime: PhotoshopRuntime) {}

  private enqueueHostModal<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.hostModalQueue.then(operation, operation);
    this.hostModalQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async executeAsModal(operation: () => Promise<void>, name: string) {
    for (let attempt = 0; ; attempt += 1) {
      let callbackStarted = false;
      try {
        await this.runtime.executeAsModal(async () => {
          callbackStarted = true;
          await operation();
        }, name);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const modalErrorNumber = typeof error === "object" && error !== null && "number" in error ? error.number : undefined;
        const retryable = modalErrorNumber === 9 || /modal state|modal operation|modal command|already.*modal/i.test(message);
        if (!retryable || callbackStarted || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
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
      await this.enqueueHostModal(async () => {
        await this.executeAsModal(async () => {
          capture = owner
            ? await this.runtime.captureVisibleComposite(scope, documentId, owner)
            : await this.runtime.captureVisibleComposite(scope, documentId);
        }, scope === "selection" ? "截取当前选区" : "截取当前画面");
      });
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
    owner?: AssetOwner,
  ) {
    if (!assets.length) throw new Error("没有可插入的候选图");
    return this.enqueueHostModal(async () => {
      let layerIds: string[] = [];
      let activeDocumentId: string | undefined;
      try {
        if (target === "new-document") {
          layerIds = owner
            ? await this.runtime.createDocumentFromImages(assets, owner)
            : await this.runtime.createDocumentFromImages(assets);
          activeDocumentId = (await this.runtime.getContext()).documentId;
        } else {
          await this.executeAsModal(async () => {
            layerIds = owner
              ? await this.runtime.insertIntoCurrentDocument(assets, documentId, owner)
              : await this.runtime.insertIntoCurrentDocument(assets, documentId);
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
    await this.enqueueHostModal(async () => {
      await this.executeAsModal(
        () => this.runtime.setPreviewLayer(session.documentId, session.layerIds, activeLayerId),
        "切换生成候选",
      );
    });
  }

  async discardPreview(session: PhotoshopPreviewSession, keepLayerId?: string) {
    await this.enqueueHostModal(async () => {
      await this.executeAsModal(
        () => this.runtime.discardPreviewLayers(session.documentId, session.layerIds, keepLayerId),
        keepLayerId ? "确认生成候选" : "取消生成候选",
      );
    });
  }

  async cleanupPluginResiduals() {
    await this.runtime.cleanupPluginResiduals?.();
  }

}
