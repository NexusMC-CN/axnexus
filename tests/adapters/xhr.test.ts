import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createXhrAdapter } from '../../dist/index.js';

test('xhr adapter reports upload progress and resolves response', async () => {
  const events: number[] = [];
  class MockXHR {
    upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
    onreadystatechange: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    readyState = 0;
    status = 200;
    statusText = 'OK';
    responseText = '{"ok":true}';
    response = this.responseText;
    open() { this.readyState = 1; }
    setRequestHeader() {}
    getAllResponseHeaders() { return 'content-type: application/json\r\n'; }
    send() {
      this.upload.onprogress?.({ loaded: 2, total: 2, lengthComputable: true } as ProgressEvent);
      this.readyState = 4;
      this.onreadystatechange?.();
    }
    abort() { this.onabort?.(); }
  }
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = MockXHR as never;
  try {
    const response = await createXhrAdapter()({
      url: 'https://example.test', method: 'POST', headers: new Headers(), body: 'ok',
      onUploadProgress: (event) => events.push(event.loaded),
    } as never);
    assert.equal(response.status, 200);
    assert.deepEqual(events, [2]);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('xhr adapter maps binary response type and credentials', async () => {
  let instance: {
    responseType: string;
    withCredentials: boolean;
    onreadystatechange: (() => void) | null;
    readyState: number;
  } | undefined;
  class MockBinaryXHR {
    upload = {};
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onprogress: ((event: ProgressEvent) => void) | null = null;
    readyState = 0;
    status = 200;
    statusText = 'OK';
    responseType = '';
    withCredentials = false;
    response = new Uint8Array([1, 2]).buffer;
    constructor() { instance = this; }
    open() { this.readyState = 1; }
    setRequestHeader() {}
    getAllResponseHeaders() { return 'content-type: application/octet-stream\r\n'; }
    send() { this.readyState = 4; this.onreadystatechange?.(); }
    abort() { this.onabort?.(); }
  }
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = MockBinaryXHR as never;
  try {
    const response = await createXhrAdapter()({
      url: 'https://example.test', method: 'GET', headers: new Headers(),
      responseType: 'arrayBuffer', credentials: 'include',
    } as never);
    assert.equal(instance?.responseType, 'arraybuffer');
    assert.equal(instance?.withCredentials, true);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2]);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('xhr adapter treats status zero as a network error', async () => {
  class FailedXHR {
    upload = {};
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    readyState = 0;
    status = 0;
    statusText = '';
    responseType = '';
    response = '';
    open() { this.readyState = 1; }
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
    send() { this.readyState = 4; this.onreadystatechange?.(); }
    abort() { this.onabort?.(); }
  }
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FailedXHR as never;
  try {
    await assert.rejects(
      createXhrAdapter()({ url: 'https://example.test', method: 'GET', headers: new Headers() } as never),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'ERR_NETWORK',
    );
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('xhr adapter classifies a core timeout abort as ETIMEDOUT', async () => {
  class HangingXHR {
    upload = {};
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    readyState = 0;
    status = 200;
    statusText = 'OK';
    responseType = '';
    response = '';
    open() { this.readyState = 1; }
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
    send() {}
    abort() { this.onabort?.(); }
  }
  const original = globalThis.XMLHttpRequest;
  const controller = new AbortController();
  globalThis.XMLHttpRequest = HangingXHR as never;
  try {
    const pending = createXhrAdapter()({
      url: 'https://example.test', method: 'GET', headers: new Headers(), signal: controller.signal,
    } as never);
    controller.abort({ code: 'ETIMEDOUT', name: 'TimeoutError' });
    await assert.rejects(pending, (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'ETIMEDOUT');
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('xhr adapter keeps external cancellation as ERR_CANCELED', async () => {
  class HangingXHR {
    upload = {};
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    readyState = 0;
    status = 200;
    statusText = 'OK';
    responseType = '';
    response = '';
    open() { this.readyState = 1; }
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
    send() {}
    abort() { this.onabort?.(); }
  }
  const original = globalThis.XMLHttpRequest;
  const controller = new AbortController();
  globalThis.XMLHttpRequest = HangingXHR as never;
  try {
    const pending = createXhrAdapter()({
      url: 'https://example.test', method: 'GET', headers: new Headers(), signal: controller.signal,
    } as never);
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'ERR_CANCELED');
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test('xhr adapter rejects immediately when the signal is already aborted', async () => {
  let opened = false;
  class NeverXHR {
    upload = {};
    onreadystatechange: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    readyState = 0;
    status = 200;
    statusText = 'OK';
    responseType = '';
    response = '';
    open() { opened = true; this.readyState = 1; }
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
    send() {}
    abort() { this.onabort?.(); }
  }
  const original = globalThis.XMLHttpRequest;
  const controller = new AbortController();
  controller.abort();
  globalThis.XMLHttpRequest = NeverXHR as never;
  try {
    await assert.rejects(
      Promise.race([
        createXhrAdapter()({ url: 'https://example.test', method: 'GET', headers: new Headers(), signal: controller.signal } as never),
        new Promise((_, reject) => setTimeout(() => reject(new Error('request hung')), 100)),
      ]),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'ERR_CANCELED',
    );
    assert.equal(opened, false);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});
