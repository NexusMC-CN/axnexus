import { HttpError } from '../core/errors.js';

export type HeaderValue = string | string[] | null | false | undefined;
export type RawHeaders = Record<string, HeaderValue>;
export type HeaderMatcher = RegExp | ((value: string, name: string) => boolean);
export type HeaderRewrite = boolean | ((value: HeaderValue, name: string) => boolean);

const INVALID_NAME = /[\r\n\0]/;
const INVALID_VALUE = /[\r\n\0]/;

function normalizeName(name: string): string {
  const value = String(name).trim();
  if (!value || INVALID_NAME.test(value)) {
    throw new HttpError('Invalid header name', { code: 'ERR_INVALID_HEADER' });
  }
  return value.toLowerCase();
}

function normalizeValue(value: HeaderValue, name: string): HeaderValue {
  if (value === undefined || value === null || value === false) return value;
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map((item) => String(item));
  if (normalized.some((item) => INVALID_VALUE.test(item))) {
    throw new HttpError(`Invalid value for header ${name}`, { code: 'ERR_INVALID_HEADER' });
  }
  return Array.isArray(value) ? normalized : normalized[0];
}

function matches(matcher: HeaderMatcher | undefined, value: string, name: string): boolean {
  if (!matcher) return true;
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    const valueMatch = matcher.test(value);
    matcher.lastIndex = 0;
    return valueMatch || matcher.test(name);
  }
  return matcher(value, name);
}

export class AxiosHeaders implements Iterable<[string, HeaderValue]> {
  private readonly values = new Map<string, { name: string; value: HeaderValue }>();

  constructor(headers?: RawHeaders | Headers | AxiosHeaders | HeadersInit | string) {
    if (!headers) return;
    if (headers instanceof AxiosHeaders) {
      for (const [name, value] of headers) this.set(name, value);
      return;
    }
    if (typeof headers === 'string') {
      for (const line of headers.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator > 0) this.set(line.slice(0, separator), line.slice(separator + 1).trim());
      }
      return;
    }
    if (headers instanceof Headers || Array.isArray(headers)) {
      new Headers(headers).forEach((value, name) => this.set(name, value));
    } else {
      for (const [name, value] of Object.entries(headers)) this.set(name, value);
    }
  }

  set(name: string, value: HeaderValue, rewrite?: HeaderRewrite): this;
  set(headers: RawHeaders | Headers | AxiosHeaders | HeadersInit, rewrite?: HeaderRewrite): this;
  set(nameOrHeaders: string | RawHeaders | Headers | AxiosHeaders | HeadersInit, valueOrRewrite?: HeaderValue | HeaderRewrite, rewrite: HeaderRewrite = true): this {
    if (typeof nameOrHeaders !== 'string') {
      const target = new AxiosHeaders(nameOrHeaders);
      for (const [name, value] of target) this.set(name, value, valueOrRewrite as HeaderRewrite ?? true);
      return this;
    }
    const name = normalizeName(nameOrHeaders);
    const value = normalizeValue(valueOrRewrite as HeaderValue, name);
    const existing = this.values.get(name);
    const shouldRewrite = typeof rewrite === 'function' ? rewrite(existing?.value, name) : rewrite;
    if (existing && !shouldRewrite) return this;
    if (value === undefined || value === null || value === false) {
      this.values.delete(name);
      return this;
    }
    this.values.set(name, { name: existing?.name ?? name, value });
    return this;
  }

  get(name: string, parser?: RegExp | ((value: string) => unknown)): unknown {
    const entry = this.values.get(normalizeName(name));
    if (!entry) return undefined;
    const value = Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value);
    if (!parser) return value;
    if (parser instanceof RegExp) return parser.exec(value);
    return parser(value);
  }

  has(name: string, matcher?: HeaderMatcher): boolean {
    const entry = this.values.get(normalizeName(name));
    if (!entry) return false;
    return matches(matcher, Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value), entry.name);
  }

  delete(name: string | string[], matcher?: HeaderMatcher): boolean {
    const names = Array.isArray(name) ? name : [name];
    let deleted = false;
    for (const item of names) {
      const key = normalizeName(item);
      const entry = this.values.get(key);
      if (entry && matches(matcher, Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value), entry.name)) {
        deleted = this.values.delete(key) || deleted;
      }
    }
    return deleted;
  }

  clear(matcher?: HeaderMatcher): boolean {
    let changed = false;
    for (const [key, entry] of this.values) {
      if (matches(matcher, Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value), entry.name)) {
        this.values.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  normalize(format = false): this {
    for (const entry of this.values.values()) {
      entry.name = format ? entry.name.toLowerCase().replace(/(^|-)([a-z])/g, (_, prefix, letter) => `${prefix}${letter.toUpperCase()}`) : entry.name.toLowerCase();
    }
    return this;
  }

  concat(...targets: Array<RawHeaders | Headers | AxiosHeaders>): AxiosHeaders {
    const result = new AxiosHeaders(this);
    for (const target of targets) result.set(new AxiosHeaders(target));
    return result;
  }

  toJSON(asStrings = false): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const entry of this.values.values()) {
      if (entry.value === undefined || entry.value === null || entry.value === false) continue;
      result[entry.name] = asStrings && Array.isArray(entry.value) ? entry.value.join(', ') : entry.value;
    }
    return result;
  }

  toString(): string {
    return Object.entries(this.toJSON(true)).map(([name, value]) => `${name}: ${value}`).join('\n');
  }

  *[Symbol.iterator](): IterableIterator<[string, HeaderValue]> {
    for (const entry of this.values.values()) yield [entry.name, entry.value];
  }
}

const shortcuts = {
  Accept: 'Accept',
  ContentType: 'Content-Type',
  Authorization: 'Authorization',
  UserAgent: 'User-Agent',
} as const;

for (const [method, header] of Object.entries(shortcuts)) {
  const suffix = method;
  (AxiosHeaders.prototype as unknown as Record<string, unknown>)[`set${suffix}`] = function (this: AxiosHeaders, value: HeaderValue, rewrite?: HeaderRewrite) {
    return this.set(header, value, rewrite);
  };
  (AxiosHeaders.prototype as unknown as Record<string, unknown>)[`get${suffix}`] = function (this: AxiosHeaders) {
    return this.get(header);
  };
  (AxiosHeaders.prototype as unknown as Record<string, unknown>)[`has${suffix}`] = function (this: AxiosHeaders) {
    return this.has(header);
  };
}
