import { AssemblyAI } from 'assemblyai';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const apiKey = process.env.ASSEMBLYAI_API_KEY;
if (!apiKey) {
  console.error('Error: ASSEMBLYAI_API_KEY environment variable not set.');
  process.exit(1);
}

const assemblyai = new AssemblyAI({
  apiKey,
});

// Set up multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

app.get('/', (req, res) => {
  res.status(200).send('Server is healthy and running!');
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No audio file uploaded.' });
    return;
  }

  try {
    const transcript = await assemblyai.transcripts.transcribe({
      audio: req.file.buffer,
      speaker_labels: true,
      word_boost: ['Gedeon', 'Saint', 'Hub'],
    });

    if (transcript.status === 'error') {
      res.status(500).json({ error: transcript.error });
      return;
    }

    res.json(transcript);
  } catch (error) {
    console.error('Error during transcription:', error);
    res.status(500).json({ error: 'Failed to transcribe audio.' });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});