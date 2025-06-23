const axios = require('axios');

// The URL of a sample audio file to test with.
// This is a sermon from the public domain.
const sampleAudioUrl = 'https://messagehub.info/mp3/English_65-0125_Audio.1392627691049.mp3';

async function testTranscription() {
  console.log(`Sending transcription request for: ${sampleAudioUrl}`);

  try {
    const response = await axios.post('http://localhost:3000/transcribe', {
      audioUrl: sampleAudioUrl,
    });

    console.log('Server responded successfully:');
    console.log(response.data);

    if (response.data.status === 'processing' && response.data.id) {
      console.log('\nTest PASSED: Server accepted the job.');
      console.log(`You can check the status at: http://localhost:3000/status/${response.data.id}`);
    } else if (response.data.status === 'cached') {
        console.log('\nTest PASSED: Server returned a cached transcript.');
    } else {
      console.log('\nTest FAILED: Server response was not in the expected format.');
    }

  } catch (error) {
    console.error('\nTest FAILED: An error occurred while contacting the server.');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
  }
}

testTranscription();