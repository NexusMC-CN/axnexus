import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Context, Span, Tracer } from '@opentelemetry/api';
import type { HttpPlugin } from '../plugins/types.js';
import { isHttpError } from '../core/errors.js';

export interface OpenTelemetryOptions {
  tracer: Tracer;
}

/** Uses an application-owned tracer; no SDK, exporter or global provider is installed. */
function scopedTelemetryPlugin<TContext = unknown>(options: OpenTelemetryOptions): HttpPlugin<TContext> {
  const requests = new Map<string, { span: Span; context: Context; attempts: Map<number, Span> }>();
  const finish = (span: Span, error?: unknown, status?: number) => {
    if (status !== undefined) span.setAttribute('http.response.status_code', status);
    if (error !== undefined || (status !== undefined && status >= 400)) {
      // Error messages and URLs can contain credentials. Record classification only.
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (isHttpError(error)) {
        span.setAttribute('error.type', error.code);
      }
    }
    span.end();
  };
  return {
    setup: () => () => {
      for (const request of requests.values()) {
        for (const span of request.attempts.values()) finish(span, new Error('Plugin detached'));
        finish(request.span, new Error('Plugin detached'));
      }
      requests.clear();
    },
    onEvent(event) {
      if (event.phase === 'request:start') {
        const method = (event.config.method ?? 'GET').toUpperCase();
        const span = options.tracer.startSpan(`HTTP ${method}`, {
          kind: SpanKind.CLIENT, attributes: { 'http.request.method': method },
        }, context.active());
        requests.set(event.requestId, { span, context: trace.setSpan(context.active(), span), attempts: new Map() });
        return;
      }
      const request = requests.get(event.requestId);
      if (!request) return;
      if (event.phase === 'attempt:start') {
        const attempt = event.attempt ?? 0;
        request.attempts.set(attempt, options.tracer.startSpan(`HTTP attempt ${attempt + 1}`, {
          attributes: { 'http.request.resend_count': attempt },
        }, request.context));
      } else if (event.phase === 'attempt:end') {
        const span = request.attempts.get(event.attempt ?? 0);
        if (span) finish(span, event.error, event.response?.status);
        request.attempts.delete(event.attempt ?? 0);
      } else if (event.phase === 'request:end') {
        if (event.bodyOutcome) request.span.setAttribute('axnexus.body.outcome', event.bodyOutcome);
        finish(request.span, event.error, event.response?.status);
        requests.delete(event.requestId);
      } else {
        request.span.addEvent(event.phase, {
          ...(event.duration === undefined ? {} : { 'axnexus.duration_ms': event.duration }),
          ...(event.attempt === undefined ? {} : { 'http.request.resend_count': event.attempt }),
          ...(event.bodyOutcome === undefined ? {} : { 'axnexus.body.outcome': event.bodyOutcome }),
        });
      }
    },
  };
}

export function createOpenTelemetryPlugin<TContext = unknown>(options: OpenTelemetryOptions): HttpPlugin<TContext> {
  return { create: () => scopedTelemetryPlugin<TContext>(options) };
}
