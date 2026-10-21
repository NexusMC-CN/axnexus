import { assertMessageSize, consumeResponse, decodeLines, decodeValue, validateStreamOptions } from './decoder.js';
import type { ParserStreamOptions, SchemaStreamOptions, SSEEvent, StreamDecodeOptions, StreamOptions } from './types.js';

export interface SSEState { id: string; retry?: number }

/** Internal state channel includes id/retry-only frames, which do not dispatch events. */
export function parseSSEWithState<T>(response: Response, options: StreamDecodeOptions<T>, initialId = '', onState?: (state: SSEState) => void): AsyncIterable<SSEEvent<T>> {
  const limit = validateStreamOptions(options);
  return consumeResponse(response, options, async function* (reader) {
    let data: string[] = [];
    let event = '';
    let id = initialId;
    let committedId = initialId;
    let retry: number | undefined;
    let size = 0;
    for await (const line of decodeLines(reader, () => limit - size)) {
      reader.signal.throwIfAborted();
      // The SSE protocol dispatches only at an empty terminated line. Pending
      // data at EOF, including a final unterminated line, is discarded.
      size += line.bytes;
      assertMessageSize(size, limit);
      if (!line.terminated) return;
      if (line.text === '') {
        committedId = id;
        onState?.({ id: committedId, retry });
        if (data.length) {
          const value = await decodeValue(data.join('\n'), response, reader, options, false);
          yield { data: value, event: event || 'message', id, ...(retry === undefined ? {} : { retry }) };
        }
        data = [];
        event = '';
        size = 0;
        continue;
      }
      if (line.text.startsWith(':')) continue;
      const colon = line.text.indexOf(':');
      const field = colon === -1 ? line.text : line.text.slice(0, colon);
      let value = colon === -1 ? '' : line.text.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      else if (field === 'id' && !value.includes('\0')) id = value;
      else if (field === 'retry' && /^\d+$/.test(value)) {
        const milliseconds = Number(value);
        if (Number.isSafeInteger(milliseconds)) { retry = milliseconds; onState?.({ id: committedId, retry }); }
      }
    }
  });
}

export function parseSSE<T>(response: Response, options: SchemaStreamOptions<T>): AsyncIterable<SSEEvent<T>>;
export function parseSSE<T>(response: Response, options: ParserStreamOptions<T>): AsyncIterable<SSEEvent<T>>;
export function parseSSE(response: Response, options?: StreamOptions): AsyncIterable<SSEEvent<string>>;
export function parseSSE<T>(response: Response, options: StreamDecodeOptions<T> = {}): AsyncIterable<SSEEvent<T>> {
  return parseSSEWithState(response, options);
}
