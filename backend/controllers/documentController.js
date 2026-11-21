import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { extractDocumentText } from '../services/pdfService.js';
import { chunkDocument } from '../services/chunkingService.js';
import { generateBatchEmbeddings } from '../services/embeddingService.js';
import {
  addDocumentChunks,
  getDocumentById,
  getAllDocuments,
  getDocumentChunks,
  deleteDocument as deleteFromVectorStore,
} from '../services/chromaService.js';

const uploadDir = path.resolve(
  process.env.RAG_STORAGE_DIR?.trim() || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads')
);

async function removeStoredFile(filename) {
  if (!filename) return;

  const safeFilename = path.basename(filename);
  if (safeFilename !== filename) {
    throw new Error('Stored document filename is invalid.');
  }

  try {
    await fs.unlink(path.join(uploadDir, safeFilename));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Handles uploading and processing a PDF or TXT document.
 */
export async function uploadDocument(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Please upload a PDF or TXT document.',
      });
    }

    const { originalname, path: filePath, size, mimetype, filename: storedFilename } = req.file;
    const documentId = uuidv4();

    console.log(`[Upload] Processing document: "${originalname}" (Size: ${(size / 1024).toFixed(1)} KB)`);

    // 1. Extract text from document
    const extracted = await extractDocumentText(filePath);

    if (!extracted.fullText || extracted.fullText.trim().length === 0) {
      await removeStoredFile(storedFilename);
      return res.status(422).json({
        success: false,
        error: 'No readable text was found, even after trying OCR. Check that the PDF pages are clear enough to read.',
      });
    }

    // 2. Chunk document with semantic boundaries & overlap
    const chunks = chunkDocument(extracted, documentId, originalname, {
      maxTokens: 500,
      overlapTokens: 100,
    });

    console.log(`[Upload] Document generated ${chunks.length} chunks across ${extracted.numPages} page(s).`);

    // 3. Generate embeddings for all chunks
    const chunkTexts = chunks.map((c) => c.text);
    const { embeddings } = await generateBatchEmbeddings(chunkTexts);

    // 4. Index in Vector Store
    const documentInfo = {
      documentId,
      filename: originalname,
      originalName: originalname,
      storedFilename,
      numPages: extracted.numPages,
      fileSize: size,
      mimeType: mimetype,
      uploadedAt: new Date().toISOString(),
    };

    await addDocumentChunks(chunks, embeddings, documentInfo);

    return res.status(201).json({
      success: true,
      message: `Document "${originalname}" successfully processed and indexed.`,
      document: {
        id: documentId,
        filename: originalname,
        numPages: extracted.numPages,
        totalChunks: chunks.length,
        totalTokens: chunks.reduce((acc, c) => acc + (c.tokenCount || 0), 0),
        uploadedAt: documentInfo.uploadedAt,
        fileSize: size,
      },
    });
  } catch (error) {
    console.error('[Upload Error]', error);
    if (req.file?.filename) {
      try {
        await removeStoredFile(req.file.filename);
      } catch (cleanupError) {
        console.error('[Upload Cleanup Error]', cleanupError);
      }
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to process this document. Please check the file and try again.',
    });
  }
}

/**
 * Returns list of all indexed documents.
 */
export async function listDocuments(req, res) {
  try {
    const docs = getAllDocuments();
    return res.json({
      success: true,
      count: docs.length,
      documents: docs,
    });
  } catch (error) {
    console.error('[List Documents Error]', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve documents.',
    });
  }
}

/**
 * Retrieves single document details and chunk previews.
 */
export async function getDocumentDetails(req, res) {
  try {
    const { id } = req.params;
    const doc = getDocumentById(id);

    if (!doc) {
      return res.status(404).json({
        success: false,
        error: 'Document not found.',
      });
    }

    const { ownerId, storedFilename, ...document } = doc;
    const chunks = getDocumentChunks(id);

    return res.json({
      success: true,
      document,
      chunks,
    });
  } catch (error) {
    console.error('[Get Document Error]', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get document details.',
    });
  }
}

/**
 * Deletes a document and its chunks.
 */
export async function deleteDocument(req, res) {
  try {
    const { id } = req.params;
    const doc = getDocumentById(id);

    if (!doc) {
      return res.status(404).json({
        success: false,
        error: 'Document not found.',
      });
    }

    await removeStoredFile(doc.storedFilename);
    await deleteFromVectorStore(id);

    return res.json({
      success: true,
      message: `Document "${doc.filename}" was deleted successfully.`,
    });
  } catch (error) {
    console.error('[Delete Document Error]', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete document.',
    });
  }
}
