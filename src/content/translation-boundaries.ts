// Formatting can share a sentence; components and interaction targets own
// their text. Unknown custom tag names are boundaries by default.
const OWNER_SELECTOR = "button,[role='button'],[role='tab'],[role^='menuitem'],[role='option'],"
  + "[tabindex],[onclick],[slot],input,textarea,select";

export function translationOwner(element: Element): Element | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.localName.includes("-") || current.matches(OWNER_SELECTOR)) return current;
  }
  return null;
}

export function constrainTranslationOwner(element: Element, candidate: Element | null): Element | null {
  const owner = translationOwner(element);
  if (!owner || !candidate || owner.contains(candidate)) return candidate;
  // The outer paragraph/cell cannot define how an unknown component's own
  // fields are related. Keep the nearest text host instead of aggregating the
  // component's unrelated children into one output at its end.
  return candidate.contains(owner) ? element : null;
}
