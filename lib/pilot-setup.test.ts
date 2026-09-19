import { describe, expect, it } from "vitest";
import {
  activeVideoViewport, addPilotToWorkspace, addedPilotIds, addVideoSource, availablePilotChannels, createDefaultVideoWorkspace,
  loadVideoWorkspace, removeVideoSource, restorePilotToWorkspace, saveVideoWorkspace, selectPilotChannel, selectVideoSource,
  setVideoSourceLayout, videoViewportsForSource, type VideoWorkspaceConfig,
} from "./video-workspace";

const visible = (workspace: VideoWorkspaceConfig) => workspace.sources.flatMap((source) => videoViewportsForSource(workspace, source));
function roundTrip(workspace: VideoWorkspaceConfig) {
  let saved = "";
  const storage = { setItem: (_key: string, value: string) => { saved = value; }, getItem: () => saved };
  expect(saveVideoWorkspace(storage, workspace)).toBeNull();
  return loadVideoWorkspace(storage).workspace;
}

describe("pilot-first setup", () => {
  it("starts empty and changing source layouts or adding inputs never creates pilots", () => {
    let workspace = createDefaultVideoWorkspace();
    expect(visible(workspace)).toEqual([]);
    expect(activeVideoViewport(workspace)).toBeNull();
    workspace = setVideoSourceLayout(workspace, workspace.activeSourceId, "quad");
    workspace = addVideoSource(workspace);
    expect(visible(roundTrip(workspace))).toEqual([]);
  });

  it("adds one window per pilot with an independent name and explicitly selected region", () => {
    let workspace = createDefaultVideoWorkspace();
    workspace = addPilotToWorkspace(workspace, { athleteCode: " Alpha ", sourceId: workspace.activeSourceId, picture: "bottom-right" });
    const first = workspace.pilotChannels[0];
    expect(visible(workspace)).toHaveLength(1);
    expect(first.athleteCode).toBe("Alpha");
    expect(activeVideoViewport(workspace)?.crop).toEqual({ xPercent: 50, yPercent: 50, widthPercent: 50, heightPercent: 50 });
    workspace = addPilotToWorkspace(workspace, { athleteCode: "Bravo", sourceId: workspace.activeSourceId, picture: "top-left" });
    expect(visible(workspace)).toHaveLength(2);
    expect(workspace.pilotChannels[0]).toEqual(first);
    expect(activeVideoViewport(workspace)?.pilotChannelId).toBe(workspace.pilotChannels[1].id);
    workspace = roundTrip(workspace);
    expect(visible(workspace)).toHaveLength(2);
    expect(activeVideoViewport(workspace)?.pilotChannelId).toBe(workspace.pilotChannels[1].id);
    expect(activeVideoViewport(workspace)?.crop.xPercent).toBe(0);
    workspace = selectPilotChannel(workspace, first.id);
    expect(activeVideoViewport(workspace)?.crop.xPercent).toBe(50);
    expect(selectPilotChannel(workspace, workspace.pilotChannels[3].id)).toBe(workspace);
    const bindings = (config: VideoWorkspaceConfig) => visible(config).map(({ pilotChannelId, crop }) => ({ pilotChannelId, crop }));
    expect(bindings(setVideoSourceLayout(workspace, workspace.activeSourceId, "quad"))).toEqual(bindings(workspace));
  });

  it("enforces source capacity and adds a fifth pilot using a new independent input", () => {
    let workspace = createDefaultVideoWorkspace();
    for (let i = 0; i < 4; i++) workspace = addPilotToWorkspace(workspace, { athleteCode: `Pilot ${i}`, sourceId: workspace.activeSourceId, picture: "full" });
    expect(visible(workspace)).toHaveLength(4);
    expect(addPilotToWorkspace(workspace, { athleteCode: "Overflow", sourceId: workspace.activeSourceId, picture: "full" })).toBe(workspace);
    workspace = addPilotToWorkspace(workspace, { athleteCode: "Independent", sourceId: "new", picture: "full" });
    expect(workspace.sources).toHaveLength(2);
    expect(visible(workspace)).toHaveLength(5);
    expect(activeVideoViewport(workspace)?.sourceId).toBe(workspace.sources[1].id);
    workspace = selectVideoSource(workspace, workspace.sources[0].id);
    expect(activeVideoViewport(workspace)?.sourceId).toBe(workspace.sources[0].id);
    workspace = removeVideoSource(workspace, workspace.sources[1].id);
    expect(addedPilotIds(roundTrip(workspace))).toHaveLength(4);
  });

  it("rejects blank names and stale sources without changing configuration", () => {
    const workspace = createDefaultVideoWorkspace();
    expect(addPilotToWorkspace(workspace, { athleteCode: "  ", sourceId: "new", picture: "full" })).toBe(workspace);
    expect(addPilotToWorkspace(workspace, { athleteCode: "Alpha", sourceId: "missing", picture: "full" })).toBe(workspace);
  });

  it("retains legacy windows and crops when loading and adding a new pilot", () => {
    const legacy = createDefaultVideoWorkspace();
    delete legacy.addedPilotChannelIds;
    legacy.sources[0].layout = "quad";
    legacy.pilotChannels[2].athleteCode = "Existing";
    legacy.pilotChannels[2].athleteCodeMode = "manual";
    legacy.pilotChannels[2].viewMode = "crop";
    legacy.pilotChannels[2].crop = { xPercent: 15, yPercent: 25, widthPercent: 40, heightPercent: 35 };
    const loaded = roundTrip(legacy);
    expect(visible(loaded)).toHaveLength(4);
    const added = roundTrip(addPilotToWorkspace(loaded, { athleteCode: "New", sourceId: "new", picture: "full" }));
    expect(visible(added).slice(0, 4)).toEqual(visible(loaded));
    expect(added.pilotChannels[2]).toEqual(loaded.pilotChannels[2]);
  });

  it("preserves configured hidden pilots across legacy migration, repeated adds and reload", () => {
    const legacy = createDefaultVideoWorkspace();
    delete legacy.addedPilotChannelIds;
    Object.assign(legacy.pilotChannels[1], {
      athleteCode: "Hidden", athleteCodeMode: "manual", gateProfileId: "old-gate", videoProfileId: "old-camera",
      viewMode: "crop", crop: { xPercent: 15, yPercent: 25, widthPercent: 40, heightPercent: 35 },
    });
    const original = roundTrip(legacy).pilotChannels[1];
    let workspace = addPilotToWorkspace(roundTrip(legacy), { athleteCode: "New", sourceId: legacy.activeSourceId, picture: "full" });
    expect(workspace.activePilotChannelId).toBe(legacy.pilotChannels[2].id);
    expect(workspace.pilotChannels[2]).toMatchObject({ gateProfileId: null, videoProfileId: null });
    workspace = roundTrip(addPilotToWorkspace(roundTrip(workspace), { athleteCode: "Next", sourceId: legacy.activeSourceId, picture: "top-left" }));
    expect(workspace.pilotChannels[1]).toEqual(original);
    expect(visible(workspace)).toHaveLength(3);
    expect(availablePilotChannels(workspace, legacy.activeSourceId)).toEqual([]);
    expect(addPilotToWorkspace(workspace, { athleteCode: "Overflow", sourceId: legacy.activeSourceId, picture: "full" })).toBe(workspace);
    const restored = roundTrip(restorePilotToWorkspace(workspace, original.id));
    expect(visible(restored)).toHaveLength(4);
    expect(restored.pilotChannels[1]).toEqual(original);
    expect(activeVideoViewport(restored)?.pilotChannelId).toBe(original.id);
    expect(activeVideoViewport(restored)?.crop).toEqual(original.crop);
    expect(restorePilotToWorkspace(restored, original.id)).toBe(restored);
  });

  it("does not reuse a hidden connected channel even when automatic names are absent from storage", () => {
    const legacy = createDefaultVideoWorkspace();
    delete legacy.addedPilotChannelIds;
    const occupied = [legacy.pilotChannels[1].id];
    expect(availablePilotChannels(legacy, legacy.activeSourceId, occupied).map((channel) => channel.slot)).toEqual([2, 3]);
    const workspace = addPilotToWorkspace(legacy, { athleteCode: "New", sourceId: legacy.activeSourceId, picture: "full" }, occupied);
    expect(workspace.activePilotChannelId).toBe(legacy.pilotChannels[2].id);
    expect(workspace.pilotChannels[1]).toEqual(legacy.pilotChannels[1]);
    const restored = restorePilotToWorkspace(workspace, occupied[0], occupied);
    expect(restored.activePilotChannelId).toBe(occupied[0]);
    expect(restored.pilotChannels[1]).toEqual(legacy.pilotChannels[1]);
  });

  it.each([
    { athleteCodeMode: "manual" as const },
    { gateProfileId: "gate" },
    { videoProfileId: "camera" },
    { viewMode: "full" as const },
    { crop: { xPercent: 12, yPercent: 10, widthPercent: 40, heightPercent: 45 } },
  ])("reserves hidden settings even without a saved name: %j", (settings) => {
    const legacy = createDefaultVideoWorkspace();
    delete legacy.addedPilotChannelIds;
    Object.assign(legacy.pilotChannels[1], settings);
    expect(availablePilotChannels(roundTrip(legacy), legacy.activeSourceId).map((channel) => channel.slot)).toEqual([2, 3]);
  });
});
