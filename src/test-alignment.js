const axios = require('axios');

const API_BASE_URL = 'http://localhost:3000';
// Using a short, public audio file for a quick test.
const AUDIO_URL = 'https://static.deepgram.com/examples/Bueller-Life-moves-pretty-fast.wav';
const TEXT = "Life moves pretty fast. If you don't stop and look around once in a while, you could miss it.";

/**
 * Polls the /alignment-status endpoint until the job is complete or fails.
 */
const pollStatus = async (payload) => {
  console.log('Polling for alignment status...');
  try {
    const response = await axios.post(`${API_BASE_URL}/alignment-status`, payload);
    const { status, result } = response.data;

    console.log(`Current status: ${status}`);

    if (status === 'completed') {
      console.log('\n✅ Alignment successful!\n');
      console.log('Final Result:');
      console.log(JSON.stringify(result, null, 2));
      return true; // Done
    }
    if (status === 'failed') {
      console.error('\n❌ Alignment failed.\n');
      console.error(response.data.error);
      return true; // Done
    }
    return false; // Not done, poll again
  } catch (error) {
    console.error('Error polling status:', error.response ? error.response.data : error.message);
    return true; // Stop polling on error
  }
};

/**
 * Main function to start the alignment test.
 */
const testAlignment = async () => {
  const payload = {
    audioUrl: AUDIO_URL,
    pdfText: TEXT,
  };

  try {
    console.log('Sending alignment request to the server...');
    const initialResponse = await axios.post(`${API_BASE_URL}/align`, payload);
    console.log('Server responded:', initialResponse.data);

    // If the result is already in the cache, print it and exit.
    if (initialResponse.status === 200 && initialResponse.data.status === 'cached') {
        console.log('\n✅ Result was already cached:\n');
        console.log(JSON.stringify(initialResponse.data.result, null, 2));
        return;
    }

    // If the job was just submitted, start polling for the result.
    if (initialResponse.status === 202) {
      // Use a recursive setTimeout to keep the process alive while polling
      const pollForCompletion = async () => {
        const isDone = await pollStatus(payload);
        if (!isDone) {
          setTimeout(pollForCompletion, 5000); // Poll again in 5 seconds
        }
      };
      await pollForCompletion();
      return;
    }

    // Handle any other unexpected responses.
    console.error('Unexpected initial response status:', initialResponse.status);

  } catch (error) {
    console.error('Error starting alignment job:', error.response ? error.response.data : error.message);
  }
};

// Run the test
testAlignment();
