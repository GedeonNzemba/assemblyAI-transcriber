import sys
import json
import whisperx
import torch

def align_audio(audio_path):
    """
    Performs transcription and forced alignment on an audio file using whisper-x.
    """
    try:
        print("[PYTHON_LOG] Alignment script started.", file=sys.stderr)
        
        # Check for GPU availability
        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        print(f"[PYTHON_LOG] Using device: {device}, compute_type: {compute_type}", file=sys.stderr)
        
        # 1. Load whisper model
        print("[PYTHON_LOG] Loading whisper model (this may take a while on first run)...", file=sys.stderr)
        model = whisperx.load_model("small", device, compute_type=compute_type)
        print("[PYTHON_LOG] Whisper model loaded.", file=sys.stderr)
        
        # 2. Load audio
        print("[PYTHON_LOG] Loading audio file...", file=sys.stderr)
        audio = whisperx.load_audio(audio_path)
        print("[PYTHON_LOG] Audio file loaded.", file=sys.stderr)
        
        # 3. Transcribe
        print("[PYTHON_LOG] Transcribing audio...", file=sys.stderr)
        result = model.transcribe(audio, batch_size=16)
        print("[PYTHON_LOG] Transcription complete.", file=sys.stderr)
        
        # 4. Load alignment model
        print("[PYTHON_LOG] Loading alignment model...", file=sys.stderr)
        model_a, metadata = whisperx.load_align_model(language_code=result["language"], device=device)
        print("[PYTHON_LOG] Alignment model loaded.", file=sys.stderr)
        
        # 5. Align transcription
        print("[PYTHON_LOG] Aligning transcription...", file=sys.stderr)
        aligned_result = whisperx.align(result["segments"], model_a, metadata, audio, device, return_char_alignments=False)
        print("[PYTHON_LOG] Alignment complete.", file=sys.stderr)

        # Print the final result to stdout
        print(json.dumps(aligned_result))

    except Exception as e:
        print(f"[PYTHON_ERROR] An error occurred during alignment: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    # The script now only needs the audio file path as an argument.
    if len(sys.argv) != 2:
        print("Usage: python align.py <audio_path>", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    
    # The text file from the original implementation is no longer needed.
    align_audio(audio_file)
