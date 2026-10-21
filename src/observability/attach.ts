import type { HttpClient } from '../core/types.js';
import type { HttpPlugin } from '../plugins/types.js';
import type { RequestLogger, RequestLogHandle, RequestLogTimings, RequestLifecycleInput } from './request-logger.js';

interface RequestLogState {
  handle: RequestLogHandle;
  timings: RequestLogTimings;
  attempts: number;
  cache?: 'hit' | 'dedupe';
}

function metrics(state: RequestLogState): RequestLifecycleInput {
  return {
    timings: { ...state.timings },
    attempts: state.attempts,
    ...(state.cache ? { cache: state.cache } : {}),
  };
}

function scopedLoggerPlugin<TContext = unknown>(logger: RequestLogger): HttpPlugin<TContext> {
  const requests = new Map<string, RequestLogState>();
  return {
    setup: () => () => {
      for (const state of requests.values()) {
        state.handle.error({ ...metrics(state), error: new Error('Logger detached before request completed') });
      }
      requests.clear();
    },
    onEvent(event) {
      if (event.phase === 'request:start') {
        requests.set(event.requestId, {
          handle: logger.start({
            method: event.config.method ?? 'GET', url: event.config.url ?? '', headers: event.config.headers,
          }),
          timings: { queue: 0, retry: 0 },
          attempts: 0,
        });
        return;
      }
      const state = requests.get(event.requestId);
      if (!state) return;
      switch (event.phase) {
        case 'attempt:start': state.attempts++; break;
        case 'queue:end': state.timings.queue += event.duration ?? 0; break;
        case 'retry:end': state.timings.retry += event.duration ?? 0; break;
        case 'body:end': state.timings.body = (state.timings.body ?? 0) + (event.duration ?? 0); break;
        case 'cache:hit': state.cache = 'hit'; break;
        case 'cache:dedupe': state.cache = 'dedupe'; break;
        case 'request:end': {
          requests.delete(event.requestId);
          const details = { ...metrics(state), status: event.response?.status, duration: event.duration, error: event.error };
          if (event.error !== undefined || event.bodyOutcome === 'canceled' || event.bodyOutcome === 'error') state.handle.error(details);
          else state.handle.complete(details);
          break;
        }
      }
    },
  };
}

export function createRequestLoggerPlugin<TContext = unknown>(logger: RequestLogger): HttpPlugin<TContext> {
  return { create: () => scopedLoggerPlugin<TContext>(logger) };
}

export function attachRequestLogger<TContext, TDefaults>(client: HttpClient<TContext, TDefaults>, logger: RequestLogger): () => Promise<void> {
  return client.use(createRequestLoggerPlugin<TContext>(logger));
}
