import type { TranslationDisplayMode } from "./types";

export const TRANSLATION_DISPLAY_MODES: ReadonlyArray<{
  value: TranslationDisplayMode;
  label: string;
  description: string;
}> = [
  {
    value: "replace",
    label: "译文替换",
    description: "隐藏原文，仅显示译文"
  },
  {
    value: "bilingual",
    label: "原色对照",
    description: "译文显示在原文下方，并沿用原文颜色"
  },
  {
    value: "bilingual-accent",
    label: "双色对照",
    description: "译文显示在原文下方，并以相近色区分"
  }
];
