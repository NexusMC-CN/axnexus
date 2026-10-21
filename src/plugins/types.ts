import type { HttpClient, HttpResponse, RequestConfig } from '../core/types.js';

export type RequestPhase = 'request:start' | 'request:end' | 'attempt:start' | 'attempt:end'
  | 'queue:start' | 'queue:end' | 'retry:start' | 'retry:end'
  | 'transport:start' | 'transport:end' | 'cache:hit' | 'cache:dedupe' | 'body:start' | 'body:end';

/** Local observer data. Context is never automatically sent over HTTP or logged. */
export interface RequestEvent<TContext = unknown> {
  phase: RequestPhase;
  requestId: string;
  config: RequestConfig<TContext>;
  context: TContext | undefined;
  attempt?: number;
  response?: HttpResponse<unknown>;
  error?: unknown;
  /** Elapsed milliseconds for the phase ending in this event. */
  duration?: number;
  bodyOutcome?: 'complete' | 'error' | 'canceled';
}

export interface HttpPlugin<TContext = unknown> {
  /** Create client-local state when one plugin definition is reused. */
  create?(): HttpPlugin<TContext>;
  /** Synchronous registration; return cleanup for resources or interceptor IDs. */
  setup?(client: HttpClient<TContext>): void | (() => void | Promise<void>);
  /** Observers cannot replace request results. Exceptions are isolated. */
  onEvent?(event: RequestEvent<TContext>): void | Promise<void>;
}

export interface RequestEvents {
  active(): boolean;
  emit(event: RequestEvent): void;
}
