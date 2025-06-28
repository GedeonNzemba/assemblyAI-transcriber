---
title: Forced Alignment Server
emoji: 🚀
colorFrom: blue
colorTo: green
sdk: docker
app_port: 3001
---
# AssemblyAI Transcription Server

This Node.js/Express server provides an API to transcribe audio files using AssemblyAI's asynchronous transcription service. It includes a caching layer using Cloudflare R2 to avoid re-transcribing the same audio files.

## Features

- **Asynchronous Transcription**: Submits audio URLs for transcription and returns a job ID immediately.
- **Status Polling**: Allows clients to poll for the transcription status.
- **Cloudflare R2 Caching**: Caches completed transcriptions to reduce costs and improve response times.
- **Secure**: Uses environment variables to manage API keys and other secrets.

## Setup

1. **Install Dependencies**:

    ```bash
    npm install
    ```

2. **Create `.env` file**:
    Create a `.env` file in the root of the project and add the following environment variables:

    ```env
    ASSEMBLYAI_API_KEY=your_assemblyai_api_key
    R2_ACCOUNT_ID=your_r2_account_id
    R2_ACCESS_KEY_ID=your_r2_access_key_id
    R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
    R2_BUCKET_NAME=saintshubapp-transcribed-sermons
    ```

3. **Run the server**:

    ```bash
    npm run dev
    ```

The server will start on `http://localhost:3000`.

## Testing Endpoints

You can use `curl` to test the server endpoints.

### 1. Submit a transcription job

This will submit an audio URL to the `/transcribe` endpoint. The server will return a JSON object with the status and the transcription job ID.

```bash
curl -X POST -H "Content-Type: application/json" -d '{"audioUrl": "https://assemblyai-realtimestatic-prod.s3.us-west-2.amazonaws.com/static/demos/media/20130514-105844-320k.mp3"}' http://localhost:3000/transcribe
```

### 2. Extract Text from a PDF

This will submit a PDF URL to the `/extract-pdf` endpoint. The server will download the PDF, extract its text content, cache the result in R2, and return the full text.

```bash
curl -X POST -H "Content-Type: application/json" -d '{"pdfUrl": "https://www.sounddoctrine.net/sermons/pdf/101214.pdf"}' http://localhost:3000/extract-pdf
```

**Expected Response:**

```json
{
  "status": "processing",
  "id": "some-transcription-id"
}
```

### 2. Check the transcription status

Use the `id` from the previous step to poll the `/status/:id` endpoint. Replace `YOUR_TRANSCRIPTION_ID` with the actual ID.

```bash
curl http://localhost:3000/status/YOUR_TRANSCRIPTION_ID
```

**Expected Response (once completed):**

The server will return the full transcription object from AssemblyAI, including the text and word-level timestamps.

```json
{
  "id": "YOUR_TRANSCRIPTION_ID",
  "status": "completed",
  "text": "This is the transcribed text...",
  "words": [...]
}
```
