import type {
  LocalInpaintModel,
  PhotoshopContext,
  SelectionBounds,
  SelectionSnapshot,
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
import {
  computeInpaintGeometry,
  encodeGrayscalePng,
  featherSelectionMask,
  rasterizeSelectionMask,
} from "./localInpaintGeometry";

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

  async captureInpaintSnapshot(): Promise<SelectionSnapshot> {
    throw new Error("浏览器演示模式不能读取 Photoshop 选区");
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

  async captureInpaintSnapshot(
    documentId: string | undefined,
    model: LocalInpaintModel,
    owner?: AssetOwner,
  ): Promise<SelectionSnapshot> {
    const source = this.findDocument(documentId);
    const selection = this.selectionBounds(source);
    if (!selection) throw new Error("请先在 Photoshop 中建立选区");
    const documentWidth = Number(source.width);
    const documentHeight = Number(source.height);
    const geometry = computeInpaintGeometry(
      selection,
      documentWidth,
      documentHeight,
      model,
    );
    const folder = await this.uxp.storage.localFileSystem.getTemporaryFolder();
    const stamp = this.nextTemporaryStamp();
    const contextFile = await folder.createFile(`ps-fill-klein-context-${stamp}.png`, { overwrite: true });
    this.trackTemporaryFile(contextFile, owner);

    const contextDuplicate = await source.duplicate(`Klein 上下文 ${stamp}`);
    try {
      await contextDuplicate.crop({
        left: geometry.cropBounds.x,
        top: geometry.cropBounds.y,
        right: geometry.cropBounds.x + geometry.cropBounds.width,
        bottom: geometry.cropBounds.y + geometry.cropBounds.height,
      });
      // Keep the cropped context at its native document resolution. Klein's
      // workflow performs the single model-space resize; resizing here first
      // and then resizing again in ComfyUI creates a second aspect-ratio and
      // resampling transform that cannot be reversed during writeback.
      await contextDuplicate.flatten();
      await contextDuplicate.saveAs.png(contextFile, { compression: 4, interlaced: false }, true);
    } finally {
      await contextDuplicate.closeWithoutSaving();
    }

    const selectionChannelName = `ps-fill-selection-${stamp}`;
    const savedChannel = await source.selection.save(selectionChannelName);
    const selectionChannel = savedChannel ?? this.findChannel(source, selectionChannelName);
    if (!selectionChannel) throw new Error("Photoshop 未返回局部重绘选区通道");

    try {
      const contextData = await contextFile.read({ format: this.uxp.storage.formats.binary });
      if ((model as string) === "klein-4b") {
        const imaging = this.photoshop.imaging;
        if (typeof imaging?.getSelection === "function") {
          const result = await imaging.getSelection({
            documentID: source.id,
            sourceBounds: {
              left: geometry.cropBounds.x,
              top: geometry.cropBounds.y,
              right: geometry.cropBounds.x + geometry.cropBounds.width,
              bottom: geometry.cropBounds.y + geometry.cropBounds.height,
            },
          });
          result?.imageData?.dispose?.();
        }
      }
      const encodedMask = (model as string) === "klein-4b"
        ? {
          bytes: new Uint8Array(),
          mimeType: "image/png" as const,
          compositeBytes: new Uint8Array(),
          compositeMimeType: "image/png" as const,
          removalFillColor: 0xffffff,
          removalBackgroundUniform: false,
        }
        : await this.captureSelectionMask(
          source,
          geometry.cropBounds,
          geometry.compositeFeatherRadius,
        );
      return {
        documentId: String(source.id),
        documentWidth,
        documentHeight,
        selectionBounds: { ...selection },
        cropBounds: geometry.cropBounds,
        targetWidth: geometry.targetWidth,
        targetHeight: geometry.targetHeight,
        contextBytes: new Uint8Array(contextData),
        maskBytes: encodedMask.bytes,
        maskMimeType: encodedMask.mimeType,
        removalFillColor: encodedMask.removalFillColor,
        removalBackgroundUniform: encodedMask.removalBackgroundUniform,
        compositeMaskBytes: encodedMask.compositeBytes,
        compositeMaskMimeType: encodedMask.compositeMimeType,
        selectionChannelName,
        mimeType: "image/png",
      };
    } catch (error) {
      await this.removeSelectionChannel(source, selectionChannelName);
      throw error;
    }
  }

  private async captureSelectionMask(
    document: any,
    cropBounds: SelectionBounds,
    compositeFeatherRadius: number,
  ): Promise<{
    bytes: Uint8Array;
    mimeType: "image/png";
    compositeBytes: Uint8Array;
    compositeMimeType: "image/png";
    removalFillColor: number;
    removalBackgroundUniform: boolean;
  }> {
    const imaging = this.photoshop.imaging;
    if (!imaging?.getSelection) {
      throw new Error("Photoshop Imaging API 不可用，无法导出局部重绘遮罩");
    }
    let imageData: any;
    try {
      const result = await imaging.getSelection({
        documentID: document.id,
        sourceBounds: {
          left: cropBounds.x,
          top: cropBounds.y,
          right: cropBounds.x + cropBounds.width,
          bottom: cropBounds.y + cropBounds.height,
        },
      });
      imageData = result.imageData;
      const sourceBounds = result.sourceBounds;
      if (!imageData || !sourceBounds) {
        throw new Error("Photoshop 未返回选区图像尺寸或 sourceBounds");
      }
      const sourceWidth = Number(imageData.width);
      const sourceHeight = Number(imageData.height);
      const sourceData = await imageData.getData({ chunky: true });
      const pixels = sourceWidth * sourceHeight;
      if (!Number.isInteger(pixels) || pixels <= 0 || sourceData.length % pixels !== 0) {
        throw new Error("Photoshop 返回的选区像素长度与图像尺寸不一致");
      }
      const components = sourceData.length / pixels;
      const grayscale = rasterizeSelectionMask(
        cropBounds,
        {
          left: Number(sourceBounds.left),
          top: Number(sourceBounds.top),
          right: Number(sourceBounds.right),
          bottom: Number(sourceBounds.bottom),
        },
        sourceWidth,
        sourceHeight,
        components,
        sourceData,
      );
      if (!grayscale.some((value) => value > 0)) {
        throw new Error("Photoshop 返回了空的局部重绘选区遮罩");
      }
      return {
        bytes: encodeGrayscalePng(grayscale, cropBounds.width, cropBounds.height),
        mimeType: "image/png",
        compositeBytes: encodeGrayscalePng(
          featherSelectionMask(
            grayscale,
            cropBounds.width,
            cropBounds.height,
            compositeFeatherRadius,
          ),
          cropBounds.width,
          cropBounds.height,
        ),
        compositeMimeType: "image/png",
        ...await this.sampleRemovalFillColor(
          document,
          cropBounds,
          grayscale,
        ),
      };
    } catch (error) {
      throw new Error(`无法导出局部重绘选区遮罩：${(error as Error).message}`);
    } finally {
      imageData?.dispose?.();
    }
  }

  /**
   * Returns a robust RGB fill for the model's removal prefill. Sampling the
   * pixels outside the user's mask keeps the model from seeing a synthetic
   * gray patch while still adapting to white paper, skin, fabric, or another
   * local background. Photoshop versions without getPixels fall back to
   * white, which is safer for the common generative-fill case than gray.
   */
  private async sampleRemovalFillColor(
    document: any,
    cropBounds: SelectionBounds,
    mask: Uint8Array,
  ) {
    const imaging = this.photoshop.imaging;
    if (typeof imaging?.getPixels !== "function") {
      return { removalFillColor: 0xffffff, removalBackgroundUniform: false };
    }
    let imageData: any;
    try {
      const result = await imaging.getPixels({
        documentID: document.id,
        sourceBounds: {
          left: cropBounds.x,
          top: cropBounds.y,
          right: cropBounds.x + cropBounds.width,
          bottom: cropBounds.y + cropBounds.height,
        },
        targetSize: { width: cropBounds.width, height: cropBounds.height },
        colorSpace: "RGB",
        componentSize: 8,
        applyAlpha: true,
      });
      imageData = result?.imageData;
      const width = Number(imageData?.width);
      const height = Number(imageData?.height);
      if (width !== cropBounds.width || height !== cropBounds.height) {
        return { removalFillColor: 0xffffff, removalBackgroundUniform: false };
      }
      const raw = await imageData.getData({ chunky: true });
      const data = raw instanceof Uint8Array
        ? raw
        : new Uint8Array(raw?.buffer ?? raw);
      const pixels = width * height;
      const components = data.length / pixels;
      if (!Number.isInteger(components) || components < 3) {
        return { removalFillColor: 0xffffff, removalBackgroundUniform: false };
      }

      const channels: [number[], number[], number[]] = [[], [], []];
      for (let index = 0; index < pixels; index += 1) {
        if (mask[index] > 0) continue;
        const offset = index * components;
        if (components >= 4 && data[offset + 3] < 16) continue;
        channels[0].push(data[offset]);
        channels[1].push(data[offset + 1]);
        channels[2].push(data[offset + 2]);
      }
      if (!channels[0].length) {
        return { removalFillColor: 0xffffff, removalBackgroundUniform: false };
      }
      const median = (values: number[]) => {
        values.sort((left, right) => left - right);
        return values[Math.floor(values.length / 2)];
      };
      const red = median(channels[0]);
      const green = median(channels[1]);
      const blue = median(channels[2]);
      const nearMedian = channels[0].reduce((count, value, index) => (
        count
        + (Math.max(
          Math.abs(value - red),
          Math.abs(channels[1][index] - green),
          Math.abs(channels[2][index] - blue),
        ) <= 12 ? 1 : 0)
      ), 0);
      const lightNeutral = Math.min(red, green, blue) >= 205
        && Math.max(red, green, blue) - Math.min(red, green, blue) <= 20;
      let boundarySamples = 0;
      let boundaryNonLight = 0;
      const isNearSelection = (x: number, y: number) => {
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const nearX = x + dx;
            const nearY = y + dy;
            if (
              nearX >= 0
              && nearX < width
              && nearY >= 0
              && nearY < height
              && mask[nearY * width + nearX] > 0
            ) return true;
          }
        }
        return false;
      };
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = y * width + x;
          if (mask[index] > 0 || !isNearSelection(x, y)) continue;
          const offset = index * components;
          boundarySamples += 1;
          if (
            Math.min(data[offset], data[offset + 1], data[offset + 2]) < 190
            || Math.max(data[offset], data[offset + 1], data[offset + 2])
              - Math.min(data[offset], data[offset + 1], data[offset + 2]) > 28
          ) {
            boundaryNonLight += 1;
          }
        }
      }
      const boundaryUniform = boundarySamples === 0
        || boundaryNonLight / boundarySamples <= 0.03;
      return {
        removalFillColor: (red << 16) | (green << 8) | blue,
        removalBackgroundUniform: lightNeutral
          && nearMedian / channels[0].length >= 0.6
          && boundaryUniform,
      };
    } catch {
      return { removalFillColor: 0xffffff, removalBackgroundUniform: false };
    } finally {
      imageData?.dispose?.();
    }
  }

  async insertIntoCurrentDocument(
    assets: GeneratedImageAsset[],
    documentId?: string,
    selection?: SelectionBounds | SelectionSnapshot | null,
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
    if (
      selection
      && "selectionBounds" in selection
      && (
        Number(document.width) !== selection.documentWidth
        || Number(document.height) !== selection.documentHeight
      )
    ) {
      throw new Error("生成期间 Photoshop 文档尺寸已变化，已拒绝写入");
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
        if (selection) {
          await this.fitAndMaskLayer(document, layer, selection, owner);
        }
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
    } finally {
      if (selection && "selectionChannelName" in selection && selection.selectionChannelName) {
        await this.removeSelectionChannel(document, selection.selectionChannelName);
      }
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
        const openedBackground = document.activeLayers[0] ?? document.layers[0];
        if (!openedBackground) throw new Error("Photoshop 未返回新文档图层");
        await this.photoshop.action.batchPlay([{
          _obj: "set",
          _target: openedBackground.id
            ? [{ _ref: "layer", _id: openedBackground.id }]
            : [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
          to: {
            _obj: "layer",
            name: assets[0].layerName ?? assets[0].id,
            opacity: { _unit: "percentUnit", _value: 100 },
            mode: { _enum: "blendMode", _value: "normal" },
          },
          _options: { dialogOptions: "dontDisplay" },
        }], { synchronousExecution: true, modalBehavior: "execute" });
        openedBackground.visible = true;
        if (openedBackground.id !== undefined) layerIds.push(String(openedBackground.id));
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

  async cleanupSelectionChannel(documentId: string, channelName: string) {
    if (!channelName.startsWith("ps-fill-selection-")) return;
    const document = this.photoshop.app.documents.find((item: any) => String(item.id) === documentId);
    if (document) await this.removeSelectionChannel(document, channelName);
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

  private async fitAndMaskLayer(
    document: any,
    layer: any,
    selectionInput: SelectionBounds | SelectionSnapshot,
    owner?: AssetOwner,
  ) {
    const snapshot: SelectionSnapshot | null = "selectionBounds" in selectionInput
      ? selectionInput
      : null;
    const selection: SelectionBounds = snapshot
      ? snapshot.selectionBounds
      : selectionInput as SelectionBounds;
    const placement = snapshot?.cropBounds ?? selection;
    const number = (item: unknown) => Number(
      typeof item === "object" && item && "value" in item
        ? (item as { value: unknown }).value
        : typeof item === "object" && item && "_value" in item
          ? (item as { _value: unknown })._value
        : item,
    );
    const readNumbers = async () => {
      const bounds = await this.readLayerBounds(layer);
      const left = number(bounds.left);
      const top = number(bounds.top);
      const right = number(bounds.right);
      const bottom = number(bounds.bottom);
      const width = right - left;
      const height = bottom - top;
      if (
        ![left, top, right, bottom, width, height].every(Number.isFinite)
        || width <= 0
        || height <= 0
      ) {
        throw new Error("无法读取生成图层尺寸");
      }
      return { left, top, right, bottom, width, height };
    };
    const selectLayer = async () => {
      await this.photoshop.action.batchPlay([{
        _obj: "select",
        _target: [{ _ref: "layer", _id: layer.id }],
        makeVisible: false,
        _options: { dialogOptions: "dontDisplay" },
      }], { synchronousExecution: true, modalBehavior: "execute" });
    };
    let current = await readNumbers();
    const targetAspect = placement.width / placement.height;
    const placedAspect = current.width / current.height;
    const aspectError = Math.abs(placedAspect / targetAspect - 1);
    if (aspectError > 0.001) {
      throw new Error("生成图片比例与原始裁剪区域不一致，已拒绝非等比拉伸");
    }
    for (let pass = 0; pass < 4; pass += 1) {
      const scaleX = placement.width / current.width * 100;
      const scaleY = placement.height / current.height * 100;
      const uniformScale = (scaleX + scaleY) / 2;
      if (Math.abs(uniformScale - 100) > 0.01) {
        await selectLayer();
        await layer.scale(
          uniformScale,
          uniformScale,
          this.photoshop.constants.AnchorPosition.TOPLEFT,
        );
        current = await readNumbers();
      }
      const translateX = placement.x - current.left;
      const translateY = placement.y - current.top;
      if (Math.abs(translateX) > 0.01 || Math.abs(translateY) > 0.01) {
        await selectLayer();
        await layer.translate(translateX, translateY);
        current = await readNumbers();
      }
      const edgeError = Math.max(
        Math.abs(current.left - placement.x),
        Math.abs(current.top - placement.y),
        Math.abs(current.right - (placement.x + placement.width)),
        Math.abs(current.bottom - (placement.y + placement.height)),
      );
      if (edgeError <= 0.5) break;
      if (pass === 3) throw new Error("无法校正生成图层位置");
    }

    const previousSelection = this.selectionBounds(document);
    let snapshotSelectionLoaded = false;
    try {
      if (snapshot) {
        await this.loadSnapshotSelection(document, layer, snapshot, owner);
        snapshotSelectionLoaded = true;
      } else {
        await document.selection.selectRectangle({
          left: selection.x,
          top: selection.y,
          right: selection.x + selection.width,
          bottom: selection.y + selection.height,
        });
      }
      await this.photoshop.action.batchPlay([
        {
          _obj: "select",
          _target: [{ _ref: "layer", _id: layer.id }],
          makeVisible: false,
          _options: { dialogOptions: "dontDisplay" },
        },
        {
          _obj: "make",
          new: { _class: "channel" },
          at: { _ref: "channel", _enum: "channel", _value: "mask" },
          using: { _enum: "userMaskEnabled", _value: "revealSelection" },
          _options: { dialogOptions: "dontDisplay" },
        },
      ], { synchronousExecution: true, modalBehavior: "execute" });
      // The local Klein workflow already composites a native-resolution mask
      // that fades only toward the inside of the original selection. Applying
      // Photoshop's symmetric user-mask feather here would bleed generated
      // pixels outside that selection and break pixel-precise writeback.
    } finally {
      // Snapshot insertion leaves the exact arbitrary selection loaded from
      // the original PNG in place. Replacing it with its bounding rectangle
      // would silently destroy the user's lasso/brush shape.
      if (!snapshot || !snapshotSelectionLoaded) {
        if (previousSelection) {
          await document.selection.selectRectangle({
            left: previousSelection.x,
            top: previousSelection.y,
            right: previousSelection.x + previousSelection.width,
            bottom: previousSelection.y + previousSelection.height,
          });
        } else {
          await document.selection.deselect();
        }
      }
    }
  }

  private async loadSnapshotSelection(
    document: any,
    generatedLayer: any,
    snapshot: SelectionSnapshot,
    owner?: AssetOwner,
  ) {
    if (snapshot.selectionChannelName) {
      const channel = this.findChannel(document, snapshot.selectionChannelName);
      if (!channel) throw new Error("Photoshop 局部重绘选区通道已丢失");
      await document.selection.load(channel);
      await this.photoshop.action.batchPlay([{
        _obj: "select",
        _target: [{ _ref: "layer", _id: generatedLayer.id }],
        makeVisible: false,
        _options: { dialogOptions: "dontDisplay" },
      }], { synchronousExecution: true, modalBehavior: "execute" });
      return;
    }

    const [maskFile] = await this.writeTemporaryFiles([{
      id: `selection-mask-${Date.now()}`,
      bytes: snapshot.maskBytes,
      mimeType: "image/png",
      layerName: "Klein Selection Mask",
    }], owner);
    const maskLayer = await this.placeFile(document, maskFile, "Klein Selection Mask", true);
    const number = (item: unknown) => Number(
      typeof item === "object" && item && "value" in item
        ? (item as { value: unknown }).value
        : typeof item === "object" && item && "_value" in item
          ? (item as { _value: unknown })._value
        : item,
    );
    const bounds = await this.readLayerBounds(maskLayer);
    const width = number(bounds.right) - number(bounds.left);
    const height = number(bounds.bottom) - number(bounds.top);
    await maskLayer.scale(
      snapshot.cropBounds.width / width * 100,
      snapshot.cropBounds.height / height * 100,
      this.photoshop.constants.AnchorPosition.TOPLEFT,
    );
    const scaled = await this.readLayerBounds(maskLayer);
    await maskLayer.translate(
      snapshot.cropBounds.x - number(scaled.left),
      snapshot.cropBounds.y - number(scaled.top),
    );
    await this.photoshop.action.batchPlay([
      {
        _obj: "set",
        _target: [{ _ref: "channel", _property: "selection" }],
        to: { _ref: "channel", _enum: "channel", _value: "transparencyEnum" },
        _options: { dialogOptions: "dontDisplay" },
      },
      {
        _obj: "delete",
        _target: [{ _ref: "layer", _id: maskLayer.id }],
        _options: { dialogOptions: "dontDisplay" },
      },
      {
        _obj: "select",
        _target: [{ _ref: "layer", _id: generatedLayer.id }],
        makeVisible: false,
        _options: { dialogOptions: "dontDisplay" },
      },
    ], { synchronousExecution: false, modalBehavior: "execute" });
  }

  private async readLayerBounds(layer: any) {
    const fallback = layer.boundsNoEffects ?? layer.bounds;
    if (layer.id === undefined) return fallback;
    try {
      const result = await this.photoshop.action.batchPlay([{
        _obj: "get",
        _target: [{ _ref: "layer", _id: layer.id }],
        _options: { dialogOptions: "dontDisplay" },
      }], { synchronousExecution: true, modalBehavior: "execute" });
      return result?.[0]?.bounds ?? fallback;
    } catch {
      return fallback;
    }
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

  private findChannel(document: any, name: string) {
    const channels = document.channels;
    if (!channels) return undefined;
    return Array.from(channels as any[]).find(
      (channel: any) => String(channel.name) === name,
    );
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

  private async removeSelectionChannel(document: any, name: string) {
    try {
      const channel = this.findChannel(document, name);
      if (channel?.remove) await channel.remove();
    } catch {
      // Best-effort cleanup must not hide a successful writeback.
    }
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
