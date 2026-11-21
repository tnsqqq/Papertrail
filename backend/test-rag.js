import fs from 'fs/promises';
import os from 'os';
import path from 'path';

async function runTest() {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'papertrail-rag-test-'));
  const testDocPath = path.join(testDir, 'sample.txt');

  process.env.RAG_STORAGE_DIR = path.join(testDir, 'index');
  process.env.RAG_DISABLE_CHROMA = 'true';
  process.env.EMBEDDING_PROVIDER = 'local_test';
  process.env.OPENAI_API_KEY = '';
  process.env.GEMINI_API_KEY = '';

  try {
    const [
      { extractDocumentText },
      { chunkDocument },
      { generateBatchEmbeddings, generateQueryEmbedding },
      { initVectorStore, addDocumentChunks, querySimilarChunks, getAllDocuments },
      { generateRAGAnswer },
    ] = await Promise.all([
      import('./services/pdfService.js'),
      import('./services/chunkingService.js'),
      import('./services/embeddingService.js'),
      import('./services/chromaService.js'),
      import('./services/ragService.js'),
    ]);

    console.log('Starting isolated local RAG pipeline test.');
    const sampleContent = `
Document Title: NovaCore Platform Specification

Architecture Overview
The NovaCore platform uses a vector retrieval pipeline and scales across Kubernetes nodes.

Security and Encryption
Document vectors and raw text segments are encrypted at rest using AES-256-GCM.
Network communication requires TLS 1.3 with mutual authentication.

Pricing
The Enterprise Tier starts at $4,999 per month and includes 100 GB vector storage.
`;
    await fs.writeFile(testDocPath, sampleContent.trim(), 'utf-8');

    const extracted = await extractDocumentText(testDocPath);
    const documentId = `test-${Date.now()}`;
    const chunks = chunkDocument(extracted, documentId, 'sample.txt', {
      maxTokens: 100,
      overlapTokens: 25,
    });
    const { embeddings } = await generateBatchEmbeddings(chunks.map((chunk) => chunk.text));

    await initVectorStore();
    await addDocumentChunks(chunks, embeddings, {
      documentId,
      filename: 'sample.txt',
      numPages: extracted.numPages,
      fileSize: (await fs.stat(testDocPath)).size,
    });

    if (!getAllDocuments().some((document) => document.id === documentId)) {
      throw new Error('The sample document was not indexed.');
    }

    for (const { question, expectedAnswer } of [
      {
        question: 'What encryption standard is used for data at rest?',
        expectedAnswer: 'AES-256-GCM',
      },
      {
        question: 'How much does the Enterprise Tier cost per month?',
        expectedAnswer: '$4,999',
      },
    ]) {
      const { embedding: queryEmbedding } = await generateQueryEmbedding(question);
      const hits = await querySimilarChunks(queryEmbedding, 3, documentId, question);
      if (hits.length === 0) throw new Error(`No passages were retrieved for: ${question}`);

      const result = await generateRAGAnswer({ query: question, retrievedChunks: hits });
      if (!result.answer.toLowerCase().includes(expectedAnswer.toLowerCase())) {
        throw new Error(`Expected "${expectedAnswer}" in the answer to: ${question}`);
      }
      console.log(`PASS ${question}`);
    }

    console.log('Local RAG pipeline test passed.');
  } catch (error) {
    console.error('Local RAG pipeline test failed:', error);
    process.exitCode = 1;
  } finally {
    await fs.rm(testDir, { recursive: true, force: true });
  }
}

runTest();
