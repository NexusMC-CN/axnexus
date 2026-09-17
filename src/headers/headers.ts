import { HttpError } from '../core/errors.js';
import type { HeaderDefaults } from './methods.js';

export type HeaderScalar = string | number | boolean;
export type HeaderValue = HeaderScalar | HeaderScalar[] | null | undefined;
export type RawHeaders = Record<string, HeaderValue>;
export type HeaderIterable = Iterable<readonly [string, HeaderValue]>;
export type HeaderMatcher = RegExp | ((value: string, name: string) => boolean);
export type HeaderRewrite = boolean | ((value: HeaderValue, name: string) => boolean);
export type HeaderParser = true | RegExp | ((value: string, name: string, headers: AxiosHeaders) => unknown);

export type HeaderInput = RawHeaders | HeaderDefaults | Headers | AxiosHeaders | HeadersInit | HeaderIterable | string;

const GROUPED_HEADER_NAMES = new Set(['common', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'connect', 'trace']);

// RFC 9110 field-name token: reject whitespace and separators before Headers sees it.
const INVALID_NAME = /[^!#$%&'*+.^_`|~0-9A-Za-z-]/;
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

function isHeaderIterable(value: unknown): value is HeaderIterable {
  return typeof value !== 'string'
    && Boolean(value)
    && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

function parseParameters(value: string, includeBareTokens = false): Record<string, string | undefined> {
  const result = Object.create(null) as Record<string, string | undefined>;
  let segment = '';
  let quoted = false;
  let escaped = false;
  const segments: string[] = [];
  for (const character of value) {
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quoted) {
      segment += character;
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (!quoted && (character === ';' || character === ',' || /\s/.test(character))) {
      segments.push(segment);
      segment = '';
    } else {
      segment += character;
    }
  }
  segments.push(segment);
  for (const item of segments) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    const rawName = (separator < 0 ? trimmed : trimmed.slice(0, separator)).trim().toLowerCase();
    if (!rawName || rawName === '__proto__' || rawName === 'constructor' || rawName === 'prototype') continue;
    if (separator < 0) {
      if (includeBareTokens) result[rawName] = undefined;
      continue;
    }
    let rawValue = trimmed.slice(separator + 1).trim();
    if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
      rawValue = rawValue.slice(1, -1).replace(/\\([\\"])/g, '$1');
    }
    result[rawName] = rawValue;
  }
  return result;
}

function matches(matcher: HeaderMatcher | undefined, value: string, name: string): boolean {
  if (!matcher) return true;
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    const valueMatch = matcher.test(value);
    matcher.lastIndex = 0;
    const nameMatch = matcher.test(name);
    matcher.lastIndex = 0;
    return valueMatch || nameMatch;
  }
  return matcher(value, name);
}

function matchesName(matcher: HeaderMatcher | undefined, name: string): boolean {
  if (!matcher) return true;
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    const matched = matcher.test(name);
    matcher.lastIndex = 0;
    return matched;
  }
  // `clear` matchers are defined in terms of header names, not values.
  return matcher('', name);
}

export class AxiosHeaders implements Iterable<[string, HeaderValue]> {
  private readonly values = new Map<string, { name: string; value: HeaderValue }>();
  /**
   * Names explicitly deleted through `delete()`/`clear()` or the `false`
   * opt-out. A plain `Map.delete` is indistinguishable from "never set", which
   * lets a later merge restore a default the caller removed.
   */
  private readonly removed = new Set<string>();

  static from<T extends HeaderInput | null | undefined>(headers?: T): T extends AxiosHeaders ? T : AxiosHeaders {
    if (headers instanceof AxiosHeaders) return headers as T extends AxiosHeaders ? T : AxiosHeaders;
    return new AxiosHeaders(headers ?? undefined) as T extends AxiosHeaders ? T : AxiosHeaders;
  }

  static concat(...targets: Array<HeaderInput | null | undefined>): AxiosHeaders {
    const result = new AxiosHeaders();
    for (const target of targets) {
      if (target !== undefined && target !== null) result.set(target);
    }
    return result;
  }

  static parseParameters(value: string): Record<string, string | undefined> {
    return parseParameters(value);
  }

  constructor(headers?: HeaderInput | null) {
    if (!headers) return;
    if (headers instanceof AxiosHeaders) {
      // Preserve list-valued fields and the `false` opt-out sentinel; tracking
      // removals separately keeps `deleted` distinguishable from `never set`.
      for (const [name, value] of headers) this.append(name, value);
      for (const name of headers.removedNames()) {
        if (!this.values.has(normalizeName(name))) this.removed.add(normalizeName(name));
      }
      return;
    }
    if (typeof headers === 'string') {
      for (const line of headers.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator > 0) this.set(line.slice(0, separator), line.slice(separator + 1).trim());
      }
      return;
    }
    if (isHeaderIterable(headers)) {
      for (const pair of headers) {
        if (!pair || pair.length < 2) continue;
        this.append(String(pair[0]), pair[1]);
      }
    } else {
      for (const [name, value] of Object.entries(headers)) {
        if (GROUPED_HEADER_NAMES.has(name.toLowerCase()) && value && typeof value === 'object' && !Array.isArray(value)) {
          for (const [nestedName, nestedValue] of Object.entries(value)) this.set(nestedName, nestedValue as HeaderValue);
        } else {
          this.set(name, value as HeaderValue);
        }
      }
    }
  }

  set(name: string, value: HeaderValue, rewrite?: HeaderRewrite): this;
  set(headers: HeaderInput, rewrite?: HeaderRewrite): this;
  set(nameOrHeaders: HeaderInput, valueOrRewrite?: HeaderValue | HeaderRewrite, rewrite?: HeaderRewrite): this {
    // A raw header block is recognized whether or not a rewrite argument is
    // present. `set('X-Trace: next', true)` previously treated the whole string
    // as a header name and threw ERR_INVALID_HEADER; the same happened for a
    // rewrite function, because the guard treated any function second argument
    // as a value. `HeaderValue` cannot be a function, so a function argument is
    // always the rewrite policy.
    if (typeof nameOrHeaders === 'string' && nameOrHeaders.includes(':')) {
      // A boolean second argument is always the rewrite policy, never a value:
      // `HeaderValue` has no boolean form. Treating `false` as "no rewrite
      // argument" made `set('X-A: 1', false)` silently apply the block, so a
      // caller asking not to rewrite was obeyed then ignored.
      const effectiveRewrite = typeof valueOrRewrite === 'function' || typeof valueOrRewrite === 'boolean'
        ? (valueOrRewrite as HeaderRewrite)
        : rewrite ?? (valueOrRewrite as HeaderRewrite | undefined);
      // `set('X-A: 1', false)` asks for the block not to be applied at all.
      // The per-name path below only skips a rewrite when a value already
      // exists, which would still insert the header on a fresh instance.
      if (effectiveRewrite === false) return this;
      for (const line of nameOrHeaders.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator > 0) this.set(line.slice(0, separator), line.slice(separator + 1).trim(), effectiveRewrite);
      }
      return this;
    }
    if (typeof nameOrHeaders !== 'string') {
      const target = new AxiosHeaders(nameOrHeaders);
      for (const [name, value] of target) this.set(name, value, valueOrRewrite as HeaderRewrite);
      // Propagate explicit removals so a merge from a source that recorded a
      // deletion cannot let an earlier default survive.
      for (const name of target.removedNames()) {
        if (!this.values.has(name)) this.delete(name);
      }
      return this;
    }
    const name = normalizeName(nameOrHeaders);
    const value = normalizeValue(valueOrRewrite as HeaderValue, name);
    const existing = this.values.get(name);
    const shouldRewrite = typeof rewrite === 'function'
      ? rewrite(existing?.value, name)
      : rewrite === undefined
        ? existing?.value !== false
        : rewrite;
    if (existing && !shouldRewrite) return this;
    if (value === undefined || value === null) {
      this.values.delete(name);
      this.removed.add(name);
      return this;
    }
    if (value === false) {
      // `false` is the explicit opt-out sentinel: remember it so a later merge
      // cannot silently restore the default value.
      this.removed.add(name);
    } else {
      this.removed.delete(name);
    }
    this.values.set(name, { name: existing?.name ?? name, value });
    return this;
  }

  /**
   * Append a value to an existing header, mirroring `Headers.append`. Used for
   * list-valued fields such as `Set-Cookie`, where `set` would overwrite the
   * previous occurrence.
   */
  append(name: string, value: HeaderValue): this {
    if (value === undefined || value === null) return this;
    const key = normalizeName(name);
    // A `false` sentinel is an explicit opt-out, not a value to concatenate.
    if (value === false) return this.set(name, false);
    const normalized = normalizeValue(value, key);
    const existing = this.values.get(key);
    if (existing && existing.value !== false) {
      const combined = (Array.isArray(existing.value) ? existing.value : [existing.value])
        .concat(Array.isArray(normalized) ? normalized : [normalized as HeaderScalar]) as HeaderScalar[];
      this.values.set(key, { name: existing.name, value: combined });
      this.removed.delete(key);
      return this;
    }
    return this.set(name, value);
  }

  /** Header names explicitly removed on this instance. */
  removedNames(): string[] {
    return [...this.removed];
  }

  /** True when this instance recorded an explicit removal for `name`. */
  wasRemoved(name: string): boolean {
    return this.removed.has(normalizeName(name));
  }

  get(name: string): string | undefined;
  get(name: string, parser: true): Record<string, string | undefined> | undefined;
  get(name: string, parser: RegExp): RegExpExecArray | null | undefined;
  get<T>(name: string, parser: (value: string, name: string, headers: AxiosHeaders) => T): T | undefined;
  get(name: string, parser?: HeaderParser): unknown {
    const entry = this.values.get(normalizeName(name));
    if (!entry) return undefined;
    if (entry.value === false) return undefined;
    const value = Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value);
    if (!parser) return value;
    if (parser === true) return parseParameters(value, true);
    if (parser instanceof RegExp) {
      parser.lastIndex = 0;
      const result = parser.exec(value);
      parser.lastIndex = 0;
      return result;
    }
    return parser(value, entry.name, this);
  }

  has(name: string, matcher?: HeaderMatcher): boolean {
    const entry = this.values.get(normalizeName(name));
    if (!entry) return false;
    return matches(matcher, Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value), entry.name);
  }

  /** Returns true when a header was explicitly set to Axios' `false` opt-out. */
  isDisabled(name: string): boolean {
    return this.values.get(normalizeName(name))?.value === false;
  }

  delete(name: string | string[], matcher?: HeaderMatcher): boolean {
    const names = Array.isArray(name) ? name : [name];
    let deleted = false;
    for (const item of names) {
      const key = normalizeName(item);
      const entry = this.values.get(key);
      if (entry && matches(matcher, Array.isArray(entry.value) ? entry.value.join(', ') : String(entry.value), entry.name)) {
        deleted = this.values.delete(key) || deleted;
        this.removed.add(key);
      } else if (!entry && !matcher) {
        // Record the intent even when nothing was present yet, so merging a
        // default afterwards does not resurrect the header.
        this.removed.add(key);
        deleted = true;
      }
    }
    return deleted;
  }

  clear(matcher?: HeaderMatcher): boolean {
    let changed = false;
    for (const [key, entry] of this.values) {
      if (matchesName(matcher, entry.name)) {
        this.values.delete(key);
        this.removed.add(key);
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

  concat(...targets: Array<HeaderInput | null | undefined>): AxiosHeaders {
    const result = new AxiosHeaders(this);
    for (const target of targets) if (target !== undefined && target !== null) result.set(new AxiosHeaders(target));
    return result;
  }

  toHeaders(): Headers {
    return new Headers(this.toJSON(true) as HeadersInit);
  }

  forEach(callback: (value: string, name: string, headers: this) => void, thisArg?: unknown): void {
    for (const [name, value] of this) {
      if (value === false || value === null || value === undefined) continue;
      const normalized = Array.isArray(value) ? value.join(', ') : String(value);
      callback.call(thisArg, normalized, name, this);
    }
  }
  toJSON(asStrings = false): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const entry of this.values.values()) {
      if (entry.value === undefined || entry.value === null || entry.value === false) continue;
      const value = entry.value;
      const isArray = Array.isArray(value);
      const normalized = isArray
        ? (value as HeaderScalar[]).map((item) => String(item))
        : String(value);
      result[entry.name] = asStrings && isArray ? (normalized as string[]).join(', ') : normalized;
    }
    return result;
  }

  toString(): string {
    return Object.entries(this.toJSON(true)).map(([name, value]) => `${name}: ${value}`).join('\n');
  }

  setAccept(value: HeaderValue, rewrite?: HeaderRewrite): this { return this.set('Accept', value, rewrite); }
  getAccept(): string | undefined { return this.get('Accept'); }
  hasAccept(): boolean { return this.has('Accept'); }
  setContentType(value: HeaderValue, rewrite?: HeaderRewrite): this { return this.set('Content-Type', value, rewrite); }
  getContentType(): string | undefined { return this.get('Content-Type'); }
  hasContentType(): boolean { return this.has('Content-Type'); }
  setAuthorization(value: HeaderValue, rewrite?: HeaderRewrite): this { return this.set('Authorization', value, rewrite); }
  getAuthorization(): string | undefined { return this.get('Authorization'); }
  hasAuthorization(): boolean { return this.has('Authorization'); }
  setUserAgent(value: HeaderValue, rewrite?: HeaderRewrite): this { return this.set('User-Agent', value, rewrite); }
  getUserAgent(): string | undefined { return this.get('User-Agent'); }
  hasUserAgent(): boolean { return this.has('User-Agent'); }
  setContentLength(value: HeaderValue, rewrite?: HeaderRewrite): this { return this.set('Content-Length', value, rewrite); }
  getContentLength(): string | undefined { return this.get('Content-Length'); }
  hasContentLength(): boolean { return this.has('Content-Length'); }
  setContentEncoding(value: HeaderValue, rewrite?: HeaderRewrite): this { return this.set('Content-Encoding', value, rewrite); }
  getContentEncoding(): string | undefined { return this.get('Content-Encoding'); }
  hasContentEncoding(): boolean { return this.has('Content-Encoding'); }

  *[Symbol.iterator](): IterableIterator<[string, HeaderValue]> {
    for (const entry of this.values.values()) yield [entry.name, entry.value];
  }
}
