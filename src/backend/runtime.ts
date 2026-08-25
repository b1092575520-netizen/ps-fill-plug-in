import type {
  PhotoshopContext,
} from "../types";
import { AssetLifecycleManager, type AssetOwner } from "../assetLifecycleManager";
import { MemoryCredentialStore, SecureCredentialStore } from "./credentials";
import type {
  CapturedReference,
  GeneratedImageAsset,
  PhotoshopRuntime,
  ReferenceCaptureScope,
} from "./contracts";
import { PhotoshopGateway } from "./photoshopGateway";
import { filesFromUxpEntries } from "./referenceSelection";

type UxpRequire = (moduleName: string) => any;

function getUxpRequire(): UxpRequire | null {
  const candidate = (globalThis as typeof globalThis & { require?: UxpRequire }).require;
  if (typeof candidate !== "function") return null;
  try {
    candidate("uxp");
    candidate("photoshop");
    return candidate;
  } catch {
    return null;
  }
}

export function isUxpRuntime() {
  return getUxpRequire() !== null;
}

export function createCredentialStore() {
  const requireUxp = getUxpRequire();
  if (!requireUxp) return new MemoryCredentialStore();
  return new SecureCredentialStore(requireUxp("uxp").storage.secureStorage);
}

export const UXP_REFERENCE_PICKER_OPTIONS = { allowMultiple: true } as const;

export async function pickUxpReferenceFiles() {
  const requireUxp = getUxpRequire();
  if (!requireUxp) return [];
  const storage = requireUxp("uxp").storage;
  const selected = await storage.localFileSystem.getFileForOpening(UXP_REFERENCE_PICKER_OPTIONS);
  const entries = Array.isArray(selected) ? selected : selected ? [selected] : [];
  const files = await filesFromUxpEntries(entries, storage.formats.binary);
  if (entries.length && !files.length) {
    throw new Error("请选择 PNG、JPG、WebP、GIF、BMP 或 AVIF 图片");
  }
  return files;
}

class BrowserPhotoshopRuntime implements PhotoshopRuntime {
  async getContext(): Promise<PhotoshopContext> {
    return {
      documentId: "browser-demo",
      documentName: "浏览器演示模式",
      width: 0,
      height: 0,
      colorMode: "Demo",
      selection: null,
    };
  }

  async getOpenDocumentIds(): Promise<string[] | null> {
    return ["browser-demo"];
  }

  async executeAsModal(operation: () => Promise<void>) {
    await operation();
  }

  async captureVisibleComposite(): Promise<CapturedReference> {
    throw new Error("浏览器演示模式不能读取 Photoshop 画面");
  }

  async insertIntoCurrentDocument(): Promise<string[]> {
    throw new Error("浏览器演示模式不能写入 Photoshop");
  }

  async createDocumentFromImages(): Promise<string[]> {
    throw new Error("浏览器演示模式不能新建 Photoshop 文档");
  }

  async setPreviewLayer(): Promise<void> {
    throw new Error("浏览器演示模式不能预览 Photoshop 图层");
  }

  async discardPreviewLayers(): Promise<void> {
    throw new Error("浏览器演示模式不能清理 Photoshop 图层");
  }

  async cleanupTemporaryFiles() {}
}

export class UxpPhotoshopRuntime implements PhotoshopRuntime {
  private readonly photoshop: any;
  private readonly uxp: any;
  private temporaryFiles: Array<{ file: any; owner?: AssetOwner; assetId?: string }> = [];
  private temporaryFileSequence = 0;

  constructor(
    requireUxp: UxpRequire,
    private readonly assetLifecycle?: AssetLifecycleManager,
  ) {
    this.photoshop = requireUxp("photoshop");
    this.uxp = requireUxp("uxp");
  }

  async getContext(): Promise<PhotoshopContext> {
    const document = this.photoshop.app.activeDocument;
    if (!document) throw new Error("Photoshop 当前没有打开的文档");
    const selection = this.selectionBounds(document);
    return {
      documentId: String(document.id),
      documentName: document.title,
      width: Number(document.width),
      height: Number(document.height),
      colorMode: String(document.mode ?? "RGB"),
      selection,
    };
  }

  async getOpenDocumentIds() {
    const documents = this.photoshop.app.documents;
    try {
      if (documents && typeof documents.length === "number") {
        const ids = Array.from({ length: documents.length }, (_, index) => String(documents[index].id));
        // A live active document together with an empty collection is a
        // transient/inconsistent host read, not proof that every document
        // closed. Preserve sessions until a coherent list is available.
        return ids.length || !this.photoshop.app.activeDocument ? ids : null;
      }
      if (documents && typeof documents[Symbol.iterator] === "function") {
        const ids = Array.from(documents as any[], (document) => String(document.id));
        return ids.length || !this.photoshop.app.activeDocument ? ids : null;
      }
    } catch {
      // Enumeration can fail while Photoshop is changing documents. Treat it
      // as unknown so callers do not mistake a partial list for closure.
    }
    return null;
  }

  async executeAsModal(operation: () => Promise<void>, name: string) {
    await this.photoshop.core.executeAsModal(operation, { commandName: name });
  }

  async captureVisibleComposite(
    scope: ReferenceCaptureScope,
    documentId?: string,
    owner?: AssetOwner,
  ): Promise<CapturedReference> {
    const source = this.findDocument(documentId);
    const selection = scope === "selection" ? this.selectionBounds(source) : null;
    if (scope === "selection" && !selection) throw new Error("请先在 Photoshop 中建立选区");
    const folder = await this.uxp.storage.localFileSystem.getTemporaryFolder();
    const isDocumentReference = scope === "document";
    const fileName = `ps-fill-${isDocumentReference ? "document" : "selection"}-${this.nextTemporaryStamp()}.${isDocumentReference ? "jpg" : "png"}`;
    const file = await folder.createFile(fileName, { overwrite: true });
    this.trackTemporaryFile(file, owner);
    const duplicate = await source.duplicate(`参考快照 ${Date.now()}`);
    try {
      if (selection) {
        await duplicate.crop({
          left: selection.x,
          top: selection.y,
          right: selection.x + selection.width,
          bottom: selection.y + selection.height,
        });
      }
      await duplicate.flatten();
      let data: ArrayBuffer;
      if (isDocumentReference) {
        const width = Number(source.width);
        const height = Number(source.height);
        const longestEdge = Math.max(width, height);
        let exportedWidth = width;
        let exportedHeight = height;
        if (Number.isFinite(longestEdge) && longestEdge > 3072) {
          const scale = 3072 / longestEdge;
          exportedWidth = Math.max(1, Math.round(width * scale));
          exportedHeight = Math.max(1, Math.round(height * scale));
          await duplicate.resizeImage(exportedWidth, exportedHeight);
        }
        await duplicate.saveAs.jpg(file, { quality: 9 }, true);
        data = await file.read({ format: this.uxp.storage.formats.binary });
        if (data.byteLength > 1_800_000) {
          const exportedLongestEdge = Math.max(exportedWidth, exportedHeight);
          if (exportedLongestEdge > 2048) {
            const scale = 2048 / exportedLongestEdge;
            exportedWidth = Math.max(1, Math.round(exportedWidth * scale));
            exportedHeight = Math.max(1, Math.round(exportedHeight * scale));
            await duplicate.resizeImage(exportedWidth, exportedHeight);
          }
          await duplicate.saveAs.jpg(file, { quality: 8 }, true);
          data = await file.read({ format: this.uxp.storage.formats.binary });
        }
      } else {
        await duplicate.saveAs.png(file, { compression: 6, interlaced: false }, true);
        data = await file.read({ format: this.uxp.storage.formats.binary });
      }
      return {
        bytes: new Uint8Array(data),
        mimeType: isDocumentReference ? "image/jpeg" : "image/png",
        fileName,
      };
    } finally {
      await duplicate.closeWithoutSaving();
    }
  }

  async insertIntoCurrentDocument(
    assets: GeneratedImageAsset[],
    documentId?: string,
    owner?: AssetOwner,
  ) {
    const document = this.findDocument(documentId);
    if (
      documentId
      && (!this.photoshop.app.activeDocument
        || String(this.photoshop.app.activeDocument.id) !== String(document.id))
    ) {
      throw new Error("生成期间 Photoshop 当前文档已切换，已拒绝写入");
    }
    await this.photoshop.action.batchPlay([{
      _obj: "select",
      _target: [{ _ref: "document", _id: document.id }],
      _options: { dialogOptions: "dontDisplay" },
    }], { synchronousExecution: true, modalBehavior: "execute" });
    const layerIds: string[] = [];
    try {
      const files = await this.writeTemporaryFiles(assets, owner);
      for (let index = 0; index < files.length; index += 1) {
        const layer = await this.placeFile(
          document,
          files[index],
          assets[index].layerName ?? assets[index].id,
          true,
        );
        if (layer.id !== undefined) layerIds.push(String(layer.id));
        layer.visible = index === 0;
      }
    } catch (error) {
      for (const layerId of layerIds) {
        try {
          const layer = this.findLayer(document, layerId);
          if (layer?.delete) await layer.delete();
        } catch {
          // Preserve the alignment error while best-effort removing partial output.
        }
      }
      throw error;
    }
    return layerIds;
  }

  async createDocumentFromImages(
    assets: GeneratedImageAsset[],
    owner?: AssetOwner,
  ): Promise<string[]> {
    const files = await this.writeTemporaryFiles(assets, owner);
    let document: any;
    const layerIds: string[] = [];
    try {
      await this.executeAsModal(async () => {
        document = await this.photoshop.app.open(files[0]);
        const openedLayer = document.activeLayers?.[0] ?? document.layers?.[0];
        let descriptorLayerId: string | number | undefined;
        try {
          const descriptor = await this.photoshop.action.batchPlay([{
            _obj: "get",
            _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
            _options: { dialogOptions: "dontDisplay" },
          }], { synchronousExecution: true, modalBehavior: "execute" });
          descriptorLayerId = descriptor?.[0]?.layerID ?? descriptor?.[0]?.ID;
        } catch (error) {
          if (openedLayer?.id === undefined) throw error;
        }
        const openedLayerId = descriptorLayerId ?? openedLayer?.id;
        if (openedLayerId === undefined) throw new Error("Photoshop 未返回新文档图层");
        try {
          await this.photoshop.action.batchPlay([{
            _obj: "set",
            _target: [{ _ref: "layer", _id: openedLayerId }],
            to: { _obj: "layer", name: assets[0].layerName ?? assets[0].id },
            _options: { dialogOptions: "dontDisplay" },
          }], { synchronousExecution: true, modalBehavior: "execute" });
        } catch {
          try {
            if (openedLayer) openedLayer.name = assets[0].layerName ?? assets[0].id;
          } catch {
            // The image is already open; an optional layer rename must not discard it.
          }
        }
        try {
          if (openedLayer) openedLayer.visible = true;
        } catch {
          // A newly opened image is visible by default.
        }
        layerIds.push(String(openedLayerId));
        for (let index = 1; index < files.length; index += 1) {
          const layer = await this.placeFile(
            document,
            files[index],
            assets[index].layerName ?? assets[index].id,
            false,
          );
          if (layer.id !== undefined) layerIds.push(String(layer.id));
        }
      }, "设置生成文档");
      return layerIds;
    } catch (error) {
      if (document) {
        try {
          await this.executeAsModal(
            () => document.closeWithoutSaving?.() ?? Promise.resolve(),
            "关闭未完成生成文档",
          );
        } catch {
          // Preserve the insertion error while best-effort removing the partial document.
        }
      }
      throw error;
    }
  }

  async setPreviewLayer(documentId: string, layerIds: string[], activeLayerId: string) {
    const document = this.findDocument(documentId);
    for (const layerId of layerIds) {
      const layer = this.findLayer(document, layerId);
      if (layer) layer.visible = String(layer.id) === activeLayerId;
    }
  }

  async discardPreviewLayers(documentId: string, layerIds: string[], keepLayerId?: string) {
    const document = this.findDocument(documentId);
    for (const layerId of layerIds) {
      if (keepLayerId && layerId === keepLayerId) {
        const layer = this.findLayer(document, layerId);
        if (layer) layer.visible = true;
        continue;
      }
      const layer = this.findLayer(document, layerId);
      if (layer?.delete) await layer.delete();
    }
  }

  async cleanupTemporaryFiles(owner?: AssetOwner) {
    const files = this.temporaryFiles.filter((entry) => !owner || (
      entry.owner?.documentId === owner.documentId
      && entry.owner.jobId === owner.jobId
      && entry.owner.revision === owner.revision
    ));
    this.temporaryFiles = this.temporaryFiles.filter((entry) => !files.includes(entry));
    await Promise.all(files.map(async ({ file, owner: fileOwner, assetId }) => {
      if (fileOwner && assetId && this.assetLifecycle) {
        await this.assetLifecycle.cleanupResource(fileOwner.documentId, "temporary-file", assetId);
        return;
      }
      try {
        await file.delete();
      } catch {
        // Best-effort cleanup must not hide the original generation/insertion result.
      }
    }));
  }

  private trackTemporaryFile(file: any, owner?: AssetOwner) {
    const assetId = owner ? `ps-fill-temporary-${this.nextTemporaryStamp()}` : undefined;
    this.temporaryFiles.push({ file, owner, assetId });
    if (owner && assetId) this.assetLifecycle?.register(
      assetId,
      "temporary-file",
      owner,
      () => file.delete(),
    );
  }

  async cleanupPluginResiduals() {
    const folder = await this.uxp.storage.localFileSystem.getTemporaryFolder();
    const entries = typeof folder.getEntries === "function" ? await folder.getEntries() : [];
    for (const entry of entries) {
      if (typeof entry?.name === "string" && entry.name.startsWith("ps-fill-") && typeof entry.delete === "function") {
        try {
          await entry.delete();
        } catch {
          // A locked plugin-owned residual can be retried on the next startup.
        }
      }
    }
  }

  private async writeTemporaryFiles(assets: GeneratedImageAsset[], owner?: AssetOwner) {
    const folder = await this.uxp.storage.localFileSystem.getTemporaryFolder();
    const files = [];
    const stamp = this.nextTemporaryStamp();
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      const extension = asset.mimeType.includes("jpeg") || asset.mimeType.includes("jpg")
        ? "jpg"
        : asset.mimeType.includes("webp") ? "webp" : "png";
      const file = await folder.createFile(`ps-fill-generated-${stamp}-${index}.${extension}`, {
        overwrite: true,
      });
      const bytes = asset.bytes.buffer.slice(
        asset.bytes.byteOffset,
        asset.bytes.byteOffset + asset.bytes.byteLength,
      );
      await file.write(bytes, { format: this.uxp.storage.formats.binary });
      this.trackTemporaryFile(file, owner);
      files.push(file);
    }
    return files;
  }

  private nextTemporaryStamp() {
    this.temporaryFileSequence += 1;
    return `${Date.now()}${String(this.temporaryFileSequence).padStart(4, "0")}`;
  }

  private async placeFile(document: any, file: any, name: string, visible: boolean) {
    const token = this.uxp.storage.localFileSystem.createSessionToken(file);
    const existingLayerIds = new Set(
      this.allLayers(document).map((item: any) => String(item.id)),
    );
    const anchorName = `ps-fill-place-anchor-${this.nextTemporaryStamp()}`;
    let anchorLayerId: string | undefined;
    let placeResult: any;
    try {
      await this.photoshop.action.batchPlay([{
        _obj: "make",
        _target: [{ _ref: "layer" }],
        using: { _obj: "layer", name: anchorName },
        _options: { dialogOptions: "dontDisplay" },
      }], { synchronousExecution: true, modalBehavior: "execute" });
      const anchorDescriptor = await this.photoshop.action.batchPlay([{
        _obj: "get",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        _options: { dialogOptions: "dontDisplay" },
      }], { synchronousExecution: true, modalBehavior: "execute" });
      const rawAnchorId = anchorDescriptor?.[0]?.layerID ?? anchorDescriptor?.[0]?.ID;
      if (rawAnchorId !== undefined) anchorLayerId = String(rawAnchorId);
      placeResult = await this.photoshop.action.batchPlay([{
        _obj: "placeEvent",
        null: { _path: token, _kind: "local" },
        linked: false,
        _options: { dialogOptions: "dontDisplay" },
      }], { synchronousExecution: true, modalBehavior: "execute" });
    } catch (error) {
      const anchor = anchorLayerId
        ? this.findLayer(document, anchorLayerId)
        : this.allLayers(document).find((layer: any) => layer.name === anchorName);
      if (anchor?.delete) await anchor.delete();
      throw error;
    }
    const activeDescriptor = await this.photoshop.action.batchPlay([{
      _obj: "get",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      _options: { dialogOptions: "dontDisplay" },
    }], { synchronousExecution: true, modalBehavior: "execute" });
    const placedDescriptor = placeResult?.[0];
    const activeLayerId = placedDescriptor?.ID
      ?? placedDescriptor?.layerID
      ?? placedDescriptor?.replaceLayer?.to?._id
      ?? activeDescriptor?.[0]?.layerID
      ?? activeDescriptor?.[0]?.ID;
    const domActiveLayer = document.activeLayers?.[0];
    const descriptorLayer = activeLayerId !== undefined && !existingLayerIds.has(String(activeLayerId))
      ? this.findLayer(document, String(activeLayerId)) ?? (
        activeLayerId !== undefined
        && String(domActiveLayer?.id) === String(activeLayerId)
          ? domActiveLayer
          : undefined
      )
      : undefined;
    const layer = descriptorLayer ?? this.findNewLayer(document, existingLayerIds);
    if (!layer) throw new Error("Photoshop 未返回刚插入的图层");
    layer.name = name;
    layer.visible = visible;
    return layer;
  }

  private findDocument(documentId?: string) {
    const document = documentId
      ? this.photoshop.app.documents.find((item: any) => String(item.id) === documentId)
      : this.photoshop.app.activeDocument;
    if (!document) {
      throw new Error(documentId
        ? "生成任务对应的 Photoshop 文档已关闭"
        : "Photoshop 当前没有打开的文档");
    }
    return document;
  }

  private findLayer(document: any, id: string): any {
    const visit = (layers: any, predicate: (layer: any) => boolean): any => {
      if (!layers) return undefined;
      for (const layer of Array.from(layers as any[])) {
        if (predicate(layer)) return layer;
        const nested = visit(layer.layers, predicate);
        if (nested) return nested;
      }
      return undefined;
    };
    return visit(document.layers, (layer) => String(layer.id) === id);
  }

  private allLayers(document: any): any[] {
    const result: any[] = [];
    const visit = (layers: any) => {
      if (!layers) return;
      for (const layer of Array.from(layers as any[])) {
        result.push(layer);
        visit(layer.layers);
      }
    };
    visit(document.layers);
    return result;
  }

  private findNewLayer(document: any, existingIds: Set<string>): any {
    const layers = this.allLayers(document);
    return layers.find((layer) => (
      layer.id !== undefined && !existingIds.has(String(layer.id))
    ));
  }

  private selectionBounds(document: any): PhotoshopContext["selection"] {
    try {
      const bounds = document.selection?.bounds;
      if (!bounds) return null;
      const value = (item: unknown) => Number(
        typeof item === "object" && item && "value" in item
          ? (item as { value: unknown }).value
          : item,
      );
      const left = value(bounds.left);
      const top = value(bounds.top);
      const right = value(bounds.right);
      const bottom = value(bounds.bottom);
      if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
        return null;
      }
      return { x: left, y: top, width: right - left, height: bottom - top };
    } catch {
      return null;
    }
  }

}

export function createPhotoshopGateway(assetLifecycle?: AssetLifecycleManager) {
  const requireUxp = getUxpRequire();
  return new PhotoshopGateway(
    requireUxp ? new UxpPhotoshopRuntime(requireUxp, assetLifecycle) : new BrowserPhotoshopRuntime(),
  );
}
