export type ManagedAssetKind =
  | "candidate-bytes"
  | "blob-url"
  | "temporary-file"
  | "upload-result"
  | "selection-channel"
  | "preview-layer";

export interface AssetOwner {
  documentId: string;
  jobId: string;
  revision: number;
  ownerPrefix: string;
}

export interface ImageLimits {
  maxCandidates: number;
  maxImageBytes: number;
  maxPixels: number;
  maxDimension: number;
}

export interface ImageMeasurement {
  bytes: number;
  width: number;
  height: number;
}

export function measureImageBytes(bytes: Uint8Array): ImageMeasurement {
  let width = 0;
  let height = 0;
  if (bytes.length >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        break;
      }
      offset += length + 2;
    }
  }
  if (!width || !height) throw new Error("无法读取候选图片解码尺寸");
  return { bytes: bytes.byteLength, width, height };
}

interface ManagedAsset {
  id: string;
  kind: ManagedAssetKind;
  owner: AssetOwner;
  bytes: number;
  cleanup: () => void | Promise<void>;
}

export interface AssetLifecycleStats {
  resources: number;
  candidateBytes: number;
  blobUrls: number;
  temporaryFiles: number;
  uploads: number;
  selectionChannels: number;
  previewLayers: number;
}

// Uploaded references expire on the host after one hour; stop reusing a
// cached URL well before that so a later task never points at a deleted file.
const UPLOAD_REUSE_MS = 45 * 60 * 1000;

const DEFAULT_LIMITS: ImageLimits = {
  maxCandidates: 4,
  maxImageBytes: 32 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxDimension: 16_384,
};

export class AssetLifecycleManager {
  private readonly assets = new Map<string, ManagedAsset>();
  private readonly uploadCache = new Map<string, { url: Promise<string>; uploadedAt: number }>();
  private readonly limits: ImageLimits;

  constructor(
    limits: Partial<ImageLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  assertCandidateCount(count: number) {
    if (!Number.isInteger(count) || count < 1 || count > this.limits.maxCandidates) {
      throw new Error(`候选数量必须在 1-${this.limits.maxCandidates} 张之间`);
    }
  }

  assertImage(image: ImageMeasurement) {
    if (image.bytes > this.limits.maxImageBytes) throw new Error("候选图片字节数超过安全上限");
    if (image.width > this.limits.maxDimension || image.height > this.limits.maxDimension) {
      throw new Error("候选图片解码尺寸超过安全上限");
    }
    if (image.width * image.height > this.limits.maxPixels) throw new Error("候选图片像素数超过安全上限");
  }

  register(
    id: string,
    kind: ManagedAssetKind,
    owner: AssetOwner,
    cleanup: () => void | Promise<void> = () => undefined,
    bytes = 0,
  ) {
    this.assertOwned(id, owner.ownerPrefix);
    const key = this.key(owner, kind, id);
    if (this.assets.has(key)) return;
    this.assets.set(key, { id, kind, owner: { ...owner }, bytes, cleanup });
  }

  registerBytes(id: string, owner: AssetOwner, holder: { bytes: Uint8Array }) {
    this.register(id, "candidate-bytes", owner, () => {
      holder.bytes = new Uint8Array(0);
    }, holder.bytes.byteLength);
  }

  reuseUpload(documentId: string, fingerprint: string, upload: () => Promise<string>) {
    const key = `${documentId}\u0000${fingerprint}`;
    const existing = this.uploadCache.get(key);
    if (existing && existing.uploadedAt >= this.now() - UPLOAD_REUSE_MS) return existing.url;
    const entry = {
      uploadedAt: this.now(),
      url: upload().catch((error) => {
        if (this.uploadCache.get(key) === entry) this.uploadCache.delete(key);
        throw error;
      }),
    };
    this.uploadCache.set(key, entry);
    return entry.url;
  }

  cleanupJob(documentId: string, jobId: string, revision?: number) {
    return this.cleanup((asset) => asset.owner.documentId === documentId
      && asset.owner.jobId === jobId
      && (revision === undefined || asset.owner.revision === revision));
  }

  cleanupResource(documentId: string, kind: ManagedAssetKind, id: string) {
    return this.cleanup((asset) => asset.owner.documentId === documentId
      && asset.kind === kind
      && asset.id === id);
  }

  async cleanupDocument(documentId: string) {
    await this.cleanup((asset) => asset.owner.documentId === documentId);
    for (const key of Array.from(this.uploadCache.keys())) {
      if (key.startsWith(`${documentId}\u0000`)) this.uploadCache.delete(key);
    }
  }

  async cleanupAll() {
    await this.cleanup(() => true);
    this.uploadCache.clear();
  }

  stats(documentId?: string): AssetLifecycleStats {
    const assets = Array.from(this.assets.values()).filter((asset) => (
      documentId === undefined || asset.owner.documentId === documentId
    ));
    return {
      resources: assets.length,
      candidateBytes: assets.reduce((total, asset) => total + (asset.kind === "candidate-bytes" ? asset.bytes : 0), 0),
      blobUrls: assets.filter((asset) => asset.kind === "blob-url").length,
      temporaryFiles: assets.filter((asset) => asset.kind === "temporary-file").length,
      uploads: assets.filter((asset) => asset.kind === "upload-result").length,
      selectionChannels: assets.filter((asset) => asset.kind === "selection-channel").length,
      previewLayers: assets.filter((asset) => asset.kind === "preview-layer").length,
    };
  }

  private async cleanup(predicate: (asset: ManagedAsset) => boolean) {
    const matches = Array.from(this.assets.entries()).filter(([, asset]) => predicate(asset));
    for (const [key] of matches) this.assets.delete(key);
    await Promise.allSettled(matches.map(([, asset]) => Promise.resolve().then(asset.cleanup)));
  }

  private assertOwned(id: string, ownerPrefix: string) {
    if (!ownerPrefix.trim() || !id.startsWith(`${ownerPrefix}-`)) {
      throw new Error("资源缺少可证明归属的所有者前缀");
    }
  }

  private key(owner: AssetOwner, kind: ManagedAssetKind, id: string) {
    return `${owner.documentId}\u0000${owner.jobId}\u0000${owner.revision}\u0000${kind}\u0000${id}`;
  }
}
