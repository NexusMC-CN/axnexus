export function createHttpClient() {
  return {};
}

export type * from './types.js';
export { HttpError, isHttpError } from './errors.js';
export {
  InterceptorManager,
  applyInterceptorChain,
  createInterceptorManager,
} from './interceptors.js';
