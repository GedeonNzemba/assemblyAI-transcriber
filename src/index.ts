import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient, DeepgramClient } from '@deepgram/sdk';
import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import pdf from 'pdf-parse';

dotenv.config();

// --- Environment Variable Validation ---
const requiredEnvVars = [
  'DEEPGRAM_API_KEY',
  'ACCOUNT_ID',
  'ACCOUNT_KEY_ID',
  'SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
];
const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}
// ----------------------------------------

const app = express();
const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);
const port = process.env.PORT || 3000;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.ACCOUNT_KEY_ID!,
    secretAccessKey: process.env.SECRET_ACCESS_KEY!,
  },
});

app.use(express.json());

// --- Helper Functions ---
const getCacheKey = (url: string) => crypto.createHash('sha256').update(url).digest('hex');

const streamToString = (stream: any): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (chunk: any) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
// ----------------------

app.get('/', (req: Request, res: Response) => {
  res.status(200).send('Transcription server is healthy and running!');
});

// --- Background Transcription Processing ---
const processAndCacheTranscription = async (audioUrl: string, cacheKey: string) => {
  console.log('Starting background transcription for:', audioUrl);
  try {
    const { result, error: deepgramError } = await deepgram.listen.prerecorded.transcribeUrl(
      { url: audioUrl },
      {
        model: 'whisper-large',
        smart_format: true,
        punctuate: true,
        diarize: true,
        paragraphs: true,
      }
    );

    if (deepgramError) {
      // In a real-world scenario, you'd want more robust error handling,
      // like a separate error state in the cache or a dead-letter queue.
      console.error('Deepgram API Error during background processing:', deepgramError);
      return; // Stop processing on error
    }

    const transcript = result.results.channels[0].alternatives[0];

    // Cache the result in R2
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: cacheKey,
      Body: JSON.stringify(transcript),
      ContentType: 'application/json',
    }));
    console.log('Transcription complete and cached for:', audioUrl);

  } catch (submitError: any) {
    console.error('Error during background transcription or caching:', submitError);
  }
};
// ----------------------------------------

app.post('/transcribe', async (req: Request, res: Response) => {
  const { audioUrl } = req.body;
  if (!audioUrl) {
    return res.status(400).json({ error: 'audioUrl is required' });
  }

  const cacheKey = getCacheKey(audioUrl);

  try {
    // 1. Check R2 for a cached transcription
    await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: cacheKey }));
    const data = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: cacheKey }));
    const body = await streamToString(data.Body);

    console.log('Cache hit for:', audioUrl);
    return res.status(200).json({ status: 'cached', transcript: JSON.parse(body) });

  } catch (error: any) {
    if (error.name !== 'NotFound') {
      console.error('Error checking R2 cache:', error);
      return res.status(500).json({ error: 'Could not check cache.' });
    }

    // 2. Cache miss: Start background job and respond immediately
    console.log('Cache miss. Starting background job for:', audioUrl);

    // Don't await this call - let it run in the background
    processAndCacheTranscription(audioUrl, cacheKey);

    // Respond to the client immediately that the job has been accepted
    return res.status(202).json({ status: 'processing', message: 'Transcription has started. Please poll the status endpoint.' });
  }
});

app.post('/extract-pdf', async (req, res) => {
  const { pdfUrl } = req.body;

  if (!pdfUrl) {
    return res.status(400).json({ error: 'pdfUrl is required' });
  }

  const cacheKey = getCacheKey(pdfUrl) + '.txt';

  try {
    // 1. Check R2 for cached PDF text
    await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: cacheKey }));
    const data = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: cacheKey }));
    const cachedText = await streamToString(data.Body);

    console.log('PDF cache hit for:', pdfUrl);
    return res.status(200).json({ text: cachedText });

  } catch (error: any) {
    if (error.name !== 'NotFound') {
      console.error('Error checking PDF cache:', error);
      return res.status(500).json({ error: 'Could not check PDF cache.' });
    }

    // 2. Cache miss: Download, parse, and cache the PDF
    console.log('PDF cache miss. Processing:', pdfUrl);
    try {
      console.log(`[PDF EXTRACTION] About to download PDF from: ${pdfUrl}`);
      const response = await axios.get(pdfUrl, { 
        responseType: 'arraybuffer',
        timeout: 25000 // 25-second timeout
      });
      console.log(`[PDF EXTRACTION] Successfully downloaded PDF. Size: ${response.data.length} bytes.`);

      console.log('[PDF EXTRACTION] About to parse PDF data.');
      const data = await pdf(response.data);
      const text = data.text;
      console.log('[PDF EXTRACTION] Successfully parsed PDF.');

      // Cache the extracted text in R2
      await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: cacheKey,
        Body: text,
        ContentType: 'text/plain',
      }));

      console.log('PDF processed and cached for:', pdfUrl);
      return res.status(200).json({ text });

    } catch (parseError: any) {
      console.error('Error processing PDF:', parseError.message);
      return res.status(500).json({ error: 'Failed to process PDF.' });
    }
  }
});

// gedeon

app.post('/transcription-status', async (req: Request, res: Response) => {
  const { audioUrl } = req.body;
  if (!audioUrl) {
    return res.status(400).json({ error: 'audioUrl is required' });
  }

  const cacheKey = getCacheKey(audioUrl);

  try {
    // Check R2 for the completed job
    const data = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: cacheKey }));
    const body = await streamToString(data.Body);

    console.log('Status check: Job completed for', audioUrl);
    return res.status(200).json({ status: 'completed', transcript: JSON.parse(body) });

  } catch (error: any) {
    if (error.name === 'NotFound') {
      // The file isn't in the cache yet, so it's still processing
      return res.status(202).json({ status: 'processing' });
    }
    // Handle other potential S3 errors
    console.error('Error checking transcription status in R2:', error);
    return res.status(500).json({ status: 'failed', error: 'Could not check job status.' });
  }
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});