// LaTeX2HTML emits entire paragraphs as bare BODY sibling runs. A temporary
// inline source container gives them a paragraph boundary and a local viewport
// box without changing line breaking, links, images or the original nodes.
const sourceRuns = new Set<HTMLElement>();
const INLINE = /^(?:A|SPAN|B|BIG|SMALL|I|EM|STRONG|U|S|SUB|SUP|FONT|TT|CODE|NOBR|BR)$/u;
const BLOCKS = 'div,p,h1,h2,h3,h4,h5,h6,li,table,ul,ol,blockquote,section,article,header,footer,aside,nav,button,input,textarea,select,[contenteditable]';

// Grouping and skip decisions ask this question once per candidate element, so a
// document-wide `meta` query here dominated scans on ordinary pages. The answer
// cannot change while one scan runs — collection never mutates the page — and
// every scan starts by preparing these paragraphs, which drops the memo again.
const scientificDocuments = new WeakMap<Document, boolean>();

export function resetLegacyScientificDocumentCache(doc: Document = document): void {
  scientificDocuments.delete(doc);
}

export function isLegacyScientificDocument(doc: Document): boolean {
  const cached = scientificDocuments.get(doc);
  if (cached !== undefined) return cached;
  const value = [...doc.querySelectorAll('meta[name]')].some(meta =>
    meta.getAttribute('name')?.toLowerCase() === 'generator'
    && /^LaTeX2HTML\b/iu.test(meta.getAttribute('content') ?? ''));
  scientificDocuments.set(doc, value);
  return value;
}

export function prepareLegacyScientificParagraphs(root: Element): void {
  const doc = root.ownerDocument;
  resetLegacyScientificDocumentCache(doc);
  if (!isLegacyScientificDocument(doc) || !doc.body) return;
  // Incremental scans may start at a new inline child rather than at BODY.
  if (root !== doc.body && root.parentElement !== doc.body) return;
  let run: ChildNode[] = [];
  const flush = () => {
    if (run.some(node => /\p{L}/u.test(node.textContent ?? ''))) {
      const source = doc.createElement('span');
      source.dataset.wupageScientificSource = '';
      run[0].before(source);
      source.append(...run);
      sourceRuns.add(source);
    }
    run = [];
  };
  for (const node of [...doc.body.childNodes]) {
    if (node instanceof Text || node.nodeType === Node.COMMENT_NODE) { run.push(node); continue; }
    if (node instanceof Element && INLINE.test(node.tagName.toUpperCase()) && !sourceRuns.has(node as HTMLElement)
      && !node.matches('[clear], [role], [contenteditable], .wupage-translation, .wupage-translation-pending')
      && !node.querySelector(BLOCKS)) {
      run.push(node);
    } else flush();
  }
  flush();
}

export function clearLegacyScientificParagraphs(): void {
  for (const source of sourceRuns) source.replaceWith(...source.childNodes);
  sourceRuns.clear();
}

export function isLegacyScientificProseBlock(element: Element): boolean {
  if (sourceRuns.has(element as HTMLElement)) return true;
  return element.matches('div') && isLegacyScientificDocument(element.ownerDocument)
    && !element.matches('.navigation,.mathdisplay,.equation')
    && !element.querySelector(BLOCKS)
    && !/^(?:inline-)?(?:flex|grid)$/u.test(element.ownerDocument.defaultView?.getComputedStyle(element).display ?? '');
}

export function legacyScientificProseBlock(element: Element): Element | null {
  const candidate = element.closest('[data-wupage-scientific-source],div');
  return candidate && isLegacyScientificProseBlock(candidate) ? candidate : null;
}

export function isScientificMathImage(element: Element): boolean {
  return element.matches('.MATH') && Boolean(element.querySelector('img[alt]'))
    && [...element.querySelectorAll('img[alt]')].every(img => /^\s*\$[\s\S]*\$\s*$/u.test(img.getAttribute('alt') ?? ''));
}

export function isScientificCitation(element: Element): boolean {
  return element.matches('a[href]') && isLegacyScientificDocument(element.ownerDocument)
    && /^\s*\[?\d+(?:\s*[,–-]\s*\d+)*\]?\s*$/u.test(element.textContent ?? '');
}

export function isLegacyScientificEquation(element: Element): boolean {
  return Boolean(element.closest('.mathdisplay,table.equation,.eqno'))
    && isLegacyScientificDocument(element.ownerDocument);
}
