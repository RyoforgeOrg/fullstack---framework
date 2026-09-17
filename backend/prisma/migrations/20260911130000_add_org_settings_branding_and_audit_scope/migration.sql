-- AlterTable: Organization gains branding columns + an extensible settings blob.
ALTER TABLE "Organization" ADD COLUMN "logoUrl" TEXT;
ALTER TABLE "Organization" ADD COLUMN "primaryColor" TEXT;
ALTER TABLE "Organization" ADD COLUMN "settings" JSONB;

-- AlterTable: AuditLog gains an optional organization scope.
ALTER TABLE "AuditLog" ADD COLUMN "organizationId" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_idx" ON "AuditLog"("organizationId");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
