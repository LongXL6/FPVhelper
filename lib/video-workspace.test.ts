import { describe, expect, it } from "vitest";
import {
  activePilotChannel,
  activeVideoViewport,
  addVideoSource,
  createDefaultVideoWorkspace,
  loadVideoWorkspace,
  normalizeVideoCrop,
  removeVideoSource,
  resetPilotChannelCrop,
  resolvedPilotVideoViewMode,
  saveVideoWorkspace,
  selectPilotChannel,
  selectVideoSource,
  setPilotChannelCrop,
  setPilotChannelViewMode,
  setVideoSourceDevice,
  setVideoSourceLayout,
  updatePilotChannel,
  LEGACY_VIDEO_WORKSPACE_STORAGE_KEY,
  VIDEO_WORKSPACE_STORAGE_KEY,
  videoCropPixelRect,
  videoViewportsForSource,
  videoViewportTransform,
} from "./video-workspace";

function memoryStorage(initial: string | null = null, initialKey = VIDEO_WORKSPACE_STORAGE_KEY) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(initialKey, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, next: string) => {
      values.set(key, next);
    },
  };
}

describe("local video workspace", () => {
  it("starts with one full-frame source and one active pilot channel", () => {
    const workspace = createDefaultVideoWorkspace();
    expect(workspace.sources).toEqual([
      { id: "video-source-1", label: "视频输入 1", deviceId: "", layout: "full" },
    ]);
    expect(workspace.pilotChannels).toHaveLength(4);
    expect(activePilotChannel(workspace)?.slot).toBe(0);
    expect(activeVideoViewport(workspace)?.crop).toEqual({
      xPercent: 0,
      yPercent: 0,
      widthPercent: 100,
      heightPercent: 100,
    });
  });

  it("builds four deterministic viewports for a four-up source", () => {
    const workspace = setVideoSourceLayout(createDefaultVideoWorkspace(), "video-source-1", "quad");
    expect(videoViewportsForSource(workspace, workspace.sources[0]).map((viewport) => viewport.crop)).toEqual([
      { xPercent: 0, yPercent: 0, widthPercent: 50, heightPercent: 50 },
      { xPercent: 50, yPercent: 0, widthPercent: 50, heightPercent: 50 },
      { xPercent: 0, yPercent: 50, widthPercent: 50, heightPercent: 50 },
      { xPercent: 50, yPercent: 50, widthPercent: 50, heightPercent: 50 },
    ]);
    expect(videoViewportTransform(videoViewportsForSource(workspace, workspace.sources[0])[3])).toEqual({
      widthPercent: 200,
      heightPercent: 200,
      leftPercent: -100,
      topPercent: -100,
    });
  });

  it("lets each pilot choose a full input or an independent crop", () => {
    let workspace = setVideoSourceLayout(createDefaultVideoWorkspace(), "video-source-1", "quad");
    const source = workspace.sources[0];
    const secondPilot = workspace.pilotChannels[1];

    expect(resolvedPilotVideoViewMode(source, secondPilot)).toBe("crop");
    workspace = setPilotChannelViewMode(workspace, secondPilot.id, "full");
    expect(videoViewportsForSource(workspace, source)[1].crop).toEqual({
      xPercent: 0,
      yPercent: 0,
      widthPercent: 100,
      heightPercent: 100,
    });

    workspace = setPilotChannelCrop(workspace, secondPilot.id, {
      xPercent: 10,
      yPercent: 15,
      widthPercent: 70,
      heightPercent: 60,
    });
    expect(videoViewportsForSource(workspace, source)[1].crop).toEqual({
      xPercent: 10,
      yPercent: 15,
      widthPercent: 70,
      heightPercent: 60,
    });
    expect(videoViewportsForSource(workspace, source)[0].crop).toEqual({
      xPercent: 0,
      yPercent: 0,
      widthPercent: 50,
      heightPercent: 50,
    });

    workspace = resetPilotChannelCrop(workspace, secondPilot.id);
    expect(videoViewportsForSource(workspace, source)[1].crop).toEqual({
      xPercent: 50,
      yPercent: 0,
      widthPercent: 50,
      heightPercent: 50,
    });
  });

  it("keeps custom crops inside the source frame", () => {
    expect(normalizeVideoCrop({
      xPercent: 95,
      yPercent: -5,
      widthPercent: 90,
      heightPercent: 3,
    })).toEqual({
      xPercent: 90,
      yPercent: 0,
      widthPercent: 10,
      heightPercent: 10,
    });
    expect(videoCropPixelRect({
      xPercent: 10,
      yPercent: 15,
      widthPercent: 70,
      heightPercent: 60,
    }, 1_920, 1_080)).toEqual({
      x: 192,
      y: 162,
      width: 1_344,
      height: 648,
    });
  });

  it("preserves pilot metadata when switching between full and four-up layouts", () => {
    let workspace = setVideoSourceLayout(createDefaultVideoWorkspace(), "video-source-1", "quad");
    const secondPilot = workspace.pilotChannels.find((channel) => channel.slot === 1)!;
    workspace = updatePilotChannel(workspace, secondPilot.id, {
      athleteCode: "PILOT-02",
      gateProfileId: "club-gate",
      videoProfileId: "analog-camera-a",
    });
    workspace = selectPilotChannel(workspace, secondPilot.id);
    workspace = setVideoSourceLayout(workspace, "video-source-1", "full");
    expect(activePilotChannel(workspace)?.slot).toBe(0);
    expect(workspace.pilotChannels.find((channel) => channel.id === secondPilot.id)).toMatchObject({
      athleteCode: "PILOT-02",
      gateProfileId: "club-gate",
      videoProfileId: "analog-camera-a",
    });
    workspace = setVideoSourceLayout(workspace, "video-source-1", "quad");
    workspace = selectPilotChannel(workspace, secondPilot.id);
    expect(activePilotChannel(workspace)?.athleteCode).toBe("PILOT-02");
  });

  it("adds and removes independent source profiles without cross-linking pilot channels", () => {
    let workspace = addVideoSource(createDefaultVideoWorkspace());
    expect(workspace.sources.map((source) => source.id)).toEqual(["video-source-1", "video-source-2"]);
    expect(workspace.activeSourceId).toBe("video-source-2");
    expect(activePilotChannel(workspace)?.sourceId).toBe("video-source-2");

    workspace = setVideoSourceDevice(workspace, "video-source-2", "capture-card-b");
    workspace = selectVideoSource(workspace, "video-source-1");
    expect(workspace.sources[1].deviceId).toBe("capture-card-b");
    workspace = removeVideoSource(workspace, "video-source-2");
    expect(workspace.sources).toHaveLength(1);
    expect(workspace.pilotChannels.every((channel) => channel.sourceId === "video-source-1")).toBe(true);
    expect(removeVideoSource(workspace, "video-source-1")).toBe(workspace);
  });

  it("persists only normalized local workspace data", () => {
    const storage = memoryStorage();
    let workspace = setVideoSourceLayout(createDefaultVideoWorkspace(), "video-source-1", "quad");
    workspace = updatePilotChannel(workspace, workspace.pilotChannels[0].id, { athleteCode: "PILOT-01" });
    expect(saveVideoWorkspace(storage, workspace)).toBeNull();
    expect(loadVideoWorkspace(storage)).toEqual({ workspace, error: null });
  });

  it("repairs missing pilot slots and invalid active ids while loading", () => {
    const storage = memoryStorage(JSON.stringify({
      schemaVersion: 1,
      sources: [{ id: "video-source-3", label: "  RX A  ", deviceId: "opaque", layout: "full" }],
      pilotChannels: [{
        id: "ignored",
        sourceId: "video-source-3",
        slot: 2,
        athleteCode: "PILOT-03",
        gateProfileId: null,
        videoProfileId: null,
      }],
      activeSourceId: "missing",
      activePilotChannelId: "video-source-3-pilot-3",
    }), LEGACY_VIDEO_WORKSPACE_STORAGE_KEY);
    const result = loadVideoWorkspace(storage);
    expect(result.error).toBeNull();
    expect(result.workspace.sources[0].label).toBe("RX A");
    expect(result.workspace.pilotChannels).toHaveLength(4);
    expect(result.workspace.pilotChannels[2].athleteCode).toBe("PILOT-03");
    expect(activePilotChannel(result.workspace)?.slot).toBe(0);
    expect(result.workspace.schemaVersion).toBe(2);
    expect(result.workspace.pilotChannels[0]).toMatchObject({
      viewMode: "source-default",
      crop: { xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 100 },
    });
    expect(saveVideoWorkspace(storage, result.workspace)).toBeNull();
    expect(JSON.parse(storage.getItem(VIDEO_WORKSPACE_STORAGE_KEY) ?? "null")).toMatchObject({
      schemaVersion: 2,
      sources: [{ id: "video-source-3" }],
    });
  });

  it("migrates a legacy four-up workspace without changing its four pilot crops", () => {
    const storage = memoryStorage(JSON.stringify({
      schemaVersion: 1,
      sources: [{ id: "video-source-1", label: "QUAD RX", deviceId: "quad", layout: "quad" }],
      pilotChannels: [0, 1, 2, 3].map((slot) => ({
        id: `video-source-1-pilot-${slot + 1}`,
        sourceId: "video-source-1",
        slot,
        athleteCode: `PILOT-0${slot + 1}`,
        gateProfileId: null,
        videoProfileId: null,
      })),
      activeSourceId: "video-source-1",
      activePilotChannelId: "video-source-1-pilot-2",
    }), LEGACY_VIDEO_WORKSPACE_STORAGE_KEY);

    const result = loadVideoWorkspace(storage);
    expect(result.error).toBeNull();
    expect(result.workspace.activePilotChannelId).toBe("video-source-1-pilot-2");
    expect(result.workspace.pilotChannels.every((channel) => channel.viewMode === "source-default")).toBe(true);
    expect(videoViewportsForSource(result.workspace, result.workspace.sources[0]).map((viewport) => viewport.crop)).toEqual([
      { xPercent: 0, yPercent: 0, widthPercent: 50, heightPercent: 50 },
      { xPercent: 50, yPercent: 0, widthPercent: 50, heightPercent: 50 },
      { xPercent: 0, yPercent: 50, widthPercent: 50, heightPercent: 50 },
      { xPercent: 50, yPercent: 50, widthPercent: 50, heightPercent: 50 },
    ]);
  });

  it("keeps migrated v2 settings isolated from later writes by an old tab", () => {
    const storage = memoryStorage(JSON.stringify({
      schemaVersion: 1,
      sources: [{ id: "video-source-1", label: "LEGACY", deviceId: "", layout: "full" }],
      pilotChannels: [],
      activeSourceId: "video-source-1",
      activePilotChannelId: "video-source-1-pilot-1",
    }), LEGACY_VIDEO_WORKSPACE_STORAGE_KEY);
    let migrated = loadVideoWorkspace(storage).workspace;
    migrated = setPilotChannelCrop(migrated, migrated.activePilotChannelId, {
      xPercent: 10,
      yPercent: 10,
      widthPercent: 80,
      heightPercent: 80,
    });
    saveVideoWorkspace(storage, migrated);

    storage.setItem(LEGACY_VIDEO_WORKSPACE_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      sources: [{ id: "video-source-1", label: "OLD TAB DEFAULT", deviceId: "", layout: "full" }],
      pilotChannels: [],
      activeSourceId: "video-source-1",
      activePilotChannelId: "video-source-1-pilot-1",
    }));

    const reloaded = loadVideoWorkspace(storage).workspace;
    expect(reloaded.sources[0].label).toBe("LEGACY");
    expect(activeVideoViewport(reloaded)?.crop).toEqual({
      xPercent: 10,
      yPercent: 10,
      widthPercent: 80,
      heightPercent: 80,
    });
  });

  it("fails closed for malformed settings and reports storage errors", () => {
    expect(loadVideoWorkspace(memoryStorage("not-json"))).toMatchObject({
      workspace: createDefaultVideoWorkspace(),
      error: expect.any(String),
    });
    expect(loadVideoWorkspace(memoryStorage(JSON.stringify({ schemaVersion: 99 })))).toEqual({
      workspace: createDefaultVideoWorkspace(),
      error: "视频工作区格式无效，已恢复默认设置",
    });
    expect(saveVideoWorkspace({
      getItem: () => null,
      setItem: () => { throw new Error("quota blocked"); },
    }, createDefaultVideoWorkspace())).toBe("quota blocked");
  });
});
