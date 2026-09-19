import { describe, expect, it } from "vitest";
import {
  activeVideoViewport, addPilotToWorkspace, addedPilotIds, addVideoSource, createDefaultVideoWorkspace,
  loadVideoWorkspace, removeVideoSource, saveVideoWorkspace, selectPilotChannel, selectVideoSource,
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
});
