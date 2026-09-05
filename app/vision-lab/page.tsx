import type { Metadata } from "next";
import { VisionLab } from "@/components/vision-lab";

export const metadata: Metadata = {
  title: "本地视觉实验台 · FPVHelper",
  description: "在本机设置计时门、分析录像并复核候选穿越。",
};

export default function VisionLabPage() {
  return <VisionLab />;
}
