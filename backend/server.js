import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';

import { initVectorStore } from './services/chromaService.js';
import documentRoutes from './routes/documentRoutes.js';
import queryRoutes from './routes/queryRoutes.js';
import statusRoutes from './routes/statusRoutes.js';

dotenv.config();

const app = express();
const DEFAULT_PORT = Number(process.env.PORT || 5000);

function createRateLimiter(limit) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.',
      });
    },
  });
}

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000',
  })
);
app.use(helmet());

app.use(express.json({ limit: '1mb' }));
app.use('/api', createRateLimiter(300));
app.use('/api/query', createRateLimiter(30));
app.use('/api/documents/upload', createRateLimiter(10));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/documents', documentRoutes);
app.use('/api/query', queryRoutes);
app.use('/api/status', statusRoutes);

app.get('/', (req, res) => {
  res.json({
    name: 'Document RAG API Server',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      status: 'GET /api/status',
      uploadDocument: 'POST /api/documents/upload',
      listDocuments: 'GET /api/documents',
      getDocument: 'GET /api/documents/:id',
      deleteDocument: 'DELETE /api/documents/:id',
      query: 'POST /api/query',
      queryStream: 'POST /api/query/stream',
    },
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'API route not found.' });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: 'File is too large. Maximum allowed size is 10 MB.',
      });
    }
    return res.status(400).json({
      success: false,
      error: `Upload error: ${err.message}`,
    });
  }

  if (err) {
    const requestedStatus = Number(err.status);
    const status = Number.isInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
      ? requestedStatus
      : 500;
    if (status >= 500) console.error('[Unhandled Server Error]', err);
    return res.status(status).json({
      success: false,
      error: status >= 500 ? 'Internal server error.' : err.message || 'Invalid request.',
    });
  }

  next();
});

// Initialize vector store and start listening
async function startServer() {
  try {
    if (!Number.isInteger(DEFAULT_PORT) || DEFAULT_PORT < 1 || DEFAULT_PORT > 65535) {
      throw new Error('PORT must be an integer between 1 and 65535.');
    }
    console.log('--- Initializing Document RAG Backend ---');
    await initVectorStore();

    const server = await new Promise((resolve, reject) => {
      const instance = app.listen(DEFAULT_PORT, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });

    const { port } = server.address();
    console.log(`\nDocument RAG backend running at: http://localhost:${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
    console.log(`System status: http://localhost:${port}/api/status`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default app;
