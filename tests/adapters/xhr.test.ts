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
