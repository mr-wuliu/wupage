// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://x.com/home"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createXImageContextMenu, findXContextImage, type ContextImageTarget } from "../src/content/x-image-context-menu";

const selector = "#wupage-x-image-menu-item";
const translate = vi.fn(async (_target: ContextImageTarget) => ({}));
let adapter: NonNullable<ReturnType<typeof createXImageContextMenu>>;
let blocked = true;
let renderMenu = true;
let capture: (event: MouseEvent) => void;
let site: (event: MouseEvent) => void;

function addMenu(): HTMLElement {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.style.maxHeight = "300px";
  menu.innerHTML = '<div data-testid="Dropdown"><div role="menuitem" tabindex="0" data-testid="copyPhotoLinkContextMenuItem"><div dir="ltr">Copy photo link</div></div></div>';
  menu.addEventListener("keydown", event => { if (event.key === "Escape") menu.remove(); });
  document.body.append(menu);
  return menu;
}

function rightClick(id = "photo"): MouseEvent {
  const event = new MouseEvent("contextmenu", { button: 2, bubbles: true, cancelable: true });
  (document.getElementById(id) ?? document.body).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  blocked = true; renderMenu = true; translate.mockClear();
  document.body.innerHTML = '<div data-testid="tweetPhoto"><div id="pixels"></div><img id="photo" src="https://pbs.twimg.com/media/sample.jpg"></div>';
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  adapter = createXImageContextMenu(translate)!;
  capture = event => {
    const image = findXContextImage(event);
    adapter.open(event, image ? { image, source: image.currentSrc || image.src } : undefined);
  };
  site = event => {
    if (blocked) event.preventDefault();
    if (renderMenu) addMenu();
  };
  document.addEventListener("contextmenu", capture, true);
  document.addEventListener("contextmenu", site);
});

afterEach(() => {
  adapter.close();
  document.removeEventListener("contextmenu", capture, true);
  document.removeEventListener("contextmenu", site);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

describe("X photo context menu", () => {
  it("adds one localized action to a photo menu created after the blocked event", async () => {
    const event = rightClick("pixels");
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(document.querySelector(selector)?.textContent).toBe("翻译图片");
    expect(document.querySelector(selector)?.getAttribute("translate")).toBe("no");
    expect(document.querySelector(selector)?.querySelector('[data-icon="font"]')).not.toBeNull();
    document.querySelector('[data-testid="Dropdown"]')!.append(document.createElement("span"));
    await Promise.resolve();
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(translate).not.toHaveBeenCalled();
  });

  it("retains the selected DOM image among duplicates, closes X's menu, and never invokes copy", async () => {
    document.body.insertAdjacentHTML("beforeend", '<div data-testid="tweetPhoto"><img id="duplicate" src="https://pbs.twimg.com/media/sample.jpg"></div>');
    rightClick("duplicate");
    await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
    const copy = vi.fn(); document.querySelector('[data-testid="copyPhotoLinkContextMenuItem"]')!.addEventListener("click", copy);
    document.querySelector<HTMLButtonElement>(selector)!.click();
    expect(translate).toHaveBeenCalledExactlyOnceWith({ image: document.getElementById("duplicate"), source: "https://pbs.twimg.com/media/sample.jpg" });
    expect(copy).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("keeps the native copy action unchanged", async () => {
    rightClick(); await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
    const copy = vi.fn(); const native = document.querySelector<HTMLElement>('[data-testid="copyPhotoLinkContextMenuItem"]')!;
    native.addEventListener("click", copy); native.click();
    expect(copy).toHaveBeenCalledOnce(); expect(translate).not.toHaveBeenCalled();
  });

  it("supports arrows, Home, End, and Escape alongside the original menu item", async () => {
    rightClick(); await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
    const native = document.querySelector<HTMLElement>('[data-testid="copyPhotoLinkContextMenuItem"]')!;
    native.focus();
    const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    press("ArrowDown"); expect(document.activeElement).toBe(document.querySelector(selector));
    press("Home"); expect(document.activeElement).toBe(native);
    press("End"); expect(document.activeElement).toBe(document.querySelector(selector));
    press("ArrowUp"); expect(document.activeElement).toBe(native);
    press("Escape"); await Promise.resolve();
    expect(document.querySelector('[role="menu"]')).toBeNull(); expect(translate).not.toHaveBeenCalled();
  });

  it.each(["ordinary-native-menu", "unrelated-X-menu", "non-photo-target"])("does not inject into %s", async mode => {
    if (mode === "ordinary-native-menu") blocked = false;
    if (mode === "unrelated-X-menu") renderMenu = false;
    rightClick(mode === "non-photo-target" ? "missing" : "photo");
    await Promise.resolve();
    expect(document.querySelector(selector)).toBeNull();
  });

  it("accepts an asynchronously mounted photo menu and follows its replacement without duplicating actions", async () => {
    renderMenu = false; rightClick(); await Promise.resolve();
    addMenu(); await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
    document.querySelector('[role="menu"]')!.replaceWith(addMenu());
    await vi.waitFor(() => expect(document.querySelectorAll(selector)).toHaveLength(1));
    expect(document.querySelector(selector)?.closest('[role="menu"]')?.isConnected).toBe(true);
  });

  it("cleans up when disabled and restores the site's menu sizing", async () => {
    rightClick(); await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    adapter.close();
    expect(document.querySelector(selector)).toBeNull(); expect(menu.style.maxHeight).toBe("300px");
    expect(menu.style.maxWidth).toBe(""); expect(menu.style.overflowY).toBe("");
    menu.append(document.createElement("span")); await Promise.resolve();
    expect(document.querySelector(selector)).toBeNull();
  });

  it("removes stale actions if the selected image changes", async () => {
    rightClick(); await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
    document.querySelector<HTMLImageElement>("#photo")!.src = "https://pbs.twimg.com/media/changed.jpg";
    await vi.waitFor(() => expect(document.querySelector(selector)).toBeNull());
    expect(translate).not.toHaveBeenCalled();
  });

  it("limits adaptation to X's actual hosts", () => {
    vi.stubGlobal("location", new URL("https://x.com.example.org/home"));
    expect(createXImageContextMenu(translate)).toBeUndefined();
  });
});
