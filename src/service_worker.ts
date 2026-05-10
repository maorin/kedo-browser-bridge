import { WSClient } from './lib/ws_client';
import {
  click, extract, getActiveTab, listTabs, navigate,
  query, screenshot, scroll, submit, typeText, waitFor,
} from './lib/actions';

const DEFAULT_WS_URL = 'ws://localhost:8000/api/ws/browser';
const HEARTBEAT_PERIOD_MIN = 0.4; // ~24 s; keeps the SW alive
const ALARM_NAME = 'kedo-heartbeat';
const CLIENT_VERSION = '0.4.1';

interface Config {
  wsUrl: string;
  token: string;
  roleHint: 'user' | 'agent';
  source: 'agent_pack' | 'storage';
}

let client: WSClient | null = null;
let connected = false;

async function getConfig(): Promise<Config | null> {
  // M4: when kedo launches an isolated chrome profile, it stages a writable copy
  // of the extension dist and writes kedo-config.json into it. Try to read that
  // first — if found, this SW is running inside the agent profile and should
  // report role=agent.
  try {
    const cfgUrl = chrome.runtime.getURL('kedo-config.json');
    const resp = await fetch(cfgUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data && typeof data.token === 'string' && data.token) {
        return {
          wsUrl: data.ws_url || DEFAULT_WS_URL,
          token: data.token,
          roleHint: data.role === 'agent' ? 'agent' : 'user',
          source: 'agent_pack',
        };
      }
    }
  } catch {
    /* config not present in this build → user profile, fall through */
  }
  // User profile path — read from chrome.storage.local (popup-saved config).
  const data = await chrome.storage.local.get(['wsUrl', 'token']);
  if (!data.token) return null;
  return {
    wsUrl: data.wsUrl || DEFAULT_WS_URL,
    token: data.token,
    roleHint: 'user',
    source: 'storage',
  };
}

async function ensureClient(): Promise<void> {
  const cfg = await getConfig();
  if (!cfg) return;
  if (!client) {
    client = new WSClient(cfg.wsUrl, cfg.token, CLIENT_VERSION, cfg.roleHint, (c) => {
      connected = c;
    });
    client.onMessage((msg) => {
      if (msg.type === 'command') {
        void handleCommand(msg);
        return;
      }
      if (msg.type === 'hello_nack') {
        console.warn('[kedo] hello_nack', msg.reason);
        return;
      }
      console.log('[kedo] ws', msg.type, msg);
    });
  }
  client.connect();
}

function resetClient(): void {
  client?.close();
  client = null;
  connected = false;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: HEARTBEAT_PERIOD_MIN });
  void ensureClient();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: HEARTBEAT_PERIOD_MIN });
  void ensureClient();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  void (async () => {
    await ensureClient();
    client?.send({ type: 'heartbeat', ts: Date.now() });
  })();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'cs_loaded') {
        // M4: content_script load is the wake-up signal in headless agent profile.
        // No response expected; just spin up the WS client.
        await ensureClient();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'get_status') {
        const cfg = await getConfig();
        sendResponse({ connected, configured: !!cfg, wsUrl: cfg?.wsUrl ?? DEFAULT_WS_URL });
        return;
      }
      if (msg.type === 'set_config') {
        await chrome.storage.local.set({
          wsUrl: (msg.wsUrl || DEFAULT_WS_URL).trim(),
          token: (msg.token || '').trim(),
        });
        resetClient();
        await ensureClient();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'send_to_kedo') {
        const result = await collectActiveTab(msg.userNote ?? null);
        if ('error' in result) {
          sendResponse({ ok: false, error: result.error });
          return;
        }
        client?.send({ type: 'user_inject', payload: result.payload });
        sendResponse({ ok: true });
        return;
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true; // keep the channel open for async sendResponse
});

async function handleCommand(msg: { id: string; action: string; params?: any }): Promise<void> {
  if (!client) return;
  const { id, action, params } = msg;
  try {
    let data: any;
    switch (action) {
      case 'list_tabs':      data = await listTabs(); break;
      case 'get_active_tab': data = await getActiveTab(params || {}); break;
      case 'navigate':       data = await navigate(params || {}); break;
      case 'screenshot':     data = await screenshot(params || {}); break;
      case 'extract':        data = await extract(params || {}); break;
      case 'query':          data = await query(params || {}); break;
      case 'wait_for':       data = await waitFor(params || {}); break;
      case 'click':          data = await click(params || {}); break;
      case 'type':           data = await typeText(params || {}); break;
      case 'submit':         data = await submit(params || {}); break;
      case 'scroll':         data = await scroll(params || {}); break;
      default:
        client.send({
          type: 'result',
          id,
          success: false,
          error: { code: 'UNKNOWN_ACTION', message: action },
        });
        return;
    }
    client.send({ type: 'result', id, success: true, data });
  } catch (err: any) {
    const error =
      err && typeof err === 'object' && 'code' in err
        ? { code: err.code, message: err.message }
        : { code: 'INTERNAL', message: String(err?.message || err) };
    client.send({ type: 'result', id, success: false, error });
  }
}

type CollectOk = { payload: Record<string, unknown> };
type CollectErr = { error: string };

async function collectActiveTab(userNote: string | null): Promise<CollectOk | CollectErr> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return { error: 'no active tab' };

  const blocked = ['chrome://', 'chrome-extension://', 'file://', 'devtools://'];
  if (blocked.some((p) => tab.url!.startsWith(p))) {
    return { error: `protocol blocked: ${tab.url}` };
  }

  let screenshot: string | null = null;
  try {
    if (tab.windowId !== undefined) {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    }
  } catch (err) {
    console.warn('[kedo] capture failed', err);
  }

  let extracted: any = null;
  try {
    extracted = await chrome.tabs.sendMessage(tab.id, { type: 'extract_readable' });
  } catch {
    return { error: 'content script unavailable — refresh the page and retry' };
  }
  if (extracted?.error) {
    return { error: `extraction failed: ${extracted.error}` };
  }

  return {
    payload: {
      url: tab.url,
      title: extracted?.title || tab.title || '',
      dom_text: extracted?.text_content || '',
      excerpt: extracted?.excerpt || null,
      selection: extracted?.selection || null,
      screenshot_data_url: screenshot,
      user_note: userNote,
      captured_at: new Date().toISOString(),
    },
  };
}
