import { readFileSync } from "node:fs";

const css = readFileSync("public/floating.css", "utf8");

/** jsdom does not load the manifest's content stylesheets. */
export function loadFloatingStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  document.documentElement.append(style);
  return style;
}
