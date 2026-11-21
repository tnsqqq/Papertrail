import express from 'express';
import { askQuestion, askQuestionStream } from '../controllers/queryController.js';

const router = express.Router();

router.post('/', askQuestion);

router.post('/stream', askQuestionStream);

export default router;
