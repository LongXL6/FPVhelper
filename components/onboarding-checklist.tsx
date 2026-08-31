"use client";

import { useEffect, useRef, useState } from "react";
import {
  assessOnboardingEnvironment,
  loadOnboardingDecision,
  saveOnboardingDecision,
  shouldAutoOpenOnboarding,
  type OnboardingDecision,
  type OnboardingEnvironment,
} from "../lib/onboarding";

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function inspectBrowserEnvironment() {
  return assessOnboardingEnvironment({
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    serialSupported: Boolean(navigator.serial),
    mediaSupported: Boolean(navigator.mediaDevices?.getUserMedia),
    indexedDbSupported: "indexedDB" in window,
    directoryPickerSupported: "showDirectoryPicker" in window,
  });
}

function ChecklistItem({
  label,
  status,
  detail,
  tone,
}: {
  label: string;
  status: string;
  detail: string;
  tone: "ready" | "warning" | "optional";
}) {
  return (
    <li className="onboarding-check" data-tone={tone}>
      <div>
        <b>{label}</b>
        <span>{status}</span>
      </div>
      <p>{detail}</p>
    </li>
  );
}

export function OnboardingChecklist() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [environment, setEnvironment] = useState<OnboardingEnvironment | null>(null);
  const [open, setOpen] = useState(false);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);

  useEffect(() => {
    const inspection = window.setTimeout(() => {
      setEnvironment(inspectBrowserEnvironment());
      setOpen(shouldAutoOpenOnboarding(loadOnboardingDecision(browserStorage())));
    }, 0);
    return () => window.clearTimeout(inspection);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const rememberDecision = (decision: OnboardingDecision) => {
    const warning = saveOnboardingDecision(browserStorage(), decision);
    setPersistenceWarning(warning);
    setOpen(false);
  };

  return (
    <>
      <button
        className="button button--quiet button--onboarding"
        type="button"
        onClick={() => {
          setPersistenceWarning(null);
          setEnvironment(inspectBrowserEnvironment());
          setOpen(true);
        }}
      >安装检查</button>

      {!open && persistenceWarning ? (
        <p className="onboarding-storage-warning onboarding-storage-warning--outside" role="status">
          {persistenceWarning}
        </p>
      ) : null}

      <dialog
        ref={dialogRef}
        className="onboarding-dialog"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-privacy"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
      >
        <div className="onboarding-card">
          <header className="onboarding-heading">
            <div>
              <span>PRE-FLIGHT / LOCAL CHECK</span>
              <h2 id="onboarding-title">首次使用检查</h2>
            </div>
            <button className="onboarding-close" type="button" aria-label="关闭首次使用检查" onClick={() => setOpen(false)}>×</button>
          </header>

          <p id="onboarding-privacy" className="onboarding-privacy">
            本清单只读取浏览器能力：不连接设备、不打开权限选择器、不发送检查结果。只有“已了解 / 稍后”保存在本机 localStorage。
          </p>

          {environment?.compatibilityNotice ? (
            <aside className="onboarding-compatibility" role="alert">
              <b>兼容性提示</b>
              <p>{environment.compatibilityNotice}</p>
            </aside>
          ) : null}

          <ol className="onboarding-checklist">
            <ChecklistItem
              label="01 / 桌面浏览器与安全连接"
              status={environment?.secureContext ? "安全上下文可用" : "需要 HTTPS 或 localhost"}
              detail="建议使用最新版桌面 Chrome 或 Edge；浏览器名称不代表功能一定可用，以此页能力检查为准。"
              tone={environment?.secureContext ? "ready" : "warning"}
            />
            <ChecklistItem
              label="02 / HDMI / UVC 采集卡"
              status={environment?.mediaSupported ? "视频采集能力可用" : "缺少视频采集能力"}
              detail="接好 HDMI 与 USB 后，再点击“打开画面”请求视频权限；能力可用不代表采集卡已连接。"
              tone={environment?.mediaSupported ? "ready" : "warning"}
            />
            <ChecklistItem
              label="03 / Bridge FC / Web Serial"
              status={environment?.serialSupported ? "Web Serial 可用" : "当前环境不支持 Web Serial"}
              detail="接好桥接飞控后，再点击“连接桥接飞控”选择串口；本检查不会自动打开设备选择器。"
              tone={environment?.serialSupported ? "ready" : "warning"}
            />
            <ChecklistItem
              label="04 / 本地 Session 存储"
              status={environment?.indexedDbSupported ? "本机 IndexedDB 可用" : "缺少 IndexedDB 能力"}
              detail="训练 Session 写入当前浏览器的本地数据库；这份清单不会上传 Session 或检查结果。"
              tone={environment?.indexedDbSupported ? "ready" : "warning"}
            />
            <ChecklistItem
              label="05 / 自动保存目录（可选）"
              status={environment?.directoryPickerSupported ? "可在设置中选择目录" : "不可用时退回普通下载"}
              detail="目录选择完全可选，只会在你点击选择时请求授权；不选择也能保存和下载 Session。"
              tone="optional"
            />
          </ol>

          {persistenceWarning ? <p className="onboarding-storage-warning" role="alert">{persistenceWarning}</p> : null}

          <footer className="onboarding-actions">
            <button className="button button--quiet" type="button" onClick={() => rememberDecision("later")}>稍后</button>
            <button className="button button--primary" type="button" onClick={() => rememberDecision("acknowledged")}>已了解</button>
          </footer>
        </div>
      </dialog>
    </>
  );
}
