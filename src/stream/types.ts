import type { StandardSchema } from '../core/schema.js';

export interface StreamOptions {
  signal?: AbortSignal;
  /** UTF-8 bytes per record/frame, including SSE fields and comments, excluding line delimiters. Default: 1 MiB. */
  maxMessageSize?: number;
  /** Maximum wait for the next body chunk in milliseconds. Zero disables it; consumer processing time is excluded. */
  idleTimeout?: number;
}

export interface StreamDecodeOptions<T = unknown> extends StreamOptions {
  parseJson?: (text: string) => unknown | Promise<unknown>;
  schema?: StandardSchema<T>;
}

export interface SchemaStreamOptions<T> extends StreamDecodeOptions<T> {
  schema: StandardSchema<T>;
}

export interface ParserStreamOptions<T> extends StreamOptions {
  parseJson: (text: string) => T | Promise<T>;
  schema?: never;
}

export interface SSEEvent<T = string> {
  data: T;
  event: string;
  /** Last valid id, retained across frames; an empty id resets it. */
  id: string;
  /** Last valid server retry delay, retained across frames. */
  retry?: number;
}
