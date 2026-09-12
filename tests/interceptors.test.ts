import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyInterceptorChain,
  createInterceptorManager,
} from '../src/interceptors.ts';

test('runs request interceptors in registration order', async () => {
  const manager = createInterceptorManager<string>();
  manager.use((value) => `${value}a`);
  manager.use(async (value) => `${value}b`);

  const result = await applyInterceptorChain(manager, '', { reverse: false });

  assert.equal(result, 'ab');
});

test('runs response interceptors in reverse registration order', async () => {
  const manager = createInterceptorManager<string>();
  manager.use((value) => `${value}a`);
  manager.use((value) => `${value}b`);

  const result = await applyInterceptorChain(manager, '', { reverse: true });

  assert.equal(result, 'ba');
});

test('ejects one handler without changing another manager', async () => {
  const first = createInterceptorManager<number>();
  const second = createInterceptorManager<number>();
  const firstId = first.use((value) => value + 1);
  first.use((value) => value + 10);
  second.use((value) => value + 100);

  first.eject(firstId);

  assert.equal(await applyInterceptorChain(first, 0), 10);
  assert.equal(await applyInterceptorChain(second, 0), 100);
});
