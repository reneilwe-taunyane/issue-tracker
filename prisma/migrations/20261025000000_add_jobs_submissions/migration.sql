-- CreateEnum
CREATE TYPE "JobSubmissionStatus" AS ENUM ('pending', 'accepted', 'rejected');

-- AlterEnum
ALTER TYPE "PointRole" ADD VALUE 'submission';

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "submissionSchema" JSONB,
    "dedupeKey" TEXT NOT NULL,
    "maxSubmissions" INTEGER NOT NULL,
    "pointsPerAccepted" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobSubmission" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "beneficiaryUserId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "JobSubmissionStatus" NOT NULL DEFAULT 'pending',
    "reviewsNeeded" INTEGER NOT NULL DEFAULT 2,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobReview" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "beneficiaryUserId" TEXT NOT NULL,
    "verdict" "ValidationVerdict" NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobReviewOffer" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "beneficiaryUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offered',
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobReviewOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_tenantId_createdAt_idx" ON "Job"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_projectId_idx" ON "Job"("projectId");

-- CreateIndex
CREATE INDEX "JobSubmission_jobId_status_idx" ON "JobSubmission"("jobId", "status");

-- CreateIndex
CREATE INDEX "JobSubmission_agentId_idx" ON "JobSubmission"("agentId");

-- CreateIndex
CREATE INDEX "JobSubmission_status_idx" ON "JobSubmission"("status");

-- CreateIndex
CREATE UNIQUE INDEX "JobSubmission_jobId_dedupeKey_key" ON "JobSubmission"("jobId", "dedupeKey");

-- CreateIndex
CREATE INDEX "JobReview_agentId_idx" ON "JobReview"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "JobReview_submissionId_agentId_key" ON "JobReview"("submissionId", "agentId");

-- CreateIndex
CREATE INDEX "JobReviewOffer_submissionId_status_idx" ON "JobReviewOffer"("submissionId", "status");

-- CreateIndex
CREATE INDEX "JobReviewOffer_agentId_status_idx" ON "JobReviewOffer"("agentId", "status");

-- CreateIndex
CREATE INDEX "JobReviewOffer_beneficiaryUserId_status_idx" ON "JobReviewOffer"("beneficiaryUserId", "status");

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSubmission" ADD CONSTRAINT "JobSubmission_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSubmission" ADD CONSTRAINT "JobSubmission_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobSubmission" ADD CONSTRAINT "JobSubmission_beneficiaryUserId_fkey" FOREIGN KEY ("beneficiaryUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobReview" ADD CONSTRAINT "JobReview_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "JobSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobReview" ADD CONSTRAINT "JobReview_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobReview" ADD CONSTRAINT "JobReview_beneficiaryUserId_fkey" FOREIGN KEY ("beneficiaryUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobReviewOffer" ADD CONSTRAINT "JobReviewOffer_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "JobSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobReviewOffer" ADD CONSTRAINT "JobReviewOffer_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobReviewOffer" ADD CONSTRAINT "JobReviewOffer_beneficiaryUserId_fkey" FOREIGN KEY ("beneficiaryUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

