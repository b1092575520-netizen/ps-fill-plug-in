import type {
  OutputTarget,
  PhotoshopContext,
} from "../types";
import type { AssetOwner } from "../assetLifecycleManager";
import type { RemoteRequestAudit } from "../remoteRequestLedger";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  model: string;
  size?: string;
  quality?: "low" | "medium" | "high";
  imageUrls?: string[];
  n: number;
  responseFormat: "url";
  audit?: RemoteRequestAudit;
}

export interface ReferenceUploader {
  upload(file: Blob, fileName: string, signal: AbortSignal): Promise<string>;
}

export interface GeneratedImageAsset {
  id: string;
  bytes: Uint8Array;
  mimeType: string;
  layerName?: string;
}

export interface PhotoshopPreviewSession {
  documentId: string;
  layerIds: string[];
}

export type ReferenceCaptureScope = "document" | "selection";

export interface CapturedReference {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export interface CredentialStore {
  loadApiKey(): Promise<string>;
  saveApiKey(apiKey: string): Promise<void>;
  deleteApiKey(): Promise<void>;
}

export interface PhotoshopRuntime {
  getContext(): Promise<PhotoshopContext>;
  /**
   * Returns all open document IDs when the host exposes an enumerable
   * document collection. `null` means that enumeration is temporarily
   * unavailable; callers must not interpret it as an empty collection.
   */
  getOpenDocumentIds?(): Promise<string[] | null>;
  executeAsModal(operation: () => Promise<void>, name: string): Promise<void>;
  captureVisibleComposite(
    scope: ReferenceCaptureScope,
    documentId?: string,
    owner?: AssetOwner,
  ): Promise<CapturedReference>;
  insertIntoCurrentDocument(
    assets: GeneratedImageAsset[],
    documentId?: string,
    owner?: AssetOwner,
  ): Promise<string[]>;
  createDocumentFromImages(assets: GeneratedImageAsset[], owner?: AssetOwner): Promise<string[]>;
  setPreviewLayer(documentId: string, layerIds: string[], activeLayerId: string): Promise<void>;
  discardPreviewLayers(documentId: string, layerIds: string[], keepLayerId?: string): Promise<void>;
  cleanupTemporaryFiles(owner?: AssetOwner): Promise<void>;
  cleanupPluginResiduals?(): Promise<void>;
}

export interface PhotoshopWriter {
  getContext(): Promise<PhotoshopContext>;
  getOpenDocumentIds?(): Promise<string[] | null>;
  captureReference(
    scope: ReferenceCaptureScope,
    documentId?: string,
    owner?: AssetOwner,
  ): Promise<CapturedReference>;
  insert(
    assets: GeneratedImageAsset[],
    target: OutputTarget,
    documentId?: string,
    owner?: AssetOwner,
  ): Promise<PhotoshopPreviewSession>;
  preview(
    session: PhotoshopPreviewSession,
    activeLayerId: string,
  ): Promise<void>;
  discardPreview(
    session: PhotoshopPreviewSession,
    keepLayerId?: string,
  ): Promise<void>;
  cleanupPluginResiduals(): Promise<void>;
}
