import type { BlobStore } from "./index.ts";

/**
 * Minimal structural view of an R2 bucket. The real `env.BLOBS` binding
 * satisfies this shape; defining it here keeps shared packages free of
 * Cloudflare type dependencies.
 */
export interface R2BucketLike {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(key: string): Promise<unknown>;
}

/** Content-addressed blob store backed by R2. */
export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(hash, bytes);
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(hash);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async has(hash: string): Promise<boolean> {
    const obj = await this.bucket.head(hash);
    return obj !== null;
  }
}
