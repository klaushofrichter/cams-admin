import { execFileSync, spawnSync } from 'child_process';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';

// A local S3 (SeaweedFS in Docker, the image restore-test.sh pins) with one
// identity, so wrong credentials are refused. Never the real bucket.
export const SEAWEED_IMAGE = 'chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d';
export const S3_KEY = 'testkey';
export const S3_SECRET = 'testsecret';

export const hasDocker = (): boolean => spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

export async function localS3(bucket: string) {
  const cfg = JSON.stringify({ identities: [{ name: 'test', credentials: [{ accessKey: S3_KEY, secretKey: S3_SECRET }], actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'] }] });
  const id = execFileSync('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::8333', '--entrypoint', 'sh', SEAWEED_IMAGE, '-c', `echo '${cfg}' > /tmp/s3.json && exec weed server -s3 -s3.config=/tmp/s3.json -dir=/data`], { encoding: 'utf8' }).trim();
  const port = Number(execFileSync('docker', ['port', id, '8333'], { encoding: 'utf8' }).split('\n')[0].split(':').pop());
  const endpoint = `http://127.0.0.1:${port}`;
  const client = (key = S3_KEY, ep = endpoint) => new S3Client({ region: 'us-east-1', endpoint: ep, forcePathStyle: true, credentials: { accessKeyId: key, secretAccessKey: S3_SECRET } });
  const s3 = client();
  const t0 = Date.now();
  for (;;) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      break;
    } catch (e) {
      if (Date.now() - t0 > 60_000) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { id, port, endpoint, s3, client, stop: () => spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' }) };
}
