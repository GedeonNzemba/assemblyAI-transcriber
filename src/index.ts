import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { AssemblyAI } from 'assemblyai';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { Readable } from 'stream';

dotenv.config();

// --- Environment Variable Validation ---
const requiredEnvVars = [
  'ASSEMBLYAI_API_KEY',
  'ACCOUNT_ID',
  'ACCOUNT_KEY_ID',
  'SECRET_ACCESS_KEY',
];
const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}
// ----------------------------------------

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// AssemblyAI Client
const assemblyai = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY!,
});

// Configure Cloudflare R2 with AWS SDK v3
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.ACCOUNT_KEY_ID!,
    secretAccessKey: process.env.SECRET_ACCESS_KEY!,
  },
});

const R2_BUCKET_NAME = 'saintshubapp-transcribed-sermons';

// Helper to create a unique key for a URL
const getCacheKey = (url: string) => crypto.createHash('sha256').update(url).digest('hex');

// Helper to convert a stream to a string
const streamToString = (stream: Readable): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });

app.get('/', (req: Request, res: Response) => {
  res.status(200).send('Transcription server is healthy and running!');
});

app.post('/transcribe', async (req: Request, res: Response) => {
  const { audioUrl } = req.body;
  if (!audioUrl) return res.status(400).json({ error: 'audioUrl is required' });

  const cacheKey = getCacheKey(audioUrl);

  try {
    // 1. Check R2 for a cached transcription
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: cacheKey }));
    const data = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: cacheKey }));
    const body = await streamToString(data.Body as Readable);

    console.log('Cache hit for:', audioUrl);
    return res.status(200).json({ status: 'cached', transcript: JSON.parse(body) });

  } catch (error: any) {
    if (error.name !== 'NotFound') {
      console.error('Error checking R2 cache:', error);
      return res.status(500).json({ error: 'Could not check cache.' });
    }

    // 2. Cache miss: Submit a new job to AssemblyAI
    console.log('Cache miss. Submitting new job for:', audioUrl);
    try {
      const transcript = await assemblyai.transcripts.submit({
        audio_url: audioUrl,
        speaker_labels: true,
        word_boost: ['Gedeon', 'Saint', 'Hub', 'William', 'Branham'],
      });
      return res.status(202).json({ status: 'processing', id: transcript.id });
    } catch (submitError) {
      console.error('Error submitting to AssemblyAI:', submitError);
      return res.status(500).json({ error: 'Failed to submit transcription job.' });
    }
  }
});

app.get('/status/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const transcript = await assemblyai.transcripts.get(id);

    if (transcript.status === 'completed') {
      // 3. Job finished: Save to cache and return
      const cacheKey = getCacheKey(transcript.audio_url!);
      await s3.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: cacheKey,
        Body: JSON.stringify(transcript),
        ContentType: 'application/json',
      }));

      console.log('Job completed and cached:', transcript.id);
      return res.status(200).json({ status: 'completed', response: transcript });

    } else if (transcript.status === 'error') {
      console.error('Transcription failed:', transcript.error);
      return res.status(500).json({ status: 'error', message: transcript.error });
    } else {
      return res.status(200).json({ status: transcript.status });
    }
  } catch (error) {
    console.error('Error retrieving transcript status:', error);
    return res.status(500).json({ error: 'Failed to get job status.' });
  }
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});