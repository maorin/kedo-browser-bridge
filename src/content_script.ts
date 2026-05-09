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
  if (msg.type === 'click') {
    sendResponse(performClick(msg.params || {}));
    return true;
  }
  if (msg.type === 'type') {
    sendResponse(performType(msg.params || {}));
    return true;
  }
  if (msg.type === 'submit') {
    sendResponse(performSubmit(msg.params || {}));
    return true;
  }
  if (msg.type === 'scroll') {
    sendResponse(performScroll(msg.params || {}));
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

// ---------- M3 write handlers ----------

interface ClickParams extends QueryParams {}

function performClick(p: ClickParams) {
  const found = findElements(p);
  if (found.length === 0) {
    return { error: 'ELEMENT_NOT_FOUND', error_code: 'ELEMENT_NOT_FOUND' };
  }
  const { el, matched } = found[0];
  if (isPasswordField(el)) {
    return { error: 'PASSWORD_FIELD_BLOCKED', error_code: 'PASSWORD_FIELD_BLOCKED' };
  }
  try {
    (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
    (el as HTMLElement).click();
    return {
      matched_strategy: matched,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 200),
      aria_label: el.getAttribute('aria-label'),
    };
  } catch (err) {
    return { error: String(err) };
  }
}

interface TypeParams {
  selector?: string;
  aria_label?: string;
  value: string;
  clear_first?: boolean;
  press_enter?: boolean;
}

function performType(p: TypeParams) {
  const found = findElements({
    selector: p.selector,
    aria_label: p.aria_label,
  });
  if (found.length === 0) {
    return { error: 'ELEMENT_NOT_FOUND', error_code: 'ELEMENT_NOT_FOUND' };
  }
  const { el } = found[0];
  if (isPasswordField(el)) {
    return { error: 'PASSWORD_FIELD_BLOCKED', error_code: 'PASSWORD_FIELD_BLOCKED' };
  }
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) && !(el as HTMLElement).isContentEditable) {
    return { error: 'NOT_AN_INPUT', error_code: 'NOT_AN_INPUT' };
  }

  const clearFirst = p.clear_first !== false;
  const value = p.value;

  try {
    (el as HTMLElement).focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (clearFirst) el.value = '';
      el.value = clearFirst ? value : (el.value + value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable
      if (clearFirst) (el as HTMLElement).innerText = '';
      (el as HTMLElement).innerText = clearFirst ? value : ((el as HTMLElement).innerText + value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    if (p.press_enter) {
      const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
      el.dispatchEvent(ev);
    }

    return {
      tag: el.tagName.toLowerCase(),
      typed_length: value.length,
      was_password: false,
    };
  } catch (err) {
    return { error: String(err) };
  }
}

interface SubmitParams {
  selector?: string;
}

function performSubmit(p: SubmitParams) {
  let form: HTMLFormElement | null = null;
  if (p.selector) {
    const el = document.querySelector(p.selector);
    if (el instanceof HTMLFormElement) form = el;
    else if (el) form = el.closest('form');
  } else {
    const focused = document.activeElement;
    if (focused) form = focused.closest('form');
  }
  if (!form) {
    return { error: 'FORM_NOT_FOUND', error_code: 'FORM_NOT_FOUND' };
  }
  try {
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else {
      form.submit();
    }
    return { form_action: form.action, form_method: form.method };
  } catch (err) {
    return { error: String(err) };
  }
}

interface ScrollParams {
  direction?: 'up' | 'down' | 'top' | 'bottom';
  selector?: string;
  amount?: number;
}

function performScroll(p: ScrollParams) {
  try {
    if (p.selector) {
      const el = document.querySelector(p.selector);
      if (!el) return { error: 'ELEMENT_NOT_FOUND', error_code: 'ELEMENT_NOT_FOUND' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      return { selector: p.selector, scroll_y: window.scrollY };
    }
    const amount = p.amount || 600;
    if (p.direction === 'up') window.scrollBy({ top: -amount, behavior: 'smooth' });
    else if (p.direction === 'down') window.scrollBy({ top: amount, behavior: 'smooth' });
    else if (p.direction === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
    else if (p.direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    return { direction: p.direction, scroll_y: window.scrollY };
  } catch (err) {
    return { error: String(err) };
  }
}
