type MessageHandler = (msg: any) => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private readonly maxDelay = 30_000;
  private readonly handlers: MessageHandler[] = [];
  private connected = false;
  private outgoing: any[] = [];
  private closing = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly clientVersion: string,
    private readonly onStatusChange: (connected: boolean) => void,
  ) {}

  connect(): void {
    if (this.closing) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const u = new URL(this.url);
    u.searchParams.set('token', this.token);
    this.ws = new WebSocket(u.toString());

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.onStatusChange(true);
      this.send({
        type: 'hello',
        client: 'kedo-browser-bridge',
        client_version: this.clientVersion,
        protocol_versions: ['1.0'],
        role_hint: 'user',
        token: this.token,
      });
      while (this.outgoing.length && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(this.outgoing.shift()));
      }
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        for (const h of this.handlers) h(msg);
      } catch (err) {
        console.warn('[kedo] bad ws frame', err);
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.onStatusChange(false);
      if (this.closing) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay);
      setTimeout(() => this.connect(), delay);
    };

    this.ws.onerror = () => {
      // onclose will fire next; nothing to do here.
    };
  }

  send(msg: any): void {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.outgoing.push(msg);
    }
  }

  onMessage(h: MessageHandler): void {
    this.handlers.push(h);
  }

  isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
  }
}
