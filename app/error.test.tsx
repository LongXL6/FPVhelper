import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AppError from "./error";

describe("AppError", () => {
  it("renders a generic retry UI without exposing raw error details", () => {
    const privateError = Object.assign(
      new Error("pilot Alice /dev/cu.usb-private raw bytes 01ff"),
      { digest: "private-server-digest" },
    );
    privateError.stack = "private stack with athlete note";
    const markup = renderToStaticMarkup(<AppError error={privateError} retry={vi.fn()} />);

    expect(markup).toContain("页面暂时无法继续");
    expect(markup).toContain("重试页面");
    expect(markup).not.toMatch(/Alice|usb-private|raw bytes|private-server-digest|athlete note/);
  });
});
