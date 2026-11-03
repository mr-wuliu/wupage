import { applyPopupMenuLayout, DEFAULT_POPUP_MENU, isPopupMenuLink, normalizePopupMenu, POPUP_MENU_GROUPS, POPUP_MENU_ITEMS,
  type PopupMenuItem, type PopupMenuLayout } from "../shared/popup-menu";
import { uiIconMarkup } from "../shared/ui-icons";
import "./popup-menu.css";
import { showActionStatus } from "./action-feedback";

export function setupPopupMenuControls(root: HTMLElement): { render: (value: unknown) => void; read: () => PopupMenuLayout } {
  const query = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const list = query("#popupMenuItems"), preview = query("#popupMenuPreview"), grid = query("[data-popup-menu-grid]");
  const status = query("#popupMenuStatus"), footer = query("[data-popup-menu-footer]");
  const buttons = new Map<PopupMenuItem, HTMLButtonElement>(), available = new Map<PopupMenuItem, HTMLButtonElement>();
  let draft = normalizePopupMenu(undefined);
  let drag: { id: PopupMenuItem; pointer: number; x: number; y: number; lastX: number; lastY: number;
    offsetRatio: number; offsetY: number; originalRows: PopupMenuItem[][]; ghost?: HTMLElement; frame?: number;
    snapArea?: { left: number; right: number; top: number; bottom: number } } | undefined;
  let suppressClick = false;
  const visible = () => draft.order.filter(id => !draft.hidden.includes(id));
  const label = (id: PopupMenuItem) => POPUP_MENU_ITEMS.find(item => item.id === id)!.label;

  for (const group of POPUP_MENU_GROUPS) {
    const section = document.createElement("section"); section.className = "menu-library-group";
    section.dataset.menuLibraryGroup = group.id;
    const heading = document.createElement("h4"); heading.textContent = group.label;
    const items = document.createElement("div"); items.className = "menu-library-buttons";
    section.append(heading, items); list.append(section);
    for (const item of POPUP_MENU_ITEMS.filter(item => item.group === group.id)) {
      const button = document.createElement("button"); button.type = "button";
      button.dataset.popupMenuItem = item.id; button.textContent = item.label;
      const removeIcon = document.createElement("span"); removeIcon.className = "menu-preview-remove";
      removeIcon.setAttribute("aria-hidden", "true"); removeIcon.innerHTML = uiIconMarkup("cross"); button.append(removeIcon);
      button.setAttribute("aria-label", `移除${item.label}`);
      button.title = isPopupMenuLink(item.id) ? `点击移除${item.label}；链接固定在底部` : `点击移除${item.label}；拖动或按 Alt + 方向键排序`;
      button.setAttribute("aria-describedby", "popupMenuKeyboardHint");
      if (item.group === "features" || item.id === "paragraphMode") button.className = "menu-preview-feature";
      if (item.id === "pageToggle") button.className = "menu-preview-primary";
      if (item.group === "links") button.className = "menu-preview-link";
      buttons.set(item.id, button); (isPopupMenuLink(item.id) ? footer : grid).append(button);
      const add = document.createElement("button"); add.type = "button"; add.dataset.menuAdd = item.id;
      add.className = "menu-library-button"; add.setAttribute("aria-label", `添加${item.label}`);
      const plus = document.createElement("span"); plus.className = "menu-library-add-icon";
      plus.innerHTML = uiIconMarkup("plus"); plus.setAttribute("aria-hidden", "true");
      add.append(document.createTextNode(item.label), plus); items.append(add); available.set(item.id, add);
      add.addEventListener("click", () => {
        draft.hidden = draft.hidden.filter(id => id !== item.id);
        if (!isPopupMenuLink(item.id)) {
          const last = draft.rows.at(-1);
          if (last?.length === 1) last.push(item.id);
          else draft.rows.push([item.id]);
        }
        draft = normalizePopupMenu(draft);
        paint(); button.focus({ preventScroll: true });
        status.textContent = `已添加${item.label}，保存后生效。`;
      });
      button.addEventListener("click", event => {
        if (suppressClick) { event.preventDefault(); return; }
        remove(item.id);
      });
      button.addEventListener("keydown", event => {
        if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); remove(item.id); return; }
        if (isPopupMenuLink(item.id)) return;
        if (!event.altKey || !["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const ids = draft.rows.flat(), from = ids.indexOf(item.id);
        const to = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1
          : from + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1);
        if (to < 0 || to >= ids.length || from === to) return;
        move(item.id, ids[to]); button.focus({ preventScroll: true });
        status.textContent = `已移动${item.label}，保存后生效。`;
      });
    }
  }

  function remove(id: PopupMenuItem): void {
    draft = normalizePopupMenu({ ...draft, hidden: [...draft.hidden, id] }); paint(); available.get(id)!.focus({ preventScroll: true });
    status.textContent = `已移除${label(id)}，可从右侧重新添加。保存后生效。`;
  }

  function paint(): void {
    applyPopupMenuLayout(preview, draft);
    for (const [id, button] of available) button.hidden = !draft.hidden.includes(id);
    for (const section of list.querySelectorAll<HTMLElement>("[data-menu-library-group]")) {
      section.hidden = ![...section.querySelectorAll<HTMLButtonElement>("button")].some(button => !button.hidden);
    }
    query("#popupMenuLibraryEmpty").hidden = draft.hidden.length > 0;
    query("#popupMenuPreviewEmpty").hidden = draft.rows.length > 0;
    query("#popupMenuSelectedCount").textContent = String(visible().length);
    query("#popupMenuAvailableCount").textContent = String(draft.hidden.length);
  }

  function move(id: PopupMenuItem, target: PopupMenuItem): void {
    const ids = draft.rows.flat(), targetIndex = ids.indexOf(target);
    ids.splice(ids.indexOf(id), 1); ids.splice(targetIndex, 0, id);
    let offset = 0;
    repaintRows(draft.rows.map(row => { const result = ids.slice(offset, offset + row.length); offset += row.length; return result; }));
  }

  function repaintRows(rows: PopupMenuItem[][]): void {
    const before = new Map([...buttons.values()].map(button => [button, button.getBoundingClientRect()]));
    draft = normalizePopupMenu({ ...draft, rows });
    paint();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    for (const [button, rect] of before) {
      if (button.dataset.popupMenuItem === drag?.id || button.hasAttribute("data-popup-menu-hidden")) continue;
      const after = button.getBoundingClientRect();
      const x = rect.left - after.left, y = rect.top - after.top;
      if (x || y) button.animate?.([{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }],
        { duration: 170, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }

  function snap(): void {
    if (!drag?.ghost) return;
    const rect = grid.getBoundingClientRect(), { lastX: x, lastY: y } = drag;
    if (x < rect.left - 24 || x > rect.right + 24 || y < rect.top - 24 || y > rect.bottom + 24) return;
    const area = drag.snapArea;
    if (area && x >= area.left && x <= area.right && y >= area.top && y <= area.bottom) return;
    // Read final row positions rather than animated rectangles or the moving placeholder.
    const candidates = draft.rows.map(row => row.filter(id => id !== drag!.id)).filter(row => row.length).map(row => {
      const button = buttons.get(row[0])!;
      const top = rect.top + button.offsetTop, bottom = top + button.offsetHeight;
      return { row, top, bottom, distance: y < top ? top - y : y > bottom ? y - bottom : 0 };
    });
    if (!candidates.length) return;
    const target = candidates.reduce((a, b) => a.distance < b.distance ? a : b);
    const rows = draft.rows.map(row => row.filter(id => id !== drag!.id)).filter(row => row.length);
    const index = rows.findIndex(row => row.includes(target.row[0]));
    const edge = 9;
    if (y < target.top + edge || y > target.bottom - edge) {
      const after = y >= (target.top + target.bottom) / 2;
      rows.splice(index + (after ? 1 : 0), 0, [drag.id]);
      drag.snapArea = { left: rect.left - 24, right: rect.right + 24,
        top: after ? target.bottom - edge : target.top - 24, bottom: after ? target.bottom + 24 : target.top + edge };
    } else {
      const column = x < rect.left + rect.width / 2 ? 0 : 1;
      rows[index].splice(column, 0, drag.id);
      if (rows[index].length > 2) rows.splice(index + 1, 0, [rows[index].pop()!]);
      drag.snapArea = { left: column === 0 ? rect.left - 24 : rect.left + rect.width / 2 - 8,
        right: column === 0 ? rect.left + rect.width / 2 + 8 : rect.right + 24, top: target.top + edge, bottom: target.bottom - edge };
    }
    if (JSON.stringify(rows) !== JSON.stringify(draft.rows)) repaintRows(rows);
  }

  function scrollWhileDragging(): void {
    if (!drag?.ghost) return;
    const y = drag.lastY, edge = 56;
    const distance = y < edge ? -Math.ceil((edge - y) / 5) : y > innerHeight - edge ? Math.ceil((y - innerHeight + edge) / 5) : 0;
    if (distance) { window.scrollBy(0, distance); snap(); }
    drag.frame = requestAnimationFrame(scrollWhileDragging);
  }

  function finish(cancel: boolean): void {
    if (!drag) return;
    const state = drag; drag = undefined;
    if (state.frame !== undefined) cancelAnimationFrame(state.frame);
    if (!state.ghost) return;
    state.ghost.remove(); buttons.get(state.id)!.removeAttribute("data-menu-dragging");
    preview.removeAttribute("data-menu-sorting");
    if (root.hasPointerCapture?.(state.pointer)) root.releasePointerCapture(state.pointer);
    if (cancel) { draft = normalizePopupMenu({ ...draft, rows: state.originalRows }); paint(); }
    suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
    buttons.get(state.id)!.focus({ preventScroll: true });
    status.textContent = cancel ? "已取消拖动。" : `已调整${label(state.id)}的位置，保存后生效。`;
  }

  grid.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    const button = (event.target as Element).closest<HTMLElement>("[data-popup-menu-item]");
    if (!button) return;
    const rect = button.getBoundingClientRect();
    drag = { id: button.dataset.popupMenuItem as PopupMenuItem, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      lastX: event.clientX, lastY: event.clientY, offsetRatio: (event.clientX - rect.left) / rect.width,
      offsetY: event.clientY - rect.top, originalRows: draft.rows.map(row => [...row]) };
  });
  root.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.lastX = event.clientX; drag.lastY = event.clientY;
    if (!drag.ghost && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    event.preventDefault();
    if (!drag.ghost) {
      const button = buttons.get(drag.id)!, rect = button.getBoundingClientRect();
      root.setPointerCapture?.(drag.pointer);
      const ghost = document.createElement("div"); ghost.className = `menu-drag-ghost ${button.className}`;
      ghost.textContent = label(drag.id); ghost.setAttribute("aria-hidden", "true"); ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`;
      root.append(ghost); drag.ghost = ghost; button.setAttribute("data-menu-dragging", ""); preview.setAttribute("data-menu-sorting", "");
      status.textContent = "拖近目标位置即可吸附，松开鼠标放置。按 Esc 取消。";
      scrollWhileDragging();
    }
    snap();
    const width = buttons.get(drag.id)!.offsetWidth;
    drag.ghost.style.width = `${width}px`;
    drag.ghost.style.transform = `translate3d(${event.clientX - width * drag.offsetRatio}px, ${event.clientY - drag.offsetY}px, 0) scale(1.03)`;
  });
  root.addEventListener("pointerup", event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const rect = preview.getBoundingClientRect();
    finish(event.clientX < rect.left - 24 || event.clientX > rect.right + 24 || event.clientY < rect.top - 24 || event.clientY > rect.bottom + 24);
  });
  root.addEventListener("pointercancel", () => finish(true));
  root.addEventListener("lostpointercapture", () => finish(true));
  document.addEventListener("keydown", event => { if (event.key === "Escape" && drag) { event.preventDefault(); finish(true); } });
  // A pending press can leave the editor before it captures the pointer.
  document.addEventListener("pointerup", () => { if (drag && !drag.ghost) drag = undefined; });
  window.addEventListener("blur", () => finish(true));
  window.addEventListener("pagehide", () => finish(true));
  root.querySelector("#resetPopupMenu")!.addEventListener("click", () => {
    finish(true); draft = normalizePopupMenu(DEFAULT_POPUP_MENU); paint(); showActionStatus(status, "已恢复默认布局，保存后生效。");
  });
  return {
    render(value) { finish(true); draft = normalizePopupMenu(value); status.textContent = ""; paint(); },
    read: () => normalizePopupMenu(draft)
  };
}
