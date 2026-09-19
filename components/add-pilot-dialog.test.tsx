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
