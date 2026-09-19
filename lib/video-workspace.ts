import type { BetaflightDeviceNames } from "./betaflight-device-name";

export const VIDEO_WORKSPACE_SCHEMA_VERSION = 2;
export const VIDEO_WORKSPACE_STORAGE_KEY = "fpvhelper.video-workspace.v2";
export const LEGACY_VIDEO_WORKSPACE_STORAGE_KEY = "fpvhelper.video-workspace.v1";

export type VideoSourceLayout = "full" | "quad";
export type PilotVideoViewMode = "source-default" | "full" | "crop";

export interface VideoCropRect {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
}

export type VideoCropInteraction = "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se";

export interface VideoSourceConfig {
  id: string;
  label: string;
  deviceId: string;
  layout: VideoSourceLayout;
}

export interface PilotChannelConfig {
  id: string;
  sourceId: string;
  slot: 0 | 1 | 2 | 3;
  athleteCode: string;
  athleteCodeMode: "auto" | "manual";
  gateProfileId: string | null;
  videoProfileId: string | null;
  viewMode: PilotVideoViewMode;
  crop: VideoCropRect;
}

export interface VideoViewport {
  id: string;
  sourceId: string;
  pilotChannelId: string;
  label: string;
  crop: VideoCropRect;
}

export interface VideoWorkspaceConfig {
  schemaVersion: typeof VIDEO_WORKSPACE_SCHEMA_VERSION;
  sources: VideoSourceConfig[];
  pilotChannels: PilotChannelConfig[];
  activeSourceId: string;
  activePilotChannelId: string;
  // Missing in older saved workspaces, whose visible channels stay unchanged.
  addedPilotChannelIds?: string[];
}

interface VideoWorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const FULL_CROP: VideoCropRect = {
  xPercent: 0,
  yPercent: 0,
  widthPercent: 100,
  heightPercent: 100,
};

const QUAD_CROPS: readonly VideoCropRect[] = [
  { xPercent: 0, yPercent: 0, widthPercent: 50, heightPercent: 50 },
  { xPercent: 50, yPercent: 0, widthPercent: 50, heightPercent: 50 },
  { xPercent: 0, yPercent: 50, widthPercent: 50, heightPercent: 50 },
  { xPercent: 50, yPercent: 50, widthPercent: 50, heightPercent: 50 },
];

const MIN_CROP_PERCENT = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceId(index: number) {
  return `video-source-${index}`;
}

function pilotChannelId(source: string, slot: number) {
  return `${source}-pilot-${slot + 1}`;
}

function defaultCropForSlot(layout: VideoSourceLayout, slot: 0 | 1 | 2 | 3) {
  if (layout === "full" && slot === 0) return { ...FULL_CROP };
  return { ...QUAD_CROPS[slot] };
}

function createPilotChannels(source: string, layout: VideoSourceLayout = "full"): PilotChannelConfig[] {
  return ([0, 1, 2, 3] as const).map((slot) => ({
    id: pilotChannelId(source, slot),
    sourceId: source,
    slot,
    athleteCode: "",
    athleteCodeMode: "auto",
    gateProfileId: null,
    videoProfileId: null,
    viewMode: "source-default",
    crop: defaultCropForSlot(layout, slot),
  }));
}

function finitePercent(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeVideoCrop(crop: Partial<VideoCropRect>, fallback: VideoCropRect = FULL_CROP): VideoCropRect {
  const xCandidate = finitePercent(crop.xPercent, fallback.xPercent);
  const yCandidate = finitePercent(crop.yPercent, fallback.yPercent);
  const xPercent = Math.min(100 - MIN_CROP_PERCENT, Math.max(0, xCandidate));
  const yPercent = Math.min(100 - MIN_CROP_PERCENT, Math.max(0, yCandidate));
  const widthCandidate = finitePercent(crop.widthPercent, fallback.widthPercent);
  const heightCandidate = finitePercent(crop.heightPercent, fallback.heightPercent);
  return {
    xPercent,
    yPercent,
    widthPercent: Math.min(100 - xPercent, Math.max(MIN_CROP_PERCENT, widthCandidate)),
    heightPercent: Math.min(100 - yPercent, Math.max(MIN_CROP_PERCENT, heightCandidate)),
  };
}

export function suggestedPilotCrop(source: VideoSourceConfig, channel: PilotChannelConfig) {
  return defaultCropForSlot(source.layout, channel.slot);
}

export function resolvedPilotVideoViewMode(
  source: VideoSourceConfig,
  channel: PilotChannelConfig,
): Exclude<PilotVideoViewMode, "source-default"> {
  if (channel.viewMode !== "source-default") return channel.viewMode;
  return source.layout === "quad" ? "crop" : "full";
}

export function createDefaultVideoWorkspace(): VideoWorkspaceConfig {
  const source = sourceId(1);
  const pilotChannels = createPilotChannels(source, "full");
  return {
    schemaVersion: VIDEO_WORKSPACE_SCHEMA_VERSION,
    sources: [{ id: source, label: "视频输入 1", deviceId: "", layout: "full" }],
    pilotChannels,
    activeSourceId: source,
    activePilotChannelId: pilotChannels[0].id,
    addedPilotChannelIds: [],
  };
}

export function activeVideoSource(workspace: VideoWorkspaceConfig) {
  return workspace.sources.find((source) => source.id === workspace.activeSourceId) ?? workspace.sources[0];
}

export function activePilotChannel(workspace: VideoWorkspaceConfig) {
  return workspace.pilotChannels.find((channel) => channel.id === workspace.activePilotChannelId)
    ?? workspace.pilotChannels.find((channel) => channel.sourceId === workspace.activeSourceId && channel.slot === 0)
    ?? workspace.pilotChannels[0];
}

export function videoViewportsForSource(
  workspace: VideoWorkspaceConfig,
  source: VideoSourceConfig,
): VideoViewport[] {
  const sourceChannels = workspace.pilotChannels
    .filter((channel) => channel.sourceId === source.id)
    .sort((left, right) => left.slot - right.slot);
  const channels = workspace.addedPilotChannelIds
    ? sourceChannels.filter((channel) => workspace.addedPilotChannelIds!.includes(channel.id))
    : source.layout === "quad" ? sourceChannels : sourceChannels.slice(0, 1);

  return channels.map((channel, index) => ({
    id: `${source.id}-viewport-${channel.slot + 1}`,
    sourceId: source.id,
    pilotChannelId: channel.id,
    label: source.layout === "quad" ? `选手 ${channel.slot + 1}` : "选手画面",
    crop: resolvedPilotVideoViewMode(source, channel) === "crop"
      ? normalizeVideoCrop(channel.crop, QUAD_CROPS[index] ?? FULL_CROP)
      : { ...FULL_CROP },
  }));
}

export function activeVideoViewport(workspace: VideoWorkspaceConfig) {
  const source = activeVideoSource(workspace);
  if (!source) return null;
  const viewports = videoViewportsForSource(workspace, source);
  return viewports.find((viewport) => viewport.pilotChannelId === workspace.activePilotChannelId) ?? viewports[0] ?? null;
}

export function selectVideoSource(workspace: VideoWorkspaceConfig, selectedSourceId: string) {
  if (selectedSourceId === workspace.activeSourceId) return workspace;
  if (!workspace.sources.some((source) => source.id === selectedSourceId)) return workspace;
  const firstChannel = workspace.pilotChannels.find(
    (channel) => channel.sourceId === selectedSourceId && workspace.addedPilotChannelIds?.includes(channel.id),
  ) ?? workspace.pilotChannels.find((channel) => channel.sourceId === selectedSourceId && channel.slot === 0);
  if (!firstChannel) return workspace;
  return { ...workspace, activeSourceId: selectedSourceId, activePilotChannelId: firstChannel.id };
}

export function selectPilotChannel(workspace: VideoWorkspaceConfig, selectedChannelId: string) {
  const source = activeVideoSource(workspace);
  const channel = workspace.pilotChannels.find((candidate) => candidate.id === selectedChannelId);
  if (!source || !channel || channel.sourceId !== source.id) return workspace;
  if (workspace.addedPilotChannelIds) {
    if (!workspace.addedPilotChannelIds.includes(channel.id)) return workspace;
  } else if (source.layout === "full" && channel.slot !== 0) return workspace;
  return { ...workspace, activePilotChannelId: channel.id };
}

export function setVideoSourceLayout(
  workspace: VideoWorkspaceConfig,
  selectedSourceId: string,
  layout: VideoSourceLayout,
) {
  if (layout !== "full" && layout !== "quad") return workspace;
  const sources = workspace.sources.map((source) => source.id === selectedSourceId ? { ...source, layout } : source);
  if (sources.every((source, index) => source === workspace.sources[index])) return workspace;
  const activeChannel = activePilotChannel(workspace);
  const shouldSelectFirst = !workspace.addedPilotChannelIds && workspace.activeSourceId === selectedSourceId && layout === "full" && activeChannel?.slot !== 0;
  const firstChannel = workspace.pilotChannels.find(
    (channel) => channel.sourceId === selectedSourceId && channel.slot === 0,
  );
  return {
    ...workspace,
    sources,
    pilotChannels: layout === "quad"
      ? workspace.pilotChannels.map((channel) => (
          channel.sourceId === selectedSourceId && channel.viewMode === "source-default"
            ? { ...channel, crop: defaultCropForSlot("quad", channel.slot) }
            : channel
        ))
      : workspace.pilotChannels,
    activePilotChannelId: shouldSelectFirst && firstChannel ? firstChannel.id : workspace.activePilotChannelId,
  };
}

export function setVideoSourceDevice(
  workspace: VideoWorkspaceConfig,
  selectedSourceId: string,
  deviceId: string,
) {
  const safeDeviceId = deviceId.length <= 512 ? deviceId : "";
  return {
    ...workspace,
    sources: workspace.sources.map((source) => source.id === selectedSourceId
      ? { ...source, deviceId: safeDeviceId }
      : source),
  };
}

export function setVideoSourceLabel(
  workspace: VideoWorkspaceConfig,
  selectedSourceId: string,
  label: string,
) {
  return {
    ...workspace,
    sources: workspace.sources.map((source) => source.id === selectedSourceId
      ? { ...source, label: label.slice(0, 40) }
      : source),
  };
}

export function updatePilotChannel(
  workspace: VideoWorkspaceConfig,
  selectedChannelId: string,
  update: Partial<Pick<PilotChannelConfig, "athleteCode" | "gateProfileId" | "videoProfileId">>,
) {
  return {
    ...workspace,
    pilotChannels: workspace.pilotChannels.map((channel) => channel.id === selectedChannelId
      ? {
          ...channel,
          athleteCode: update.athleteCode === undefined ? channel.athleteCode : update.athleteCode.slice(0, 40),
          athleteCodeMode: update.athleteCode === undefined ? channel.athleteCodeMode : "manual" as const,
          gateProfileId: update.gateProfileId === undefined ? channel.gateProfileId : update.gateProfileId,
          videoProfileId: update.videoProfileId === undefined ? channel.videoProfileId : update.videoProfileId,
        }
      : channel),
  };
}

export function setPilotChannelAutomaticName(workspace: VideoWorkspaceConfig, selectedChannelId: string): VideoWorkspaceConfig {
  return {
    ...workspace,
    pilotChannels: workspace.pilotChannels.map((channel) => channel.id === selectedChannelId
      ? { ...channel, athleteCode: "", athleteCodeMode: "auto" }
      : channel),
  };
}

export interface FrozenPilotName {
  pilotChannelId: string;
  athleteCode: string;
}

export function resolveVideoWorkspaceNames(
  workspace: VideoWorkspaceConfig,
  names: Readonly<Record<string, BetaflightDeviceNames>>,
  frozenName: FrozenPilotName | null = null,
): VideoWorkspaceConfig {
  return {
    ...workspace,
    pilotChannels: workspace.pilotChannels.map((channel) => {
      const device = names[channel.id];
      const athleteCode = frozenName?.pilotChannelId === channel.id
        ? frozenName.athleteCode
        : channel.athleteCodeMode === "manual"
          ? channel.athleteCode
          : device?.pilotName.trim() || device?.craftName.trim() || "";
      return athleteCode === channel.athleteCode ? channel : { ...channel, athleteCode };
    }),
  };
}

export function setPilotChannelViewMode(
  workspace: VideoWorkspaceConfig,
  selectedChannelId: string,
  viewMode: Exclude<PilotVideoViewMode, "source-default">,
) {
  if (viewMode !== "full" && viewMode !== "crop") return workspace;
  return {
    ...workspace,
    pilotChannels: workspace.pilotChannels.map((channel) => channel.id === selectedChannelId
      ? { ...channel, viewMode }
      : channel),
  };
}

export function setPilotChannelCrop(
  workspace: VideoWorkspaceConfig,
  selectedChannelId: string,
  crop: Partial<VideoCropRect>,
) {
  return {
    ...workspace,
    pilotChannels: workspace.pilotChannels.map((channel) => channel.id === selectedChannelId
      ? { ...channel, viewMode: "crop" as const, crop: normalizeVideoCrop(crop, channel.crop) }
      : channel),
  };
}

export function resetPilotChannelCrop(
  workspace: VideoWorkspaceConfig,
  selectedChannelId: string,
) {
  const channel = workspace.pilotChannels.find((candidate) => candidate.id === selectedChannelId);
  if (!channel) return workspace;
  const source = workspace.sources.find((candidate) => candidate.id === channel.sourceId);
  if (!source) return workspace;
  return setPilotChannelCrop(workspace, selectedChannelId, suggestedPilotCrop(source, channel));
}

export function addVideoSource(workspace: VideoWorkspaceConfig) {
  const usedIds = new Set(workspace.sources.map((source) => source.id));
  let index = 1;
  while (usedIds.has(sourceId(index))) index += 1;
  const id = sourceId(index);
  const channels = createPilotChannels(id, "full");
  return {
    ...workspace,
    sources: [...workspace.sources, { id, label: `视频输入 ${index}`, deviceId: "", layout: "full" as const }],
    pilotChannels: [...workspace.pilotChannels, ...channels],
    activeSourceId: id,
    activePilotChannelId: channels[0].id,
  };
}

export type PilotPicture = "full" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
export interface AddPilotInput {
  athleteCode: string;
  sourceId: string;
  picture: PilotPicture;
}

export function addedPilotIds(workspace: VideoWorkspaceConfig): string[] {
  return workspace.addedPilotChannelIds ?? workspace.sources.flatMap((source) => (
    videoViewportsForSource(workspace, source).map((viewport) => viewport.pilotChannelId)
  ));
}

export function availablePilotChannels(workspace: VideoWorkspaceConfig, selectedSourceId: string, occupiedPilotIds: readonly string[] = []) {
  const source = workspace.sources.find((candidate) => candidate.id === selectedSourceId);
  if (!source) return [];
  const unavailable = new Set([...addedPilotIds(workspace), ...occupiedPilotIds]);
  return workspace.pilotChannels.filter((channel) => {
    if (channel.sourceId !== source.id || unavailable.has(channel.id)) return false;
    // Legacy layouts can hide configured pilots. Their identity and profiles are not empty slots.
    if (channel.athleteCodeMode === "manual" || channel.athleteCode.trim() || channel.gateProfileId || channel.videoProfileId || channel.viewMode !== "source-default") return false;
    const crop = defaultCropForSlot(source.layout, channel.slot);
    return (Object.keys(crop) as (keyof VideoCropRect)[]).every((key) => channel.crop[key] === crop[key]);
  });
}

export function restorablePilotChannels(workspace: VideoWorkspaceConfig, occupiedPilotIds: readonly string[] = []) {
  const visible = new Set(addedPilotIds(workspace));
  const unused = new Set(workspace.sources.flatMap((source) => availablePilotChannels(workspace, source.id, occupiedPilotIds).map((channel) => channel.id)));
  return workspace.pilotChannels.filter((channel) => !visible.has(channel.id) && !unused.has(channel.id));
}

export function restorePilotToWorkspace(workspace: VideoWorkspaceConfig, selectedChannelId: string, occupiedPilotIds: readonly string[] = []): VideoWorkspaceConfig {
  const channel = restorablePilotChannels(workspace, occupiedPilotIds).find((candidate) => candidate.id === selectedChannelId);
  if (!channel) return workspace;
  return { ...workspace, addedPilotChannelIds: [...addedPilotIds(workspace), channel.id], activeSourceId: channel.sourceId, activePilotChannelId: channel.id };
}

export function addPilotToWorkspace(workspace: VideoWorkspaceConfig, input: AddPilotInput, occupiedPilotIds: readonly string[] = []): VideoWorkspaceConfig {
  const athleteCode = input.athleteCode.trim().slice(0, 40);
  const pictures: PilotPicture[] = ["full", "top-left", "top-right", "bottom-left", "bottom-right"];
  if (!athleteCode || !pictures.includes(input.picture)) return workspace;
  // Capture the old visible set before creating an input, so it cannot add a phantom pilot.
  const added = addedPilotIds(workspace);
  const next = input.sourceId === "new" ? addVideoSource(workspace) : workspace;
  const targetSourceId = input.sourceId === "new" ? next.activeSourceId : input.sourceId;
  const channel = availablePilotChannels({ ...next, addedPilotChannelIds: added }, targetSourceId, occupiedPilotIds)[0];
  if (!channel) return workspace;
  const crop = input.picture === "full" ? FULL_CROP : QUAD_CROPS[pictures.indexOf(input.picture) - 1];
  return {
    ...next,
    addedPilotChannelIds: [...added, channel.id],
    activeSourceId: targetSourceId,
    activePilotChannelId: channel.id,
    pilotChannels: next.pilotChannels.map((candidate) => candidate.id === channel.id ? {
      ...candidate, athleteCode, athleteCodeMode: "manual", viewMode: input.picture === "full" ? "full" : "crop", crop: { ...crop },
    } : candidate),
  };
}

export function removeVideoSource(workspace: VideoWorkspaceConfig, selectedSourceId: string) {
  if (workspace.sources.length <= 1 || !workspace.sources.some((source) => source.id === selectedSourceId)) {
    return workspace;
  }
  const sources = workspace.sources.filter((source) => source.id !== selectedSourceId);
  const pilotChannels = workspace.pilotChannels.filter((channel) => channel.sourceId !== selectedSourceId);
  const addedPilotChannelIds = workspace.addedPilotChannelIds?.filter((id) => pilotChannels.some((channel) => channel.id === id));
  if (workspace.activeSourceId !== selectedSourceId) return { ...workspace, sources, pilotChannels, addedPilotChannelIds };
  const nextSource = sources[0];
  const nextChannel = pilotChannels.find((channel) => channel.sourceId === nextSource.id && channel.slot === 0);
  return {
    ...workspace,
    sources,
    pilotChannels,
    addedPilotChannelIds,
    activeSourceId: nextSource.id,
    activePilotChannelId: nextChannel?.id ?? pilotChannels[0].id,
  };
}

export function videoViewportTransform(viewport: VideoViewport) {
  const { xPercent, yPercent, widthPercent, heightPercent } = viewport.crop;
  return {
    widthPercent: 10_000 / widthPercent,
    heightPercent: 10_000 / heightPercent,
    leftPercent: -(xPercent / widthPercent) * 100,
    topPercent: -(yPercent / heightPercent) * 100,
  };
}

export function videoCropPixelRect(crop: VideoCropRect, sourceWidth: number, sourceHeight: number) {
  const safeWidth = Math.max(1, Math.floor(sourceWidth));
  const safeHeight = Math.max(1, Math.floor(sourceHeight));
  const normalized = normalizeVideoCrop(crop);
  const x = Math.round((normalized.xPercent / 100) * safeWidth);
  const y = Math.round((normalized.yPercent / 100) * safeHeight);
  const right = Math.round(((normalized.xPercent + normalized.widthPercent) / 100) * safeWidth);
  const bottom = Math.round(((normalized.yPercent + normalized.heightPercent) / 100) * safeHeight);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

export function transformVideoCrop(
  crop: VideoCropRect,
  interaction: VideoCropInteraction,
  deltaXPercent: number,
  deltaYPercent: number,
) {
  const normalized = normalizeVideoCrop(crop);
  const left = normalized.xPercent;
  const top = normalized.yPercent;
  const right = left + normalized.widthPercent;
  const bottom = top + normalized.heightPercent;

  if (interaction === "move") {
    return {
      ...normalized,
      xPercent: clampPercent(left + deltaXPercent, 0, 100 - normalized.widthPercent),
      yPercent: clampPercent(top + deltaYPercent, 0, 100 - normalized.heightPercent),
    };
  }

  const nextLeft = interaction === "resize-nw" || interaction === "resize-sw"
    ? clampPercent(left + deltaXPercent, 0, right - MIN_CROP_PERCENT)
    : left;
  const nextRight = interaction === "resize-ne" || interaction === "resize-se"
    ? clampPercent(right + deltaXPercent, left + MIN_CROP_PERCENT, 100)
    : right;
  const nextTop = interaction === "resize-nw" || interaction === "resize-ne"
    ? clampPercent(top + deltaYPercent, 0, bottom - MIN_CROP_PERCENT)
    : top;
  const nextBottom = interaction === "resize-sw" || interaction === "resize-se"
    ? clampPercent(bottom + deltaYPercent, top + MIN_CROP_PERCENT, 100)
    : bottom;

  return {
    xPercent: nextLeft,
    yPercent: nextTop,
    widthPercent: nextRight - nextLeft,
    heightPercent: nextBottom - nextTop,
  };
}

function clampPercent(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function storageErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "浏览器拒绝访问视频工作区设置";
}

function parseWorkspace(value: unknown): VideoWorkspaceConfig | null {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== VIDEO_WORKSPACE_SCHEMA_VERSION)) return null;
  if (!Array.isArray(value.sources) || value.sources.length === 0 || !Array.isArray(value.pilotChannels)) return null;

  const sourceIds = new Set<string>();
  const sources: VideoSourceConfig[] = [];
  for (const rawSource of value.sources) {
    if (!isRecord(rawSource)) return null;
    if (typeof rawSource.id !== "string" || !/^video-source-[1-9]\d*$/.test(rawSource.id) || sourceIds.has(rawSource.id)) return null;
    if (typeof rawSource.label !== "string" || typeof rawSource.deviceId !== "string") return null;
    if (rawSource.layout !== "full" && rawSource.layout !== "quad") return null;
    sourceIds.add(rawSource.id);
    sources.push({
      id: rawSource.id,
      label: rawSource.label.trim().slice(0, 40) || `视频输入 ${sources.length + 1}`,
      deviceId: rawSource.deviceId.length <= 512 ? rawSource.deviceId : "",
      layout: rawSource.layout,
    });
  }

  const savedChannels = new Map<string, PilotChannelConfig>();
  for (const rawChannel of value.pilotChannels) {
    if (!isRecord(rawChannel)) continue;
    if (typeof rawChannel.sourceId !== "string" || !sourceIds.has(rawChannel.sourceId)) continue;
    if (rawChannel.slot !== 0 && rawChannel.slot !== 1 && rawChannel.slot !== 2 && rawChannel.slot !== 3) continue;
    const id = pilotChannelId(rawChannel.sourceId, rawChannel.slot);
    if (savedChannels.has(id)) continue;
    const source = sources.find((candidate) => candidate.id === rawChannel.sourceId);
    if (!source) continue;
    const fallbackCrop = defaultCropForSlot(source.layout, rawChannel.slot);
    const rawCrop = isRecord(rawChannel.crop) ? rawChannel.crop : null;
    const viewMode: PilotVideoViewMode = value.schemaVersion === VIDEO_WORKSPACE_SCHEMA_VERSION
      && (rawChannel.viewMode === "source-default" || rawChannel.viewMode === "full" || rawChannel.viewMode === "crop")
      ? rawChannel.viewMode
      : "source-default";
    const savedAthleteCode = typeof rawChannel.athleteCode === "string" ? rawChannel.athleteCode.slice(0, 40) : "";
    const athleteCodeMode = rawChannel.athleteCodeMode === "auto" || rawChannel.athleteCodeMode === "manual"
      ? rawChannel.athleteCodeMode
      : savedAthleteCode.trim() ? "manual" : "auto";
    savedChannels.set(id, {
      id,
      sourceId: rawChannel.sourceId,
      slot: rawChannel.slot,
      athleteCode: athleteCodeMode === "manual" ? savedAthleteCode : "",
      athleteCodeMode,
      gateProfileId: typeof rawChannel.gateProfileId === "string" ? rawChannel.gateProfileId.slice(0, 120) : null,
      videoProfileId: typeof rawChannel.videoProfileId === "string" ? rawChannel.videoProfileId.slice(0, 120) : null,
      viewMode,
      crop: normalizeVideoCrop(rawCrop ? {
        xPercent: rawCrop.xPercent as number,
        yPercent: rawCrop.yPercent as number,
        widthPercent: rawCrop.widthPercent as number,
        heightPercent: rawCrop.heightPercent as number,
      } : fallbackCrop, fallbackCrop),
    });
  }

  const pilotChannels = sources.flatMap((source) => createPilotChannels(source.id, source.layout).map(
    (channel) => savedChannels.get(channel.id) ?? channel,
  ));
  const activeSourceId = typeof value.activeSourceId === "string" && sourceIds.has(value.activeSourceId)
    ? value.activeSourceId
    : sources[0].id;
  const activeSource = sources.find((source) => source.id === activeSourceId) ?? sources[0];
  const addedPilotChannelIds = Array.isArray(value.addedPilotChannelIds)
    ? [...new Set(value.addedPilotChannelIds.filter((id): id is string => typeof id === "string" && pilotChannels.some((channel) => channel.id === id)))]
    : undefined;
  const allowedSlots = addedPilotChannelIds || activeSource.layout === "quad" ? [0, 1, 2, 3] : [0];
  const requestedChannel = typeof value.activePilotChannelId === "string"
    ? pilotChannels.find((channel) => channel.id === value.activePilotChannelId)
    : null;
  const activePilotChannelId = requestedChannel
    && requestedChannel.sourceId === activeSource.id
    && allowedSlots.includes(requestedChannel.slot)
    ? requestedChannel.id
    : pilotChannelId(activeSource.id, 0);

  return {
    schemaVersion: VIDEO_WORKSPACE_SCHEMA_VERSION,
    sources,
    pilotChannels,
    activeSourceId,
    activePilotChannelId,
    ...(addedPilotChannelIds ? { addedPilotChannelIds } : {}),
  };
}

export function loadVideoWorkspace(storage: VideoWorkspaceStorage): {
  workspace: VideoWorkspaceConfig;
  error: string | null;
} {
  try {
    const stored = storage.getItem(VIDEO_WORKSPACE_STORAGE_KEY)
      ?? storage.getItem(LEGACY_VIDEO_WORKSPACE_STORAGE_KEY);
    if (stored === null) return { workspace: createDefaultVideoWorkspace(), error: null };
    const workspace = parseWorkspace(JSON.parse(stored));
    return workspace
      ? { workspace, error: null }
      : { workspace: createDefaultVideoWorkspace(), error: "视频工作区格式无效，已恢复默认设置" };
  } catch (error) {
    return { workspace: createDefaultVideoWorkspace(), error: storageErrorMessage(error) };
  }
}

export function saveVideoWorkspace(storage: VideoWorkspaceStorage, workspace: VideoWorkspaceConfig) {
  try {
    storage.setItem(VIDEO_WORKSPACE_STORAGE_KEY, JSON.stringify({
      ...workspace,
      // A name read from a connected FC must not identify the next device after reload.
      pilotChannels: workspace.pilotChannels.map((channel) => channel.athleteCodeMode === "auto"
        ? { ...channel, athleteCode: "" }
        : channel),
    }));
    return null;
  } catch (error) {
    return storageErrorMessage(error);
  }
}
