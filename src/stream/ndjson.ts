import { consumeResponse, decodeLines, decodeValue, validateStreamOptions } from './decoder.js';
import type { ParserStreamOptions, SchemaStreamOptions, StreamDecodeOptions, StreamOptions } from './types.js';

export function parseNDJSON<T>(response: Response, options: SchemaStreamOptions<T>): AsyncIterable<T>;
export function parseNDJSON<T>(response: Response, options: ParserStreamOptions<T>): AsyncIterable<T>;
export function parseNDJSON(response: Response, options?: StreamOptions): AsyncIterable<unknown>;
export function parseNDJSON<T>(response: Response, options: StreamDecodeOptions<T> = {}): AsyncIterable<T> {
  const limit = validateStreamOptions(options);
  return consumeResponse(response, options, async function* (reader) {
    for await (const line of decodeLines(reader, limit)) {
      if (!line.text.trim()) continue;
      yield await decodeValue(line.text, response, reader, options, true);
    }
  });
}
