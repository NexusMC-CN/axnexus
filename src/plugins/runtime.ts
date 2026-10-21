import type { HttpClient } from '../core/types.js';
import type { HttpPlugin, RequestEvent } from './types.js';

export function createPluginRuntime<TContext>(getClient: () => HttpClient<TContext>) {
  const entries = new Set<{ plugin: HttpPlugin<TContext>; cleanup?: () => void | Promise<void>; dispose: () => Promise<void> }>();
  let closed = false;
  return {
    active: () => entries.size > 0,
    emit(event: RequestEvent) {
      for (const entry of [...entries]) {
        try {
          const observed = entry.plugin.onEvent?.(event as RequestEvent<TContext>);
          if (observed) void Promise.resolve(observed).catch(() => undefined);
        } catch { /* observers do not change HTTP outcomes */ }
      }
    },
    use(plugin: HttpPlugin<TContext>): () => Promise<void> {
      if (closed) throw new Error('HTTP client is closed');
      plugin = plugin.create?.() ?? plugin;
      const cleanup = plugin.setup?.(getClient());
      let disposal: Promise<void> | undefined;
      const entry = { plugin, cleanup: cleanup || undefined, dispose: () => {
        if (disposal) return disposal;
        entries.delete(entry);
        disposal = Promise.resolve().then(() => entry.cleanup?.());
        return disposal;
      } };
      entries.add(entry);
      return entry.dispose;
    },
    async close() {
      closed = true;
      const results = await Promise.allSettled([...entries].reverse().map(entry => entry.dispose()));
      const errors = results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason);
      if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed');
    },
  };
}
