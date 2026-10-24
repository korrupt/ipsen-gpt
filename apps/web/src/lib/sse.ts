export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Incremental parser for text/event-stream. Feed it decoded text in any
 * chunking; it emits complete events. Comment lines (": ping") are ignored.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  /** Previous chunk ended in '\r'; a leading '\n' now belongs to that CRLF. */
  private skipLeadingLf = false;

  constructor(private readonly onMessage: (msg: SseMessage) => void) {}

  push(text: string): void {
    if (this.skipLeadingLf && text.startsWith('\n')) text = text.slice(1);
    if (text) this.skipLeadingLf = text.endsWith('\r');
    this.buffer += text;
    const lines = this.buffer.split(/\r\n|\r|\n/);
    // The last element is an incomplete line (or ''), keep it for next time.
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) {
        this.onMessage({ event: this.event || 'message', data: this.data.join('\n') });
      }
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}
