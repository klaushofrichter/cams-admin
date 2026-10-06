import { EventEmitter } from 'events';

// A stand-in for an express Response used as an SSE stream.
export class FakeRes extends EventEmitter {
  chunks: string[] = [];
  headers: Record<string, string> = {};
  status = 200;
  ended = false;
  setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  flushHeaders() {}
  write(s: string) { this.chunks.push(s); return true; }
  end() { this.ended = true; this.emit('close'); }
  events(name: string) { return this.chunks.filter((c) => c.startsWith(`event: ${name}\n`)).map((c) => JSON.parse(c.split('\ndata: ')[1])); }
}
