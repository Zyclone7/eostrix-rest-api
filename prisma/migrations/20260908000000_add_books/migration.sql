-- CreateTable
CREATE TABLE "books" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "description" TEXT,
    "language" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "originalName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/epub+zip',
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "uploadedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "books_storageKey_key" ON "books"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "books_checksum_key" ON "books"("checksum");

-- CreateIndex
CREATE INDEX "books_uploadedById_idx" ON "books"("uploadedById");

-- CreateIndex
CREATE INDEX "books_published_idx" ON "books"("published");

-- CreateIndex
CREATE INDEX "books_createdAt_idx" ON "books"("createdAt");

-- AddForeignKey
ALTER TABLE "books" ADD CONSTRAINT "books_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
