/**
 * Object storage interface — the only place route/service code should touch the
 * AWS SDK. Backed by S3 (config/s3.js); Cloudinary stays an unwired config slot
 * (image/CDN-transform focused, not a fit for a generic tenant file service —
 * see AGENTS.md / SOURCE-MAPPING.md for the tradeoff).
 *
 * Functions are exported individually (not as one object method each other calls
 * internally) so tests can swap them out with node:test's built-in `mock.method`
 * without hitting real AWS credentials — see tests/files.integration.test.js.
 */
const { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3 = require('../config/s3');

const BUCKET = process.env.S3_BUCKET_NAME;

async function uploadObject(buffer, key, mimeType) {
  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mimeType,
  }));
  return { key };
}

async function getSignedDownloadUrl(key, expirySeconds = 300) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: expirySeconds });
}

async function deleteObject(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { uploadObject, getSignedDownloadUrl, deleteObject };
