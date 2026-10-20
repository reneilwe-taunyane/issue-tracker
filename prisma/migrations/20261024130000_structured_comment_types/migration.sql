-- CreateEnum
CREATE TYPE "CommentType" AS ENUM ('comment', 'bid', 'review', 'delivery', 'request_to_merge');

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN "type" "CommentType" NOT NULL DEFAULT 'comment',
ADD COLUMN "metadata" JSONB;

-- CreateIndex
CREATE INDEX "Comment_bugId_type_idx" ON "Comment"("bugId", "type");
