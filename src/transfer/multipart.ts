export function createFormData(fields: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (typeof Blob !== 'undefined' && value instanceof Blob) form.append(name, value);
    else if (value instanceof ArrayBuffer) form.append(name, new Blob([value]));
    else form.append(name, String(value));
  }
  return form;
}
