import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const maxBytes = 50 * 1024 * 1024;

export function createArtifactStore({ bucket, region, endpoint }) {
  if (!bucket || !region) throw new Error("Object storage bucket and region are required");
  if (endpoint && new URL(endpoint).protocol !== "https:") throw new Error("The object store endpoint must use TLS");
  const client = new S3Client({ region, endpoint, forcePathStyle: Boolean(endpoint), maxAttempts: 2 });

  return {
    async put(workspaceId, projectId, body, mediaType) {
      if (!Buffer.isBuffer(body) || body.length > maxBytes) throw new Error("Report artifact exceeds the byte limit");
      const key = [workspaceId, projectId, randomUUID()].join("/");
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: mediaType,
      }), { abortSignal: AbortSignal.timeout(60000) });
      return key;
    },
    async read(key) {
      return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(60000),
      });
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal: AbortSignal.timeout(10000),
      });
    },
    close() { client.destroy(); },
  };
}
