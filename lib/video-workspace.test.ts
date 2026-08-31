import { describe, expect, it } from "vitest";
import {
  activePilotChannel,
  activeVideoViewport,
  addVideoSource,
  createDefaultVideoWorkspace,
  loadVideoWorkspace,
  removeVideoSource,
  saveVideoWorkspace,
  selectPilotChannel,
  selectVideoSource,
  setVideoSourceDevice,
  setVideoSourceLayout,
  updatePilotChannel,
  VIDEO_WORKSPACE_STORAGE_KEY,
  videoViewportsForSource,
  videoViewportTransform,
} from "./video-workspace";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) => key === VIDEO_WORKSPACE_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string) => {
      if (key === VIDEO_WORKSPACE_STORAGE_KEY) value = next;
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
    }));
    const result = loadVideoWorkspace(storage);
    expect(result.error).toBeNull();
    expect(result.workspace.sources[0].label).toBe("RX A");
    expect(result.workspace.pilotChannels).toHaveLength(4);
    expect(result.workspace.pilotChannels[2].athleteCode).toBe("PILOT-03");
    expect(activePilotChannel(result.workspace)?.slot).toBe(0);
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
