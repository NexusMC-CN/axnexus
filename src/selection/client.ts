import { getClientLifecyclePolicy } from '../core/lifecycle/client-policy.js';
import { raceWithSignal, signalReason, TIMEOUT_REASON } from '../core/control.js';
import { scheduleTimer } from '../core/lifecycle/timers.js';
import { validateStandardSchema } from '../core/schema.js';
import { HttpError, isHttpError } from '../core/errors.js';
import type { HttpClient, HttpResponse, RequestConfig } from '../core/types.js';
import type { ExactSelection, SelectionArgs, SelectionFor, SelectionResource, SelectionResult } from './contract.js';
import { SelectionError } from './errors.js';
import { isRecord, SelectionFault, validateSelectedData, validateSelectionTree } from './validation.js';
import { combineSignals } from '../utils/signal.js';
import { AxiosHeaders } from '../headers/headers.js';

type ContextOf<Client> = Client extends HttpClient<infer Context, any> ? Context : unknown;

export type SelectionRequestConfig<Context = unknown> = Omit<RequestConfig<Context>,
  | 'url' | 'method' | 'body' | 'data' | 'params' | 'schema' | 'responseType'
  | 'transformRequest' | 'transformResponse' | 'stringifyJson'
  | 'retry' | 'retryUnsafeMethods' | 'retryOn' | 'retryDelay' | 'cache' | 'bypassCache'
  | 'validateStatus' | 'throwHttpErrors'
>;

export interface SelectionClientOptions { readonly endpoint: string; }

const localLimits = {
  maxDepth: 32,
  maxFields: 10_000,
  maxCost: Number.MAX_SAFE_INTEGER,
  maxArrayLength: 1,
};

function invalidResponse(cause?: unknown): SelectionError {
  return new SelectionError('INVALID_RESPONSE', 'Invalid selection response', { cause });
}

function validateEndpoint(endpoint: unknown): asserts endpoint is string {
  if (typeof endpoint !== 'string' || !endpoint.trim()) throw new TypeError('Selection endpoint must be a non-empty URL');
}

function responseData(payload: unknown): unknown {
  if (!isRecord(payload) || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'data')) {
    throw invalidResponse();
  }
  return payload.data;
}

function protocolError(payload: unknown, status: number, cause: unknown): SelectionError | undefined {
  if (!isRecord(payload) || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'error')) return undefined;
  const error = payload.error;
  if (!isRecord(error) || Object.keys(error).length !== 2 || !Object.hasOwn(error, 'code') || !Object.hasOwn(error, 'message')
    || typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(error.code)
    || typeof error.message !== 'string' || !error.message.trim()) return undefined;
  return new SelectionError(error.code, error.message, { status, cause });
}

/** Use a regular axnexus transport while keeping protocol decoding local. */
export function createSelectionClient<Client extends Pick<HttpClient<any, any>, 'requestResponse'>>(
  client: Client, options: SelectionClientOptions,
) {
  validateEndpoint(options?.endpoint);
  const select = async <R extends SelectionResource, const S extends SelectionFor<R['fields']>>(
      resource: R, input: { args: SelectionArgs<R>; select: S & ExactSelection<R['fields'], S> }, config: SelectionRequestConfig<ContextOf<Client>> = {},
    ): Promise<SelectionResult<R, S>> => {
      let selection;
      try { selection = validateSelectionTree(resource.fields, input.select, localLimits); }
      catch (error) {
        if (error instanceof SelectionFault) throw new SelectionError(error.code, error.message, { cause: error });
        throw error;
      }
      const defaults = getClientLifecyclePolicy(client);
      const timeout = config.totalTimeout ?? defaults?.totalTimeout ?? 0;
      const controller = timeout > 0 ? new AbortController() : undefined;
      const cancelTimer = controller ? scheduleTimer(() => controller.abort(TIMEOUT_REASON), timeout) : undefined;
      const combined = combineSignals([defaults?.signal, config.signal, controller?.signal]);
      const signal = combined.signal;
      try {
        if (signal?.aborted) throw signalReason(signal);
        let args;
        try { args = await raceWithSignal(validateStandardSchema(input.args, resource.args), signal); }
        catch (error) {
          if (signal?.aborted) throw error;
          throw new SelectionError('INVALID_ARGS', 'Invalid selection arguments', { cause: error });
        }
        const headers = new AxiosHeaders(config.headers);
        headers.set('Content-Type', 'application/json');
        const request: RequestConfig<ContextOf<Client>> = {
          ...config,
          signal,
          headers,
          url: options.endpoint,
          method: 'POST',
          data: { protocol: 'axnexus.selection', version: 1, resource: resource.resource, args, select: selection },
          schema: undefined,
          transformRequest: [],
          transformResponse: [],
          stringifyJson: JSON.stringify,
          retry: 0,
          retryUnsafeMethods: false,
          cache: false,
          responseType: 'json',
          validateStatus: (status) => status === 200,
          throwHttpErrors: true,
        };
        let response: HttpResponse<unknown>;
        try {
          response = await client.requestResponse(request);
        } catch (error) {
          if (isHttpError(error) && error.code === 'ERR_BAD_RESPONSE' && error.status !== undefined) {
            if (error.status >= 200 && error.status < 300) throw invalidResponse(error);
            const mapped = protocolError(error.response?.data, error.status, error);
            if (mapped) throw mapped;
          }
          throw error;
        }
        if (response.status !== 200) throw invalidResponse();
        try {
          const data = responseData(response.data);
          if (data === null) {
            if (!resource.nullable) throw invalidResponse();
            return null as SelectionResult<R, S>;
          }
          return await raceWithSignal(validateSelectedData(resource.fields, selection, data, signal), signal) as SelectionResult<R, S>;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof SelectionError) throw error;
          throw invalidResponse(error);
        }
      } catch (error) {
        if (controller?.signal.aborted) throw new HttpError('Selection call timed out', {
          code: 'ETIMEDOUT', isTimeout: true, retryable: false, cause: error,
        });
        if (signal?.aborted) throw new HttpError('Selection call canceled', {
          code: 'ERR_CANCELED', isAbort: true, retryable: false, cause: error,
        });
        throw error;
      } finally {
        cancelTimer?.();
        combined.cleanup();
      }
    };
  return { select };
}
