/** A valid selection-protocol failure or an invalid response from the server. */
export class SelectionError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'SelectionError';
    this.code = code;
    this.status = options.status;
  }
}
