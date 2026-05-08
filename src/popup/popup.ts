function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
}

const statusEl = $<HTMLDivElement>('status');
const configEl = $<HTMLElement>('config');
const mainEl = $<HTMLElement>('main');
const wsUrlInput = $<HTMLInputElement>('wsUrl');
const tokenInput = $<HTMLInputElement>('token');
const noteInput = $<HTMLTextAreaElement>('note');

function setStatus(text: string, kind: 'ok' | 'pending' | 'error' = 'pending') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

async function refreshStatus() {
  const r = await chrome.runtime.sendMessage({ type: 'get_status' });
  if (!r.configured) {
    setStatus('Not configured', 'pending');
    configEl.hidden = false;
    mainEl.hidden = true;
    if (r.wsUrl && !wsUrlInput.value) wsUrlInput.value = r.wsUrl;
    return;
  }
  if (r.connected) setStatus('✓ Connected', 'ok');
  else setStatus('… reconnecting', 'pending');
  configEl.hidden = true;
  mainEl.hidden = false;
}

$<HTMLButtonElement>('saveCfg').addEventListener('click', async () => {
  const wsUrl = wsUrlInput.value.trim();
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus('Token required', 'error');
    return;
  }
  await chrome.runtime.sendMessage({ type: 'set_config', wsUrl, token });
  setStatus('… connecting', 'pending');
  setTimeout(refreshStatus, 500);
});

$<HTMLButtonElement>('reconfig').addEventListener('click', () => {
  configEl.hidden = false;
  mainEl.hidden = true;
});

$<HTMLButtonElement>('send').addEventListener('click', async () => {
  const note = noteInput.value;
  setStatus('Sending…', 'pending');
  const r = await chrome.runtime.sendMessage({ type: 'send_to_kedo', userNote: note });
  if (r.ok) {
    setStatus('✓ Sent to kedo inbox', 'ok');
    noteInput.value = '';
  } else {
    setStatus(`✕ ${r.error || 'failed'}`, 'error');
  }
});

void refreshStatus();
setInterval(refreshStatus, 2000);
