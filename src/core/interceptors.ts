import type { InterceptorFulfilled, InterceptorRejected } from './types.js';

interface Handler<T> {
  fulfilled?: InterceptorFulfilled<T>;
  rejected?: InterceptorRejected<T>;
}

export class InterceptorManager<T> {
  private readonly handlers: Array<Handler<T> | null> = [];

  use(fulfilled?: InterceptorFulfilled<T>, rejected?: InterceptorRejected<T>): number {
    this.handlers.push({ fulfilled, rejected });
    return this.handlers.length - 1;
  }

  eject(id: number): void {
    if (id >= 0 && id < this.handlers.length) this.handlers[id] = null;
  }

  getHandlers(reverse = false): Handler<T>[] {
    const active = this.handlers.filter((handler): handler is Handler<T> => handler !== null);
    return reverse ? active.reverse() : active;
  }
}

export function createInterceptorManager<T>(): InterceptorManager<T> {
  return new InterceptorManager<T>();
}

export async function applyInterceptorChain<T>(
  manager: InterceptorManager<T>,
  value: T,
  options: { reverse?: boolean } = {},
): Promise<T> {
  let chain: Promise<T> = Promise.resolve(value) as Promise<T>;
  for (const handler of manager.getHandlers(options.reverse)) {
    chain = chain.then(handler.fulfilled, handler.rejected);
  }
  return chain;
}
