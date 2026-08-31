export const VIDEO_WORKSPACE_SCHEMA_VERSION = 1;
export const VIDEO_WORKSPACE_STORAGE_KEY = "fpvhelper.video-workspace.v1";

export type VideoSourceLayout = "full" | "quad";

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
  gateProfileId: string | null;
  videoProfileId: string | null;
}

export interface VideoViewport {
  id: string;
  sourceId: string;
  pilotChannelId: string;
  label: string;
  crop: {
    xPercent: number;
    yPercent: number;
    widthPercent: number;
    heightPercent: number;
  };
}

export interface VideoWorkspaceConfig {
  schemaVersion: typeof VIDEO_WORKSPACE_SCHEMA_VERSION;
  sources: VideoSourceConfig[];
  pilotChannels: PilotChannelConfig[];
  activeSourceId: string;
  activePilotChannelId: string;
}

interface VideoWorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const QUAD_CROPS = [
  { xPercent: 0, yPercent: 0, widthPercent: 50, heightPercent: 50 },
  { xPercent: 50, yPercent: 0, widthPercent: 50, heightPercent: 50 },
  { xPercent: 0, yPercent: 50, widthPercent: 50, heightPercent: 50 },
  { xPercent: 50, yPercent: 50, widthPercent: 50, heightPercent: 50 },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceId(index: number) {
  return `video-source-${index}`;
}

function pilotChannelId(source: string, slot: number) {
  return `${source}-pilot-${slot + 1}`;
}

function createPilotChannels(source: string): PilotChannelConfig[] {
  return ([0, 1, 2, 3] as const).map((slot) => ({
    id: pilotChannelId(source, slot),
    sourceId: source,
    slot,
    athleteCode: "",
    gateProfileId: null,
    videoProfileId: null,
  }));
}

export function createDefaultVideoWorkspace(): VideoWorkspaceConfig {
  const source = sourceId(1);
  const pilotChannels = createPilotChannels(source);
  return {
    schemaVersion: VIDEO_WORKSPACE_SCHEMA_VERSION,
    sources: [{ id: source, label: "视频输入 1", deviceId: "", layout: "full" }],
    pilotChannels,
    activeSourceId: source,
    activePilotChannelId: pilotChannels[0].id,
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
  const channels = source.layout === "quad" ? sourceChannels : sourceChannels.slice(0, 1);

  return channels.map((channel, index) => ({
    id: `${source.id}-viewport-${channel.slot + 1}`,
    sourceId: source.id,
    pilotChannelId: channel.id,
    label: source.layout === "quad" ? `选手 ${channel.slot + 1}` : "完整画面",
    crop: source.layout === "quad"
      ? { ...QUAD_CROPS[index] }
      : { xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 100 },
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
    (channel) => channel.sourceId === selectedSourceId && channel.slot === 0,
  );
  if (!firstChannel) return workspace;
  return { ...workspace, activeSourceId: selectedSourceId, activePilotChannelId: firstChannel.id };
}

export function selectPilotChannel(workspace: VideoWorkspaceConfig, selectedChannelId: string) {
  const source = activeVideoSource(workspace);
  const channel = workspace.pilotChannels.find((candidate) => candidate.id === selectedChannelId);
  if (!source || !channel || channel.sourceId !== source.id) return workspace;
  if (source.layout === "full" && channel.slot !== 0) return workspace;
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
  const shouldSelectFirst = workspace.activeSourceId === selectedSourceId && layout === "full" && activeChannel?.slot !== 0;
  const firstChannel = workspace.pilotChannels.find(
    (channel) => channel.sourceId === selectedSourceId && channel.slot === 0,
  );
  return {
    ...workspace,
    sources,
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
          gateProfileId: update.gateProfileId === undefined ? channel.gateProfileId : update.gateProfileId,
          videoProfileId: update.videoProfileId === undefined ? channel.videoProfileId : update.videoProfileId,
        }
      : channel),
  };
}

export function addVideoSource(workspace: VideoWorkspaceConfig) {
  const usedIds = new Set(workspace.sources.map((source) => source.id));
  let index = 1;
  while (usedIds.has(sourceId(index))) index += 1;
  const id = sourceId(index);
  const channels = createPilotChannels(id);
  return {
    ...workspace,
    sources: [...workspace.sources, { id, label: `视频输入 ${index}`, deviceId: "", layout: "full" as const }],
    pilotChannels: [...workspace.pilotChannels, ...channels],
    activeSourceId: id,
    activePilotChannelId: channels[0].id,
  };
}

export function removeVideoSource(workspace: VideoWorkspaceConfig, selectedSourceId: string) {
  if (workspace.sources.length <= 1 || !workspace.sources.some((source) => source.id === selectedSourceId)) {
    return workspace;
  }
  const sources = workspace.sources.filter((source) => source.id !== selectedSourceId);
  const pilotChannels = workspace.pilotChannels.filter((channel) => channel.sourceId !== selectedSourceId);
  if (workspace.activeSourceId !== selectedSourceId) return { ...workspace, sources, pilotChannels };
  const nextSource = sources[0];
  const nextChannel = pilotChannels.find((channel) => channel.sourceId === nextSource.id && channel.slot === 0);
  return {
    ...workspace,
    sources,
    pilotChannels,
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

function storageErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "浏览器拒绝访问视频工作区设置";
}

function parseWorkspace(value: unknown): VideoWorkspaceConfig | null {
  if (!isRecord(value) || value.schemaVersion !== VIDEO_WORKSPACE_SCHEMA_VERSION) return null;
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
    savedChannels.set(id, {
      id,
      sourceId: rawChannel.sourceId,
      slot: rawChannel.slot,
      athleteCode: typeof rawChannel.athleteCode === "string" ? rawChannel.athleteCode.slice(0, 40) : "",
      gateProfileId: typeof rawChannel.gateProfileId === "string" ? rawChannel.gateProfileId.slice(0, 120) : null,
      videoProfileId: typeof rawChannel.videoProfileId === "string" ? rawChannel.videoProfileId.slice(0, 120) : null,
    });
  }

  const pilotChannels = sources.flatMap((source) => createPilotChannels(source.id).map(
    (channel) => savedChannels.get(channel.id) ?? channel,
  ));
  const activeSourceId = typeof value.activeSourceId === "string" && sourceIds.has(value.activeSourceId)
    ? value.activeSourceId
    : sources[0].id;
  const activeSource = sources.find((source) => source.id === activeSourceId) ?? sources[0];
  const allowedSlots = activeSource.layout === "quad" ? [0, 1, 2, 3] : [0];
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
  };
}

export function loadVideoWorkspace(storage: VideoWorkspaceStorage): {
  workspace: VideoWorkspaceConfig;
  error: string | null;
} {
  try {
    const stored = storage.getItem(VIDEO_WORKSPACE_STORAGE_KEY);
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
    storage.setItem(VIDEO_WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    return null;
  } catch (error) {
    return storageErrorMessage(error);
  }
}
