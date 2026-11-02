import { raceWithSignal } from '../../core/control.js';
import { SelectionFault } from '../validation.js';

export interface SelectionPageRequest {
  readonly first: number;
  readonly after?: string | null;
}

export interface SelectionPage<Row> {
  readonly items: readonly Row[];
  readonly pageInfo: { readonly endCursor: string | null; readonly hasNextPage: boolean };
}

export interface SelectionPageOptions<Row, Cursor> {
  readonly maxPageSize: number;
  /** Decode a service-owned opaque cursor before passing it to the data source. */
  readonly decodeCursor: (cursor: string) => Cursor | Promise<Cursor>;
  readonly encodeCursor: (row: Row) => string | Promise<string>;
  /** Fetch at most limit rows in stable cursor order; limit includes one lookahead row. */
  readonly load: (input: { after: Cursor | null; limit: number; signal?: AbortSignal }) => readonly Row[] | Promise<readonly Row[]>;
  readonly signal?: AbortSignal;
}

/** Forward-only page: bound the fetch, use one lookahead row, and never expose a total count. */
export async function paginateSelection<Row, Cursor>(
  request: SelectionPageRequest, options: SelectionPageOptions<Row, Cursor>,
): Promise<SelectionPage<Row>> {
  if (!Number.isSafeInteger(options.maxPageSize) || options.maxPageSize < 1 || options.maxPageSize >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('maxPageSize must be a positive safe integer below MAX_SAFE_INTEGER');
  }
  if (!Number.isSafeInteger(request.first) || request.first < 1 || request.first > options.maxPageSize) {
    throw new SelectionFault(422, 'INVALID_PAGE', 'Page size must be within the configured limit');
  }
  const after = request.after ?? null;
  if (after !== null && (typeof after !== 'string' || after.length < 1 || after.length > 2048)) {
    throw new SelectionFault(422, 'INVALID_CURSOR', 'Invalid page cursor');
  }
  let decoded: Cursor | null = null;
  if (after !== null) {
    try { decoded = await raceWithSignal(options.decodeCursor(after), options.signal); }
    catch (error) {
      if (options.signal?.aborted) throw error;
      throw new SelectionFault(422, 'INVALID_CURSOR', 'Invalid page cursor');
    }
    if (decoded === null || decoded === undefined) throw new SelectionFault(422, 'INVALID_CURSOR', 'Invalid page cursor');
  }
  const limit = request.first + 1;
  const rows = await raceWithSignal(options.load({ after: decoded, limit, signal: options.signal }), options.signal);
  if (!Array.isArray(rows) || rows.length > limit) throw new TypeError('Invalid page source result');
  const items = rows.slice(0, request.first);
  let endCursor: string | null = null;
  if (items.length) {
    endCursor = await raceWithSignal(options.encodeCursor(items[items.length - 1]!), options.signal);
    if (typeof endCursor !== 'string' || !endCursor.length || endCursor.length > 2048) {
      throw new TypeError('Invalid encoded page cursor');
    }
  }
  return { items, pageInfo: { endCursor, hasNextPage: rows.length > request.first } };
}
