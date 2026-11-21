import { mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';

const MIN_PAGE_TEXT_CHARACTERS = 80;
const OCR_RENDER_SCALE = 2;
const OCR_MAX_PIXELS = 4_000_000;
const OCR_CACHE_PATH = path.join(os.tmpdir(), 'papertrail-tesseract');

function needsOcr(text) {
  return (text || '').trim().length < MIN_PAGE_TEXT_CHARACTERS;
}

function mergePageText(extractedText, recognizedText) {
  const existing = (extractedText || '').trim();
  const recognized = (recognizedText || '').trim();
  if (!recognized) return existing;
  if (!existing) return recognized;

  const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalizedExisting = normalize(existing);
  const normalizedRecognized = normalize(recognized);
  if (normalizedRecognized.includes(normalizedExisting)) return recognized;
  if (normalizedExisting.includes(normalizedRecognized)) return existing;
  return `${existing}\n${recognized}`;
}

function installCanvasGlobals(canvas, napiCanvas) {
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
  if (!globalThis.ImageData) globalThis.ImageData = canvas.ImageData;
  if (!globalThis.Path2D) globalThis.Path2D = napiCanvas.Path2D;
}

function createPdfCanvasFactory(createCanvas) {
  return class {
    create(width, height) {
      if (width <= 0 || height <= 0) throw new Error('Invalid PDF canvas size.');
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext('2d') };
    }

    reset(canvasAndContext, width, height) {
      if (!canvasAndContext.canvas || width <= 0 || height <= 0) {
        throw new Error('Invalid PDF canvas.');
      }
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    }

    destroy(canvasAndContext) {
      if (!canvasAndContext.canvas) return;
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    }
  };
}

/**
 * Uses local Tesseract OCR for PDF pages that contain little or no extractable text.
 */
export async function recognizeScannedPages(pdfBuffer, pages) {
  const pagesToRecognize = pages.filter((page) => needsOcr(page.text));
  if (pagesToRecognize.length === 0) return false;

  const [canvas, napiCanvas, tesseract, englishData] = await Promise.all([
    import('canvas'),
    import('@napi-rs/canvas'),
    import('tesseract.js'),
    import('@tesseract.js-data/eng'),
  ]);
  installCanvasGlobals(canvas, napiCanvas);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({
    data: new Uint8Array(pdfBuffer),
    CanvasFactory: createPdfCanvasFactory(canvas.createCanvas),
  });
  let pdfDocument;
  let worker;

  try {
    pdfDocument = await loadingTask.promise;
    await mkdir(OCR_CACHE_PATH, { recursive: true });
    worker = await tesseract.createWorker('eng', 1, {
      langPath: englishData.default.langPath,
      gzip: englishData.default.gzip,
      cachePath: OCR_CACHE_PATH,
    });

    for (const page of pagesToRecognize) {
      let pageCanvas;
      try {
        const pdfPage = await pdfDocument.getPage(page.pageNumber);
        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const basePixels = baseViewport.width * baseViewport.height;
        const scale = Math.min(OCR_RENDER_SCALE, Math.sqrt(OCR_MAX_PIXELS / basePixels));
        const viewport = pdfPage.getViewport({ scale });
        pageCanvas = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = pageCanvas.getContext('2d');
        await pdfPage.render({ canvasContext: context, viewport }).promise;

        const recognition = await worker.recognize(pageCanvas.toBuffer('image/png'));
        page.text = mergePageText(page.text, recognition.data.text);
      } catch (error) {
        throw new Error(`OCR failed on PDF page ${page.pageNumber}: ${error.message}`, { cause: error });
      } finally {
        if (pageCanvas) {
          pageCanvas.width = 0;
          pageCanvas.height = 0;
        }
      }
    }

    return true;
  } finally {
    if (worker) await worker.terminate();
    if (pdfDocument) {
      await pdfDocument.destroy();
    } else {
      await loadingTask.destroy();
    }
  }
}
