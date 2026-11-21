import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.resolve(
  process.env.RAG_STORAGE_DIR?.trim() || path.join(__dirname, '..', 'uploads')
);

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const sanitizedBase = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .substring(0, 50);
    const uniqueName = `${uuidv4()}_${sanitizedBase}${ext}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const extension = path.extname(file.originalname).toLowerCase();
  const mimeType = file.mimetype.toLowerCase();
  const supportedTypes = {
    '.pdf': ['application/pdf', 'application/x-pdf', 'application/octet-stream'],
    '.txt': ['text/plain', 'application/octet-stream'],
  };

  if (supportedTypes[extension]?.includes(mimeType)) {
    cb(null, true);
  } else {
    const error = new Error('Only PDF and TXT files are supported.');
    error.status = 400;
    cb(error, false);
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});
