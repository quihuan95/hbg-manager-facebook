/** Implementation contract, not a connected production adapter. */
export type JobStatus = 'SOURCE_READY' | 'GENERATING' | 'VALIDATING' |
  'WAITING_APPROVAL' | 'NEEDS_REVIEW' | 'APPROVED' | 'SCHEDULED' |
  'PUBLISHING' | 'PUBLISH_UNKNOWN' | 'PUBLISHED' | 'CANCELLED';
export interface Fact { id: string; text: string; sourceFileId: string }
export interface SourceAsset {
  fileId: string; role: 'reference_photo' | 'brand_logo' | 'background' | 'font';
  mime: string; checksum: string;
}
export interface SourceSnapshot {
  topicId: string; topicRevision: string; ruleVersionId: string;
  ruleHash: string; facts: Fact[]; assets: SourceAsset[];
}
export interface GenerationInput {
  jobId: string; profileId: string; snapshot: SourceSnapshot;
  topic: string; audience: string; language: 'vi' | 'en' | 'vi-en';
  ruleModules: Record<string, unknown>;
}
export interface CaptionResult {
  caption: string; headline: string; cta: string; imageBrief: string;
  usedFactIds: string[]; uncertaintyFlags: string[];
  providerRequestId?: string; usage?: Record<string, number>;
}
export interface ImageResult {
  objectKey: string; mime: string; width: number; height: number;
  checksum: string; providerRequestId?: string;
}
export interface Approval {
  revisionId: string; payloadHash: string; targetPageId: string;
  approvedBy: string; approvedAt: string;
}
export type PublishResult =
  | { kind: 'confirmed'; remoteId: string; permalink?: string }
  | { kind: 'not_dispatched'; code: string; retryable: boolean }
  | { kind: 'unknown'; attemptId: string; reason: string };
export interface TextAdapter { generate(input: GenerationInput): Promise<CaptionResult> }
export interface ImageAdapter {
  generate(input: GenerationInput, caption: CaptionResult): Promise<ImageResult>;
}
export interface PublisherAdapter {
  publish(input: {
    attemptId: string; targetPageId: string; caption: string;
    imageObjectKey: string; payloadHash: string;
  }): Promise<PublishResult>;
}
/** These are application proposals. Provider capability checks are mandatory. */
export const DEFAULT_POLICY = {
  timezone: 'Asia/Ho_Chi_Minh', maxStageAttempts: 3,
  generationConcurrencyPerProfile: 1, latePublishWindowMinutes: 30,
  manualApprovalRequired: true, retryUnknownPublish: false,
} as const;
