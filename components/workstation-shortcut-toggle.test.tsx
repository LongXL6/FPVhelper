import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkstationShortcutToggle } from "./workstation-shortcut-toggle";

describe("WorkstationShortcutToggle", () => {
  it("gives the checkbox an explicit accessible name", () => {
    const markup = renderToStaticMarkup(
      <WorkstationShortcutToggle enabled={false} onChange={() => undefined} />,
    );

    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('aria-label="本机单键快捷操作：已关闭"');
  });
});
