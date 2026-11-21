import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { createCanvas } from '@napi-rs/canvas';
import PDFDocument from 'pdfkit';
import { recognizeScannedPages } from '../services/ocrService.js';
import { extractTextFromPdf } from '../services/pdfService.js';

function createPdf(drawPage) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: false, margin: 0 });
    const parts = [];
    document.on('data', (part) => parts.push(part));
    document.on('end', () => resolve(Buffer.concat(parts)));
    document.on('error', reject);
    document.addPage({ size: [600, 200], margin: 0 });
    drawPage(document);
    document.end();
  });
}

async function extractFromTemporaryPdf(pdfBuffer, context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ragpdf-ocr-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'test.pdf');
  await writeFile(filePath, pdfBuffer);
  return extractTextFromPdf(filePath);
}

async function createScannedPdf() {
  const canvas = createCanvas(1200, 400);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000';
  context.font = '96px Arial';
  context.fillText('OCR SCAN TEST 123', 45, 250);
  const image = canvas.toBuffer('image/jpeg', 0.95);

  return createPdf((document) => {
    document.image(image, 0, 0, { width: 600, height: 200 });
  });
}

test('skips OCR for pages with enough extractable text', async () => {
  const didOcr = await recognizeScannedPages(Buffer.from('not a PDF'), [{
    pageNumber: 1,
    text: 'This page already contains enough selectable text to answer questions without needing OCR recognition.',
  }]);

  assert.equal(didOcr, false);
});

test('uses local OCR to extract text from an image-only PDF page', async (context) => {
  const result = await extractFromTemporaryPdf(await createScannedPdf(), context);

  assert.equal(result.numPages, 1);
  assert.match(result.pages[0].text, /OCR SCAN TEST 123/i);
  assert.match(result.fullText, /OCR SCAN TEST 123/i);
});
