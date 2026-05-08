import { Readability } from '@mozilla/readability';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'extract_readable') {
    sendResponse(extractReadable());
    return true;
  }
  if (msg.type === 'query') {
    sendResponse(performQuery(msg.params || {}));
    return true;
  }
  if (msg.type === 'wait_for') {
    performWaitFor(msg.params || {}).then(
      sendResponse,
      (err) => sendResponse({ error: String(err?.message || err) }),
    );
    return true;
  }
  return false;
});

function extractReadable() {
  try {
    const cloned = document.cloneNode(true) as Document;
    const article = new Readability(cloned).parse();
    const selection = window.getSelection()?.toString().trim() || null;
    return {
      url: location.href,
      title: article?.title || document.title,
      text_content: article?.textContent?.trim() || '',
      excerpt: article?.excerpt || null,
      length: article?.length || 0,
      selection,
    };
  } catch (err) {
    return { error: String(err) };
  }
}

interface QueryParams {
  selector?: string;
  text_match?: string;
  aria_label?: string;
  limit?: number;
}

function isPasswordField(el: Element): boolean {
  if (el.tagName !== 'INPUT') return false;
  const t = (el as HTMLInputElement).type?.toLowerCase();
  if (t === 'password') return true;
  const ac = el.getAttribute('autocomplete')?.toLowerCase() || '';
  return ac.startsWith('cc-');
}

function attrEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function findElements(p: QueryParams): { el: Element; matched: 'selector' | 'text' | 'aria' }[] {
  const matches: { el: Element; matched: 'selector' | 'text' | 'aria' }[] = [];
  const seen = new Set<Element>();

  if (p.selector) {
    try {
      for (const el of Array.from(document.querySelectorAll(p.selector))) {
        if (!seen.has(el)) { matches.push({ el, matched: 'selector' }); seen.add(el); }
      }
    } catch {
      /* invalid selector — ignore, fall through to other strategies */
    }
  }
  if (p.aria_label) {
    const sel = `[aria-label="${attrEscape(p.aria_label)}"]`;
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (!seen.has(el)) { matches.push({ el, matched: 'aria' }); seen.add(el); }
    }
  }
  if (p.text_match) {
    const target = p.text_match.trim();
    const TAG_LIST = 'a, button, [role=button], h1, h2, h3, h4, h5, h6, span, p, label, td, li, summary';
    for (const el of Array.from(document.querySelectorAll(TAG_LIST))) {
      const txt = (el.textContent || '').trim();
      if (txt && txt.includes(target) && !seen.has(el)) {
        matches.push({ el, matched: 'text' });
        seen.add(el);
      }
    }
  }
  return matches;
}

function describe(el: Element, matched: string) {
  const rect = el.getBoundingClientRect();
  const link =
    (el as HTMLAnchorElement).href ||
    (el.closest('a') as HTMLAnchorElement | null)?.href ||
    null;
  const visible = rect.width > 0 && rect.height > 0;
  return {
    matched_strategy: matched,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    aria_label: el.getAttribute('aria-label'),
    text: (el.textContent || '').trim().slice(0, 200),
    href: link,
    visible,
    is_password_field: isPasswordField(el),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
  };
}

function performQuery(p: QueryParams) {
  const limit = p.limit || 20;
  const found = findElements(p);
  return {
    total: found.length,
    matches: found.slice(0, limit).map(({ el, matched }) => describe(el, matched)),
  };
}

interface WaitParams extends QueryParams {
  timeout_ms?: number;
  vanish?: boolean;
}

async function performWaitFor(p: WaitParams) {
  const start = Date.now();
  const timeout = p.timeout_ms || 30_000;
  const vanish = !!p.vanish;
  while (Date.now() - start < timeout) {
    const found = findElements(p);
    const condition = vanish ? found.length === 0 : found.length > 0;
    if (condition) {
      return { found: !vanish, elapsed_ms: Date.now() - start, count: found.length };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { error: 'WAIT_TIMEOUT', error_code: 'WAIT_TIMEOUT' };
}
