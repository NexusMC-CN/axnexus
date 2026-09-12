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
