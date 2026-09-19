import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { AddPilotDialog } from "./add-pilot-dialog";
import { createDefaultVideoWorkspace } from "../lib/video-workspace";

let renderer: ReactTestRenderer | undefined;
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.unstubAllGlobals(); });

it("keeps drafts local, submits one binding, and locks submission during recording", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onAdd = vi.fn(() => true), onClose = vi.fn();
  const props = { workspace: createDefaultVideoWorkspace(), disabled: false, onAdd, onClose };
  act(() => { renderer = create(<AddPilotDialog {...props} />); });
  const root = renderer!.root;
  act(() => root.findByProps({ placeholder: "姓名或飞手代号" }).props.onChange({ target: { value: "Alpha" } }));
  act(() => root.findByProps({ value: "bottom-right", type: "radio" }).props.onChange());
  expect(onAdd).not.toHaveBeenCalled();
  act(() => { renderer!.update(<AddPilotDialog {...props} disabled />); });
  act(() => root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }));
  expect(onAdd).not.toHaveBeenCalled();
  act(() => { renderer!.update(<AddPilotDialog {...props} />); });
  act(() => root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }));
  expect(onAdd).toHaveBeenCalledExactlyOnceWith({ athleteCode: "Alpha", sourceId: "video-source-1", picture: "bottom-right" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps the draft open and reports a persistence failure instead of claiming success", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onClose = vi.fn();
  act(() => { renderer = create(<AddPilotDialog workspace={createDefaultVideoWorkspace()} disabled={false} onAdd={() => false} onClose={onClose} />); });
  const root = renderer!.root;
  act(() => root.findByProps({ placeholder: "姓名或飞手代号" }).props.onChange({ target: { value: "Alpha" } }));
  act(() => root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }));
  expect(root.findByProps({ role: "alert" }).children.join("")).toContain("未能添加飞手");
  expect(root.findByProps({ placeholder: "姓名或飞手代号" }).props.value).toBe("Alpha");
  expect(onClose).not.toHaveBeenCalled();
});

it("offers a new input when legacy hidden positions are configured or connected", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const workspace = createDefaultVideoWorkspace();
  delete workspace.addedPilotChannelIds;
  workspace.pilotChannels[1].gateProfileId = "preserve-gate";
  workspace.pilotChannels[2].athleteCodeMode = "manual";
  act(() => { renderer = create(<AddPilotDialog workspace={workspace} occupiedPilotIds={[workspace.pilotChannels[3].id]} disabled={false} onAdd={() => true} onClose={vi.fn()} />); });
  expect(renderer!.root.findByType("select").props.value).toBe("new");
  expect(renderer!.root.findByProps({ value: workspace.activeSourceId }).props.disabled).toBe(true);
});

it("restores a preserved pilot without submitting a new name or binding", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const workspace = createDefaultVideoWorkspace();
  workspace.pilotChannels[1].athleteCode = "Hidden";
  workspace.pilotChannels[1].athleteCodeMode = "manual";
  const onAdd = vi.fn(), onRestore = vi.fn(() => true), onClose = vi.fn();
  act(() => { renderer = create(<AddPilotDialog workspace={workspace} disabled={false} onAdd={onAdd} onRestore={onRestore} onClose={onClose} />); });
  const button = renderer!.root.findAllByType("button").find((node) => node.children.join("") === "恢复 Hidden")!;
  act(() => button.props.onClick());
  expect(onRestore).toHaveBeenCalledExactlyOnceWith(workspace.pilotChannels[1].id);
  expect(onAdd).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});
