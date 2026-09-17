/**
 * File service — tenant-owned object storage metadata + lifecycle.
 *
 * Tenant boundary: every handler here runs behind middleware/tenantContext, so
 * req.organizationId / req.membership are already proven to belong to the
 * caller. All queries against the File table go through scopedWhere() — see
 * helpers/tenantScope.js — and use findFirst (never findUnique) so a fileId
 * belonging to another organization is simply not found, not leaked.
 *
 * storageKey is namespaced `orgs/<organizationId>/<fileId>/<sanitized-filename>`
 * as defense in depth on top of the DB-level organizationId filter — it is never
 * returned to the client (see publicFile).
 *
 * Permissions: upload/list/view follow the existing "any active member" (org:access)
 * philosophy from requireOrgRole.js's ORG_PERMISSIONS. Delete diverges from a flat
 * org:access check because destructive actions need a target-row guard the route
 * middleware can't express (mirrors OrganizationService.updateMember's pattern):
 * the uploader may delete their own file; owner/admin may delete anyone's.
 */
const crypto       = require('crypto');
const prisma        = require('../../../config/dbConnect');
const apiResponse    = require('../../../helpers/apiResponse');
const paginate       = require('../../../helpers/paginate');
const { auditLogger } = require('../../../helpers/auditLogger');
const { scopedWhere } = require('../../../helpers/tenantScope');
const fileStorage    = require('../../../helpers/fileStorage');

// No Organization.settings field exists in this worktree yet (see
// backend/prisma/schema.prisma's Organization model) — once org-admin work adds
// `settings.storageQuotaBytes`, read the quota from there and fall back to this.
// Env override exists so integration tests can exercise the quota-exceeded path
// without uploading hundreds of real fixtures.
const STORAGE_QUOTA_BYTES      = Number(process.env.FILES_STORAGE_QUOTA_BYTES) || 500 * 1024 * 1024; // 500 MB/org
const STORAGE_QUOTA_FILE_COUNT = Number(process.env.FILES_STORAGE_QUOTA_FILE_COUNT) || 1000;          // files/org
const DOWNLOAD_URL_TTL_SECONDS = 300;                // 5 minutes

const publicFile = (f) => ({
  id:               f.id,
  filename:         f.filename,
  mimeType:         f.mimeType,
  sizeBytes:        f.sizeBytes,
  status:           f.status,
  uploadedByUserId: f.uploadedByUserId,
  createdAt:        f.createdAt,
  deletedAt:        f.deletedAt,
});

function sanitizeFilename(name) {
  const cleaned = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-200);
  return cleaned || 'file';
}

// ── POST /orgs/:orgId/files — upload (any active member) ──────────────────────
async function uploadFile(req, res) {
  if (!req.file) {
    return apiResponse.send(res, 'VALIDATION_ERROR', { message: 'A file is required.' });
  }

  const usage = await prisma.file.aggregate({
    where:  scopedWhere(req, { status: 'active' }),
    _sum:   { sizeBytes: true },
    _count: { _all: true },
  });
  const usedBytes = usage._sum.sizeBytes || 0;
  const usedCount = usage._count._all || 0;

  if (usedCount >= STORAGE_QUOTA_FILE_COUNT) {
    return apiResponse.send(res, 'CONFLICT', {
      message: `Organization storage quota exceeded: file count limit (${STORAGE_QUOTA_FILE_COUNT}) reached.`,
    });
  }
  if (usedBytes + req.file.size > STORAGE_QUOTA_BYTES) {
    return apiResponse.send(res, 'CONFLICT', {
      message: `Organization storage quota exceeded: storage limit (${STORAGE_QUOTA_BYTES} bytes) reached.`,
    });
  }

  const fileId        = crypto.randomUUID();
  const sanitizedName  = sanitizeFilename(req.file.originalname);
  const storageKey     = `orgs/${req.organizationId}/${fileId}/${sanitizedName}`;

  await fileStorage.uploadObject(req.file.buffer, storageKey, req.file.mimetype);

  let created;
  try {
    created = await prisma.file.create({
      data: {
        id:               fileId,
        organizationId:   req.organizationId,
        uploadedByUserId: req.user.id,
        filename:         req.file.originalname,
        storageKey,
        mimeType:         req.file.mimetype,
        sizeBytes:        req.file.size,
        status:           'active',
      },
    });
  } catch (error) {
    // The DB row is the source of truth — an object with no row is orphaned, so
    // clean it up rather than leaving unaccounted storage behind.
    await fileStorage.deleteObject(storageKey).catch(() => {});
    throw error;
  }

  await auditLogger('FILE_UPLOADED', req.user, req);
  return apiResponse.send(res, 'CREATED', { file: publicFile(created) });
}

// ── GET /orgs/:orgId/files — paginated list ────────────────────────────────────
async function listFiles(req, res) {
  const { skip, take, meta } = paginate(req.query);
  const where = scopedWhere(req, { status: 'active' });

  const [rows, total] = await Promise.all([
    prisma.file.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
    prisma.file.count({ where }),
  ]);

  return apiResponse.send(res, 'SUCCESS', { files: rows.map(publicFile), pagination: meta(total) });
}

// ── GET /orgs/:orgId/files/:fileId — metadata only ─────────────────────────────
async function getFile(req, res) {
  const file = await prisma.file.findFirst({
    where: scopedWhere(req, { id: req.params.fileId, status: 'active' }),
  });
  if (!file) return apiResponse.send(res, 'NOT_FOUND', { message: 'File not found.' });
  return apiResponse.send(res, 'SUCCESS', { file: publicFile(file) });
}

// ── GET /orgs/:orgId/files/:fileId/download — short-lived signed URL ──────────
async function downloadFile(req, res) {
  const file = await prisma.file.findFirst({
    where: scopedWhere(req, { id: req.params.fileId, status: 'active' }),
  });
  if (!file) return apiResponse.send(res, 'NOT_FOUND', { message: 'File not found.' });

  const url = await fileStorage.getSignedDownloadUrl(file.storageKey, DOWNLOAD_URL_TTL_SECONDS);
  return apiResponse.send(res, 'SUCCESS', { url, expiresIn: DOWNLOAD_URL_TTL_SECONDS });
}

// ── DELETE /orgs/:orgId/files/:fileId — soft-delete + storage cleanup ─────────
// Soft-delete the DB row first (that's the record audit/billing reads), then
// delete the object synchronously — it's a single object, not a bulk job. A
// storage-delete failure is logged, not surfaced as a 500: the row is already
// correctly marked deleted, which is the state that matters to the rest of the
// app; the orphaned object is a cleanup detail, not a correctness one.
async function deleteFile(req, res) {
  const file = await prisma.file.findFirst({
    where: scopedWhere(req, { id: req.params.fileId, status: 'active' }),
  });
  if (!file) return apiResponse.send(res, 'NOT_FOUND', { message: 'File not found.' });

  const canDelete = ['owner', 'admin'].includes(req.membership.role) || file.uploadedByUserId === req.user.id;
  if (!canDelete) {
    return apiResponse.send(res, 'FORBIDDEN', {
      message: 'Only the uploader or an org owner/admin can delete this file.',
    });
  }

  await prisma.file.update({ where: { id: file.id }, data: { status: 'deleted', deletedAt: new Date() } });

  await fileStorage.deleteObject(file.storageKey).catch((err) => {
    console.error('[FileService.deleteFile] storage delete failed:', { fileId: file.id, error: err.message });
  });

  await auditLogger('FILE_DELETED', req.user, req);
  return apiResponse.send(res, 'SUCCESS', { message: 'File deleted.' });
}

module.exports = {
  uploadFile,
  listFiles,
  getFile,
  downloadFile,
  deleteFile,
  STORAGE_QUOTA_BYTES,
  STORAGE_QUOTA_FILE_COUNT,
};
