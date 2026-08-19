import type { GeneratedImageAsset, PhotoshopPreviewSession } from "./backend/contracts";

interface PreviewDriver {
  stage(documentId: string, asset: GeneratedImageAsset): Promise<PhotoshopPreviewSession>;
  discard(session: PhotoshopPreviewSession): Promise<void>;
  commit?(session: PhotoshopPreviewSession): Promise<void>;
}

interface PreviewState {
  assetId: string;
  session: PhotoshopPreviewSession;
}

export class PreviewCoordinator {
  private readonly states = new Map<string, PreviewState>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly throttleMs: number;

  constructor(private readonly driver: PreviewDriver, options: { throttleMs?: number } = {}) {
    this.throttleMs = options.throttleMs ?? 80;
  }

  show(documentId: string, asset: GeneratedImageAsset) {
    return this.enqueue(documentId, async () => {
      if (this.throttleMs > 0) await new Promise((resolve) => setTimeout(resolve, this.throttleMs));
      const current = this.states.get(documentId);
      if (current?.assetId === asset.id) return;
      if (current) {
        await this.driver.discard(current.session);
        this.states.delete(documentId);
      }
      const session = await this.driver.stage(documentId, asset);
      if (session.layerIds.length !== 1) {
        await this.driver.discard(session);
        throw new Error("候选预览必须且只能创建一个插件临时图层");
      }
      this.states.set(documentId, { assetId: asset.id, session });
    });
  }

  async commit(documentId: string) {
    await this.enqueue(documentId, async () => {
      const current = this.states.get(documentId);
      if (!current) return;
      await this.driver.commit?.(current.session);
      this.states.delete(documentId);
    });
  }

  async discard(documentId: string) {
    await this.enqueue(documentId, async () => {
      const current = this.states.get(documentId);
      if (!current) return;
      await this.driver.discard(current.session);
      this.states.delete(documentId);
    });
  }

  current(documentId: string) {
    return this.states.get(documentId) ?? null;
  }

  private enqueue(documentId: string, operation: () => Promise<void>) {
    const previous = this.queues.get(documentId) ?? Promise.resolve();
    const current = previous.then(operation, operation).finally(() => {
      if (this.queues.get(documentId) === current) this.queues.delete(documentId);
    });
    this.queues.set(documentId, current);
    return current;
  }
}
