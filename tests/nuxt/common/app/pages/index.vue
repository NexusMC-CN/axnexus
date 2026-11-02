<script setup lang="ts">
import { createFetchAdapter, createHttpClient } from '@nexusmc-cn/axnexus';
import { createSelectionClient, defineSelectionResource, leaf } from '@nexusmc-cn/axnexus/selection';

const schema = { '~standard': { validate(value: unknown) {
  return typeof value === 'string' ? { value } : { issues: [{ message: 'string required' }] };
} } };
const args = { '~standard': { validate(value: unknown) {
  return value !== null && typeof value === 'object' ? { value: {} } : { issues: [{ message: 'object required' }] };
} } };
const contract = defineSelectionResource({
  resource: 'session.current.v1', args, fields: { actor: leaf(schema) },
});

const { data, error } = await useAsyncData('current-session', async () => {
  const event = useRequestEvent();
  const cookie = useRequestHeaders(['cookie']).cookie;
  const requestFetch: typeof fetch = event?.fetch
    ? (input, init) => event.fetch(input as string, {
      ...init,
      headers: Object.fromEntries(new Headers(init?.headers)),
    })
    : globalThis.fetch;
  const http = createHttpClient({
    adapter: createFetchAdapter(requestFetch),
    headers: cookie ? { cookie } : undefined,
  });
  try {
    const selection = createSelectionClient(http, { endpoint: '/api/__axnexus/select' });
    return await selection.select(contract, { args: {}, select: { actor: true } });
  } finally {
    await http.close();
  }
});
if (error.value) throw error.value;
</script>

<template>
  <main id="actor">{{ data?.actor }}</main>
</template>
