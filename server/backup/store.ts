import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

// Where snapshots go: S3 (production, MinIO in tests) or a folder (dev).
export interface ObjectStore {
  put(key: string, body: Buffer, sha256B64: string, mtimeMs?: number): Promise<void>;
  get(key: string): Promise<Buffer>;
  list(prefix: string): Promise<{ key: string; lastModified: number }[]>;
  delete(keys: string[]): Promise<void>;
  describe(): string;
}

export function s3Store(o: { bucket: string; region: string; endpoint: string | null }): ObjectStore {
  // Credentials from the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
  const s3 = new S3Client({ region: o.region, ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : {}) });
  return {
    async put(key, body, sha256B64) {
      await s3.send(new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: body, ContentType: 'application/gzip', ...(sha256B64 ? { ChecksumSHA256: sha256B64 } : {}) }));
    },
    async get(key) {
      const r = await s3.send(new GetObjectCommand({ Bucket: o.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    },
    async list(prefix) {
      const out: { key: string; lastModified: number }[] = [];
      let token: string | undefined;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: o.bucket, Prefix: prefix, ContinuationToken: token }));
        for (const c of r.Contents ?? []) if (c.Key) out.push({ key: c.Key, lastModified: c.LastModified?.getTime() ?? 0 });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await s3.send(new DeleteObjectsCommand({ Bucket: o.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
      }
    },
    describe: () => `s3://${o.bucket}`,
  };
}

export function fileStore(root: string): ObjectStore {
  const path = (key: string) => {
    const p = join(root, key);
    if (relative(root, p).startsWith('..')) throw new Error('key outside the store');
    return p;
  };
  const walk = (d: string): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return [];
    }
    return entries.flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));
  };
  return {
    async put(key, body, _sha, mtimeMs) {
      const p = path(key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
      if (mtimeMs !== undefined) utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    },
    async get(key) {
      return readFileSync(path(key));
    },
    async list(prefix) {
      return walk(root).map((f) => ({ key: relative(root, f).split(sep).join('/'), lastModified: statSync(f).mtimeMs })).filter((o) => o.key.startsWith(prefix));
    },
    async delete(keys) {
      for (const k of keys) rmSync(path(k), { force: true });
    },
    describe: () => `file://${root}`,
  };
}
