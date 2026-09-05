import type { RefObject } from "react";

export interface VisionRect { x: number; y: number; width: number; height: number }
export type VisionCropPreset = "full" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
export interface VisionLabSettings {
  crop: VisionCropPreset;
  fromMs: number;
  toMs: number;
  sampleFps: 2 | 5 | 10;
  similarityThreshold: number;
}
export interface VisionGateProfile {
  schemaVersion: 1;
  id: string;
  revision: number;
  name: string;
  image: Blob;
  imageSha256: string;
  rect: VisionRect;
  createdAt: string;
}
export interface VisionVideoIdentity {
  name: string;
  size: number;
  lastModified: number;
  sha256: string;
  durationMs: number;
  width: number;
  height: number;
}
export interface VisionCandidate {
  id: string;
  timeMs: number;
  startMs: number;
  endMs: number;
  similarity: number;
  box: VisionRect;
  reason: string;
}
export interface VisionReview {
  id: string;
  eventId: string;
  action: "confirm" | "reject" | "adjust" | "add";
  timeMs: number;
  reason: string;
  createdAt: string;
}
export interface VisionGap { startMs: number; endMs: number; reason: string }
export interface VisionTimingRun {
  schemaVersion: 1;
  pipelineVersion: "reference-motion-v1";
  timestampSource: "video_seek_position";
  provenance: "local" | "imported";
  id: string;
  createdAt: string;
  profile: Omit<VisionGateProfile, "image">;
  video: VisionVideoIdentity;
  settings: VisionLabSettings;
  model: { id: string; revision: string; weightsSha256: string; backend: string };
  state: "analyzing" | "complete" | "cancelled" | "failed";
  analyzedUntilMs: number;
  analyzedFrames: number;
  candidates: VisionCandidate[];
  reviews: VisionReview[];
  gaps: VisionGap[];
}
export interface VisionResolvedEvent {
  id: string;
  timeMs: number;
  startMs: number;
  endMs: number;
  status: "pending" | "confirmed" | "rejected";
  origin: "model" | "manual";
  similarity: number | null;
  reason: string;
}
export interface VisionLap {
  id: string;
  number: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: "reviewed" | "incomplete";
  reason: string | null;
}
export interface VisionProfileSummary { id: string; name: string; revision: number; createdAt: string }
export interface VisionRunSummary { id: string; gateName: string; videoName: string; createdAt: string; state: VisionTimingRun["state"] }
export interface VisionLabController {
  videoRef: RefObject<HTMLVideoElement | null>;
  video: (VisionVideoIdentity & { url: string }) | null;
  reference: { url: string; rect: VisionRect } | null;
  gateName: string;
  setGateName: (name: string) => void;
  setReferenceRect: (rect: VisionRect) => void;
  settings: VisionLabSettings;
  updateSettings: (settings: Partial<VisionLabSettings>) => void;
  importVideo: (file: File) => Promise<void>;
  importReference: (file: File) => Promise<void>;
  captureReference: () => Promise<void>;
  status: "idle" | "loading" | "analyzing" | "cancelled" | "complete" | "error";
  busy: boolean;
  progress: { completed: number; total: number; timeMs: number; message: string };
  canAnalyze: boolean;
  analyze: () => Promise<void>;
  cancel: () => void;
  error: string | null;
  notice: string | null;
  run: VisionTimingRun | null;
  events: VisionResolvedEvent[];
  laps: VisionLap[];
  reviewEvent: (eventId: string, action: "confirm" | "reject" | "adjust", timeMs: number, reason: string) => Promise<void>;
  addEvent: (timeMs: number, reason: string) => Promise<void>;
  profiles: VisionProfileSummary[];
  savedRuns: VisionRunSummary[];
  saveProfile: () => Promise<void>;
  loadProfile: (id: string) => Promise<void>;
  exportProfile: () => Promise<void>;
  importProfile: (file: File) => Promise<void>;
  saveRun: () => Promise<void>;
  loadRun: (id: string) => Promise<void>;
  exportRun: (format: "json" | "csv") => Promise<void>;
  importRun: (file: File) => Promise<void>;
}
