/**
 * File routes. Mounted at /api/v1/orgs/:orgId/files behind verifyToken
 * (routes/index.js). `mergeParams: true` so this sub-router sees :orgId from
 * its mount path for tenantContext.
 *
 * POST   /                upload                (any active member)
 * GET    /                list (paginated)       (any active member)
 * GET    /:fileId          metadata only          (any active member)
 * GET    /:fileId/download short-lived signed URL (any active member)
 * DELETE /:fileId          soft-delete + cleanup  (uploader, or owner/admin — see FileService.deleteFile)
 *
 * Every route runs tenantContext first (403, never 404, for a non-member —
 * same anti-enumeration stance as the rest of the tenant boundary), then
 * requireOrgRole. There is no dedicated 'files:*' entry in requireOrgRole's
 * ORG_PERMISSIONS matrix — these all use the existing 'org:access' tier (any
 * active member, including viewer) to stay consistent with the "any active
 * member" read/write-light philosophy the organizations module already uses
 * for reads. Upload is treated the same as a write-light action, matching that
 * philosophy rather than introducing a new tier.
 */
const express        = require('express');
const router         = express.Router({ mergeParams: true });
const tenantContext  = require('../../../middleware/tenantContext');
const { requireOrgRole, ORG_PERMISSIONS } = require('../../../middleware/requireOrgRole');
const { validatedUpload } = require('../../../middleware/upload');
const {
  uploadFile,
  listFiles,
  getFile,
  downloadFile,
  deleteFile,
} = require('../services/FileService');

// Signature-checkers in middleware/upload.js cover all of these (SNIFFERS map):
// images, PDF, common office docs (legacy OLE + modern OOXML), CSV. Video types
// are also sniffable there but out of scope for a general-purpose file service.
const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
];

const MEMBER = requireOrgRole(...ORG_PERMISSIONS['org:access']);

router.post('/',
  tenantContext, MEMBER,
  validatedUpload.single('file', ALLOWED_TYPES),
  uploadFile);

router.get('/',              tenantContext, MEMBER, listFiles);
router.get('/:fileId',       tenantContext, MEMBER, getFile);
router.get('/:fileId/download', tenantContext, MEMBER, downloadFile);
router.delete('/:fileId',    tenantContext, MEMBER, deleteFile);

module.exports = router;
