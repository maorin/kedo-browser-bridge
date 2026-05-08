import { WSClient } from './lib/ws_client';

const DEFAULT_WS_URL = 'ws://localhost:8765/ws/browser';
const HEARTBEAT_PERIOD_MIN = 0.4; // ~24 s; keeps the SW alive
const ALARM_NAME = 'kedo-heartbeat';
const CLIENT_VERSION = '0.1.0';

let client: WSClient | null = null;
let connected = false;

async function getConfig(): Promise<{ wsUrl: string; token: string } | null> {
  const data = await chrome.storage.local.get(['wsUrl', 'token']);
  if (!data.token) return null;
  return { wsUrl: data.wsUrl || DEFAULT_WS_URL, token: data.token };
}

async function ensureClient(): Promise<void> {
  const cfg = await getConfig();
  if (!cfg) return;
  if (!client) {
    client = new WSClient(cfg.wsUrl, cfg.token, CLIENT_VERSION, (c) => {
      connected = c;
    });
    client.onMessage((msg) => {
      // M1: only hello_ack and ack are meaningful. Everything else is logged.
      if (msg.type === 'hello_nack') {
        console.warn('[kedo] hello_nack', msg.reason);
      } else {
        console.log('[kedo] ws', msg.type, msg);
      }
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
