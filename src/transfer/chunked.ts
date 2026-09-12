export interface ChunkUploadPart {
  index: number;
  start: number;
  end: number;
  body: Uint8Array;
  total: number;
  signal?: AbortSignal;
}

export interface ChunkUploadOptions<T> {
  chunkSize: number;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  upload: (part: ChunkUploadPart) => Promise<T>;
}

export async function uploadChunks<T>(source: Uint8Array, options: ChunkUploadOptions<T>): Promise<T[]> {
  const chunkSize = Math.max(1, Math.floor(options.chunkSize));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const total = source.byteLength;
  const count = Math.ceil(total / chunkSize);
  const results = new Array<T>(count);
  let next = 0;
  let loaded = 0;
  const worker = async () => {
    while (true) {
      if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      const index = next++;
      if (index >= count) return;
      const start = index * chunkSize;
      const end = Math.min(total, start + chunkSize);
      const body = source.slice(start, end);
      results[index] = await options.upload({ index, start, end, body, total, signal: options.signal });
      loaded += body.byteLength;
      options.onProgress?.(loaded, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, count)) }, () => worker()));
  return results;
}
