// Service-worker-side implementations for browser actions issued by kedo agent.
// Each function either talks to chrome.* directly or forwards to the content
// script via chrome.tabs.sendMessage.

type Tab = chrome.tabs.Tab;

export interface ActionError {
  code: string;
  message: string;
}

export function aerr(code: string, message: string): ActionError {
  return { code, message };
}

const BLOCKED_SCHEMES = ['chrome://', 'chrome-extension://', 'file://', 'devtools://'];

function ensureAllowedUrl(url: string): void {
  if (BLOCKED_SCHEMES.some((p) => url.startsWith(p))) {
    throw aerr('PROTOCOL_BLOCKED', `scheme blocked: ${url}`);
  }
}

async function resolveTab(tab_id?: number): Promise<Tab> {
  // LLMs sometimes pass `0` as "active tab default" instead of omitting the field.
  // Defensively treat any non-positive value as "no tab_id given" → use active tab.
  if (typeof tab_id === 'number' && tab_id > 0) {
    return chrome.tabs.get(tab_id);
  }
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t?.id) throw aerr('INTERNAL', 'no active tab');
  return t;
}

export async function getActiveTab(params: { tab_id?: number }): Promise<any> {
  const tab = await resolveTab(params?.tab_id);
  return {
    tab_id: tab.id,
    window_id: tab.windowId,
    url: tab.url,
    title: tab.title,
    status: tab.status,
  };
}

export async function listTabs(): Promise<{ tabs: any[] }> {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      window_id: t.windowId,
      url: t.url,
      title: t.title,
      active: t.active,
      status: t.status,
    })),
  };
}

export async function navigate(params: {
  url: string;
  tab_id?: number;
  new_tab?: boolean;
  timeout_ms?: number;
}): Promise<any> {
  if (!params?.url) throw aerr('BAD_PARAMS', 'url required');
  ensureAllowedUrl(params.url);

  let tab: Tab;
  if (params.new_tab) {
    tab = await chrome.tabs.create({ url: params.url, active: true });
  } else if (params.tab_id !== undefined && params.tab_id !== null) {
    tab = await chrome.tabs.update(params.tab_id, { url: params.url });
  } else {
    const active = await resolveTab();
    tab = await chrome.tabs.update(active.id!, { url: params.url });
  }
  await waitForTabComplete(tab.id!, params.timeout_ms ?? 30_000);
  const final = await chrome.tabs.get(tab.id!);
  return {
    tab_id: final.id,
    url: final.url,
    title: final.title,
    status: final.status,
  };
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return resolve();
      } catch {
        return reject(aerr('INTERNAL', 'tab disappeared during navigation'));
      }
      if (Date.now() - start > timeoutMs) {
        return reject(aerr('NAVIGATION_TIMEOUT', `${timeoutMs}ms exceeded`));
      }
      setTimeout(check, 200);
    };
    check();
  });
}

export async function screenshot(params: { tab_id?: number }): Promise<{ data_url: string; tab_id: number }> {
  const tab = await resolveTab(params?.tab_id);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' });
  return { data_url: dataUrl, tab_id: tab.id! };
}

async function viaContentScript<T = any>(tab_id: number | undefined, payload: any): Promise<T> {
  const tab = await resolveTab(tab_id);
  ensureAllowedUrl(tab.url || '');
  let resp: any;
  try {
    resp = await chrome.tabs.sendMessage(tab.id!, payload);
  } catch (err: any) {
    throw aerr('INTERNAL', `content script unreachable: ${String(err?.message || err)}`);
  }
  if (resp?.error) throw aerr(resp.error_code || 'INTERNAL', String(resp.error));
  return resp;
}

export async function extract(params: { tab_id?: number }): Promise<any> {
  return viaContentScript(params?.tab_id, { type: 'extract_readable' });
}

export async function query(params: {
  tab_id?: number;
  selector?: string;
  text_match?: string;
  aria_label?: string;
  limit?: number;
}): Promise<any> {
  if (!params?.selector && !params?.text_match && !params?.aria_label) {
    throw aerr('BAD_PARAMS', 'at least one of selector/text_match/aria_label required');
  }
  return viaContentScript(params.tab_id, { type: 'query', params });
}

export async function waitFor(params: {
  tab_id?: number;
  selector?: string;
  text_match?: string;
  aria_label?: string;
  vanish?: boolean;
  timeout_ms?: number;
}): Promise<any> {
  if (!params?.selector && !params?.text_match && !params?.aria_label) {
    throw aerr('BAD_PARAMS', 'at least one of selector/text_match/aria_label required');
  }
  const timeout = Math.min(params.timeout_ms || 30_000, 60_000);
  return viaContentScript(params.tab_id, {
    type: 'wait_for',
    params: { ...params, timeout_ms: timeout },
  });
}

// ---------- M3 write actions (delegate to content script) ----------

export async function click(params: {
  tab_id?: number;
  selector?: string;
  text_match?: string;
  aria_label?: string;
}): Promise<any> {
  if (!params?.selector && !params?.text_match && !params?.aria_label) {
    throw aerr('BAD_PARAMS', 'at least one of selector/text_match/aria_label required');
  }
  return viaContentScript(params.tab_id, { type: 'click', params });
}

export async function typeText(params: {
  tab_id?: number;
  selector?: string;
  aria_label?: string;
  value: string;
  clear_first?: boolean;
  press_enter?: boolean;
}): Promise<any> {
  if (params?.value === undefined || params.value === null) {
    throw aerr('BAD_PARAMS', 'value required');
  }
  if (!params.selector && !params.aria_label) {
    throw aerr('BAD_PARAMS', 'selector or aria_label required');
  }
  return viaContentScript(params.tab_id, { type: 'type', params });
}

export async function submit(params: {
  tab_id?: number;
  selector?: string;
}): Promise<any> {
  return viaContentScript(params?.tab_id, { type: 'submit', params: params || {} });
}

export async function scroll(params: {
  tab_id?: number;
  direction?: 'up' | 'down' | 'top' | 'bottom';
  selector?: string;
  amount?: number;
}): Promise<any> {
  if (!params?.direction && !params?.selector) {
    throw aerr('BAD_PARAMS', 'direction or selector required');
  }
  return viaContentScript(params.tab_id, { type: 'scroll', params });
}
