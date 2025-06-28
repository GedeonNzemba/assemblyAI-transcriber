import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import axios from 'axios';
import { spawn } from 'child_process';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import pdf from 'pdf-parse';
import Cache from 'node-cache';

dotenv.config();

// --- Cache & Environment ---
// Job cache for tracking status of long-running alignment tasks
const jobCache = new Cache({ stdTTL: 3600, checkperiod: 120 }); // TTL 1hr

// --- Batch Processing Queue ---
const batchQueue: { audioUrl: string, text: string }[] = [];
let isBatchRunning = false;
// --------------------------

const requiredEnvVars = [
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
// --------------------------

const app = express();
const port = process.env.PORT || 3001;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.ACCOUNT_KEY_ID!,
    secretAccessKey: process.env.SECRET_ACCESS_KEY!,
  },
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
  res.status(200).send('Forced Alignment server is healthy and running!');
});

// --- Background Alignment Processing ---
const processAndCacheAlignment = async (audioUrl: string, jobId: string) => {
  console.log(`[ALIGN_JOB] Starting for job: ${jobId}, audio: ${audioUrl}`);
  jobCache.set(jobId, { status: 'processing' });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alignment-'));
  console.log(`[ALIGN_JOB] Created temp directory: ${tempDir}`);
  const audioFileName = `${crypto.randomBytes(16).toString('hex')}.mp3`;
  const audioPath = path.join(tempDir, audioFileName);

  try {
    // 1. Download audio file
    console.log(`[ALIGN_JOB] Downloading audio for job ${jobId}`);
    const audioResponse = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 60000 });
    await fs.writeFile(audioPath, audioResponse.data);
    console.log(`[ALIGN_JOB] Audio saved to ${audioPath} for job ${jobId}`);

    // 2. Run Python alignment script
    console.log(`[ALIGN_JOB] Spawning Python script for job ${jobId}...`);
    const pythonProcess = spawn('python3', ['-u', 'src/align.py', audioPath]);

    pythonProcess.on('error', (err) => {
      console.error(`[SPAWN_ERROR] Failed to start Python process for job ${jobId}.`, err);
      jobCache.set(jobId, { status: 'error', error: 'Failed to start alignment process.' });
    });

    let scriptOutput = '';
    let scriptError = '';

    pythonProcess.stdout.on('data', (data) => {
      console.log(`[PYTHON_STDOUT] Job ${jobId}: ${data.toString()}`);
      scriptOutput += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error(`[PYTHON_STDERR] Job ${jobId}: ${data.toString()}`);
      scriptError += data.toString();
    });

    pythonProcess.on('close', async (code) => {
      console.log(`[ALIGN_JOB] Python script for job ${jobId} finished with code ${code}.`);
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log(`[ALIGN_JOB] Cleaned up temp directory for job ${jobId}: ${tempDir}`);

      if (code !== 0) {
        console.error(`[ALIGN_JOB] Script for job ${jobId} failed with code ${code}: ${scriptError}`);
        jobCache.set(jobId, { status: 'error', error: `Script failed with code ${code}.`, details: scriptError });
        return;
      }

      console.log(`[ALIGN_JOB] Script for job ${jobId} successful. Caching result...`);
      try {
        const alignedResult = JSON.parse(scriptOutput);
        await s3.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME!,
          Key: jobId, // Use jobId as the key for the final result
          Body: JSON.stringify(alignedResult),
          ContentType: 'application/json',
        }));
        jobCache.set(jobId, { status: 'completed' });
        console.log(`[ALIGN_JOB] Alignment complete and cached for job ${jobId}`);
      } catch (e) {
        console.error(`[ALIGN_JOB] Error parsing Python output or caching to R2 for job ${jobId}:`, e);
        console.error(`[ALIGN_JOB] Raw script output for job ${jobId}:`, scriptOutput);
        jobCache.set(jobId, { status: 'error', error: 'Failed to parse or cache alignment result.' });
      }
    });

  } catch (error) {
    console.error(`[ALIGN_JOB] Error during pre-processing for job ${jobId}:`, error);
    jobCache.set(jobId, { status: 'error', error: 'Failed during file download.' });
    await fs.rm(tempDir, { recursive: true, force: true }).catch(e => console.error(`Failed to cleanup temp dir for failed job ${jobId}`, e));
  }
};
// ----------------------------------------

// --- API Endpoints ---

app.post('/align', async (req: Request, res: Response) => {
  const { audioUrl } = req.body;
  if (!audioUrl) {
    return res.status(400).json({ error: 'audioUrl is required' });
  }

  const jobId = getCacheKey(audioUrl);

  // 1. Check job cache for an in-progress job
  const currentJobStatus: any = jobCache.get(jobId);
  if (currentJobStatus && (currentJobStatus.status === 'pending' || currentJobStatus.status === 'processing')) {
    console.log(`Job ${jobId} is already in progress. Status: ${currentJobStatus.status}`);
    return res.status(202).json({ jobId, status: currentJobStatus.status });
  }

  // 2. Check S3 for a completed job
  try {
    await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: jobId }));
    console.log(`Alignment cache hit in S3 for job ${jobId}.`);
    // The client should now call /align/status/:jobId to get the result
    return res.status(200).json({ jobId, status: 'completed' });
  } catch (error: any) {
    if (error.name !== 'NotFound' && error.name !== 'NoSuchKey') {
      console.error('Error checking alignment cache:', error);
      return res.status(500).json({ error: 'Could not check alignment cache.' });
    }
  }

  // 3. If not cached and not in progress, start a new job
  console.log(`Alignment cache miss. Starting background job ${jobId}`);
  jobCache.set(jobId, { status: 'pending' });

  // Start processing in the background, don't await it
  processAndCacheAlignment(audioUrl, jobId).catch(err => {
    console.error(`[FATAL] Unhandled error in processAndCacheAlignment for job ${jobId}:`, err);
    jobCache.set(jobId, { status: 'error', error: 'An unexpected fatal error occurred.' });
  });

  // Immediately respond to the client
  return res.status(202).json({ jobId, status: 'started' });
});

app.get('/align/status/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  // 1. Check job cache
  const jobStatus: any = jobCache.get(jobId);
  if (jobStatus) {
    if (jobStatus.status === 'completed') {
       // If status is completed, fetch the result from S3 and return it
       try {
        const data = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: jobId }));
        const result = await streamToString(data.Body);
        return res.status(200).json({ jobId, status: 'completed', result: JSON.parse(result) });
      } catch (error) {
        console.error(`Failed to fetch completed job ${jobId} from S3:`, error);
        return res.status(500).json({ jobId, status: 'error', error: 'Failed to retrieve completed job data.' });
      }
    } else {
      // Return pending, processing, or error status
      return res.status(200).json({ jobId, ...jobStatus });
    }
  }

  // 2. If not in job cache, check S3 as a fallback
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: jobId }));
    const result = await streamToString(data.Body);
    console.log(`Status cache miss, but found completed job ${jobId} in S3.`);
    jobCache.set(jobId, { status: 'completed' }); // Re-populate cache
    return res.status(200).json({ jobId, status: 'completed', result: JSON.parse(result) });
  } catch (error: any) {
    if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
      return res.status(404).json({ jobId, status: 'not_found' });
    }
    console.error(`Error checking S3 for job ${jobId}:`, error);
    return res.status(500).json({ error: 'Could not retrieve job status.' });
  }
});

app.post('/extract-pdf', async (req, res) => {
    const { pdfUrl } = req.body;
  
    if (!pdfUrl) {
      return res.status(400).json({ error: 'pdfUrl is required' });
    }
  
    const cacheKey = getCacheKey(pdfUrl) + '.txt';
  
    try {
      await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: cacheKey }));
      const data = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: cacheKey }));
      const cachedText = await streamToString(data.Body);
  
      console.log('PDF cache hit for:', pdfUrl);
      return res.status(200).json({ text: cachedText });
  
    } catch (error: any) {
      if (error.name !== 'NotFound' && error.name !== 'NoSuchKey') {
        console.error('Error checking PDF cache:', error);
        return res.status(500).json({ error: 'Could not check PDF cache.' });
      }
  
      console.log('PDF cache miss. Processing:', pdfUrl);
      try {
        console.log(`[PDF EXTRACTION] About to download PDF from: ${pdfUrl}`);
        const response = await axios.get(pdfUrl, { 
          responseType: 'arraybuffer',
          timeout: 25000
        });
        console.log(`[PDF EXTRACTION] Successfully downloaded PDF. Size: ${response.data.length} bytes.`);
  
        console.log('[PDF EXTRACTION] About to parse PDF data.');
        const data = await pdf(response.data);
        const text = data.text;
        console.log('[PDF EXTRACTION] Successfully parsed PDF.');
  
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


// --- Batch Processing Endpoint & Worker ---

const processBatchQueue = async () => {
  if (batchQueue.length === 0) {
    console.log('[BATCH] Queue is empty. Processor is going idle.');
    isBatchRunning = false;
    return;
  }

  isBatchRunning = true;
  const { audioUrl, text } = batchQueue.shift()!; // Get the next job

  console.log(`[BATCH] Starting job for audio: ${audioUrl}`);

  try {
    const jobId = getCacheKey(audioUrl);
    console.log(`[BATCH] Triggering alignment for job ID: ${jobId}`);

    // Use the existing async function to process the alignment
    processAndCacheAlignment(audioUrl, jobId);

    // Poll for completion to process the next item in the queue
    const pollInterval = setInterval(async () => {
      const jobStatus: any = jobCache.get(jobId);

      // Check for completion in cache OR fallback to S3 for completed jobs
      let isCompleted = jobStatus && jobStatus.status === 'completed';
      let isError = jobStatus && jobStatus.status === 'error';

      if (isCompleted || isError) {
        clearInterval(pollInterval);
        console.log(`[BATCH] Job ${jobId} finished with status: ${jobStatus.status}. Moving to next job.`);
        // Process the next item in the queue
        processBatchQueue();
      } else {
        console.log(`[BATCH] Waiting for job ${jobId} to complete. Current status: ${jobStatus?.status || 'pending'}`);
      }
    }, 20000); // Poll every 20 seconds

  } catch (error) {
    console.error(`[BATCH] Fatal error processing job for ${audioUrl}. Skipping.`, error);
    // Move to the next job even if this one fails
    processBatchQueue();
  }
};

app.post('/batch', async (req: Request, res: Response) => {
  const { jobs } = req.body; // Expecting an array of { audioUrl, pdfUrl }

  if (!Array.isArray(jobs) || jobs.length === 0) {
    return res.status(400).json({ error: 'Request body must be an array of jobs, each with audioUrl and pdfUrl.' });
  }

  console.log(`[BATCH] Receiving ${jobs.length} new jobs.`);

  // Pre-process all PDFs first and prepare alignment jobs
  for (const job of jobs) {
    try {
      console.log(`[BATCH] Pre-processing PDF from ${job.pdfUrl}`);
      const pdfCacheKey = getCacheKey(job.pdfUrl) + '.txt';
      let pdfText = '';

      // Check cache for PDF
      try {
        const data = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: pdfCacheKey }));
        pdfText = await streamToString(data.Body);
        console.log(`[BATCH] PDF cache hit for ${job.pdfUrl}`);
      } catch (e) {
        // If not cached, fetch and parse
        const response = await axios.get(job.pdfUrl, { responseType: 'arraybuffer' });
        const data = await pdf(response.data);
        pdfText = data.text;
        // Cache the new PDF text
        await s3.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME!,
          Key: pdfCacheKey,
          Body: pdfText,
          ContentType: 'text/plain',
        }));
        console.log(`[BATCH] PDF processed and cached for ${job.pdfUrl}`);
      }

      // Add the job with the actual text to the queue
      batchQueue.push({ audioUrl: job.audioUrl, text: pdfText });

    } catch (error) {
      console.error(`[BATCH] Failed to process PDF for ${job.pdfUrl}. Skipping this job.`, error);
    }
  }

  console.log(`[BATCH] Finished pre-processing. Added ${batchQueue.length} valid jobs to the queue.`);

  // If the batch processor isn't already running, start it.
  if (!isBatchRunning) {
    processBatchQueue();
  }

  res.status(202).json({ message: 'Batch accepted and queued for processing.' });
});


app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});