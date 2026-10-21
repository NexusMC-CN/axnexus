import { HttpError } from '../core/errors.js';
import { raceWithSignal, signalReason } from '../core/control.js';
import { scheduleTimer } from '../core/lifecycle/timers.js';
import { validateStandardSchema } from '../core/schema.js';
import type { StreamDecodeOptions, StreamOptions } from './types.js';

export function invalidConfig(message: string): never {
  throw new HttpError(message, { code: 'ERR_INVALID_CONFIG' });
}

export function validateStreamOptions(options: StreamOptions): number {
  const limit = options.maxMessageSize ?? 1_048_576;
  if (!Number.isSafeInteger(limit) || limit < 0) invalidConfig('maxMessageSize must be a non-negative safe integer');
  if (options.idleTimeout !== undefined && (!Number.isFinite(options.idleTimeout) || options.idleTimeout < 0)) {
    invalidConfig('idleTimeout must be a finite non-negative number');
  }
  return limit;
}

export function assertMessageSize(size: number, limit: number): void {
  if (size > limit) throw new HttpError('Stream message exceeds maxMessageSize', { code: 'ERR_MAX_BODY_SIZE' });
}

/** Owns the reader even while the consumer is suspended at a yielded value. */
export class StreamReader {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly reader?: ReadableStreamDefaultReader<Uint8Array>;
  private readonly externalSignal?: AbortSignal;
  private readonly idleTimeout: number;
  private readonly onAbort: () => void;
  private closed = false;
  private ended = false;

  constructor(response: Response, options: StreamOptions) {
    this.reader = response.body?.getReader();
    this.externalSignal = options.signal;
    this.idleTimeout = options.idleTimeout ?? 0;
    this.onAbort = () => this.abort(signalReason(this.externalSignal!));
    if (this.externalSignal?.aborted) this.onAbort();
    else this.externalSignal?.addEventListener('abort', this.onAbort, { once: true });
  }

  abort(reason: unknown = new DOMException('Stream iteration stopped', 'AbortError')): void {
    if (!this.signal.aborted) this.controller.abort(reason);
    this.close(reason);
  }

  close(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.externalSignal?.removeEventListener('abort', this.onAbort);
    if (!this.reader) return;
    try {
      // Do not wait for an uncooperative source's cancel promise to release the
      // lock or to reject an aborted read. Observe its rejection independently.
      if (!this.ended) void this.reader.cancel(reason).catch(() => undefined);
    } finally {
      this.reader.releaseLock();
    }
  }

  async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    this.signal.throwIfAborted();
    if (!this.reader) { this.ended = true; return { done: true, value: undefined }; }
    const cancelTimer = this.idleTimeout > 0 ? scheduleTimer(() => this.abort(new HttpError('Stream idle timeout', {
      code: 'ETIMEDOUT', isTimeout: true, retryable: true,
    })), this.idleTimeout) : undefined;
    try {
      const result = await raceWithSignal(this.reader.read(), this.signal);
      this.signal.throwIfAborted();
      if (result.done) this.ended = true;
      return result;
    } finally {
      cancelTimer?.();
    }
  }
}

/** Intercept return() so it also interrupts an outstanding next()/validator. */
export function consumeResponse<T>(response: Response, options: StreamOptions, run: (reader: StreamReader) => AsyncGenerator<T>): AsyncIterable<T> {
  validateStreamOptions(options);
  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
      const reader = new StreamReader(response, options);
      const generator = (async function* () {
        let reason: unknown;
        try { yield* run(reader); }
        catch (error) { reason = error; throw error; }
        finally { reader.close(reason); }
      })();
      return {
        next: (value?: unknown) => generator.next(value),
        async return(value?: unknown) { reader.abort(); return generator.return(value as never); },
        async throw(error?: unknown) { reader.abort(error); return generator.throw(error); },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

export interface DecodedLine { text: string; bytes: number; terminated: boolean }

/** Split at ASCII delimiters before UTF-8 decoding, retaining at most one bounded line. */
export async function* decodeLines(reader: StreamReader, limit: number | (() => number)): AsyncGenerator<DecodedLine> {
  let parts: Uint8Array[] = [];
  let size = 0;
  let skipLF = false;
  let first = true;
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const append = (part: Uint8Array) => {
    size += part.byteLength;
    assertMessageSize(size, typeof limit === 'function' ? limit() : limit);
    if (part.byteLength) parts.push(part);
  };
  const finish = (terminated: boolean): DecodedLine => {
    let bytes: Uint8Array;
    if (parts.length === 1) bytes = parts[0];
    else {
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    }
    let text = decoder.decode(bytes);
    if (first) { first = false; if (text.startsWith('\uFEFF')) text = text.slice(1); }
    const line = { text, bytes: size, terminated };
    parts = [];
    size = 0;
    return line;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (size > 0) yield finish(false);
      return;
    }
    let start = 0;
    for (let index = 0; index < value.byteLength; index += 1) {
      reader.signal.throwIfAborted();
      const byte = value[index];
      if (skipLF) {
        skipLF = false;
        if (byte === 10) { start = index + 1; continue; }
      }
      if (byte !== 10 && byte !== 13) continue;
      append(value.subarray(start, index));
      skipLF = byte === 13;
      start = index + 1;
      yield finish(true);
    }
    append(value.subarray(start));
  }
}

export async function decodeValue<T>(text: string, response: Response, reader: StreamReader, options: StreamDecodeOptions<T>, json: boolean): Promise<T> {
  reader.signal.throwIfAborted();
  let value: unknown = text;
  if (json || options.parseJson) {
    try {
      value = await raceWithSignal((options.parseJson ?? JSON.parse)(text), reader.signal);
    } catch (cause) {
      if (reader.signal.aborted) throw signalReason(reader.signal);
      throw new HttpError('Stream message JSON parsing failed', { code: 'ERR_BAD_PAYLOAD', status: response.status, cause });
    }
  }
  if (options.schema) {
    try {
      value = await raceWithSignal(validateStandardSchema(value, options.schema), reader.signal);
    } catch (cause) {
      if (reader.signal.aborted) throw signalReason(reader.signal);
      throw new HttpError('Stream message schema validation failed', { code: 'ERR_SCHEMA_VALIDATION', status: response.status, cause });
    }
  }
  reader.signal.throwIfAborted();
  return value as T;
}
