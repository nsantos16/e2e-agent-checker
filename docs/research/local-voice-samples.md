# Local voice samples

Measured 2026-11-01 on an Apple M4 Pro with 14 logical CPU cores, 48 GiB RAM, and macOS 15.7.3. These are real local speech generations, not mocked transport tests. No paid inference API was called. The models are not integrated with the checker's UI or MCP narration provider yet.

The shared 36-word English script is explicitly a synthetic example, not evidence of a real test run:

> This is an AI-generated voice sample. In this example, we open a note, add two lines, and save. One check passes, but the second check fails. Review the recording and the error before approving the change.

| Runtime / model | Voice | Median warm synthesis | Audio duration | Model loading | First synthesis | Peak process RAM |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Kokoro JS 1.2.1 / Kokoro 82M, Q8 | `af_heart` | 4.384 s | 14.05 s | 0.310 s | 4.594 s | 0.80 GiB |
| Piper 1.8.0, FP32 | `en_US-ljspeech-medium` | 0.183 s | 14.43 s | 0.720 s | 0.387 s | 0.34 GiB |
| Chatterbox Nano, FP32 | Official built-in voice | 3.646 s | 12.08 s | 5.195 s | 7.408 s | 4.12 GiB |

One first request was followed by three fresh warm requests per model, run serially on CPU with each runtime's default threading. Synthesis includes phonemization/inference and Chatterbox's default watermark. Downloads, Python/Node imports, model loading, file encoding and transcription checking are excluded from synthesis timings. No output-cache hits were measured. Peak process RAM includes runtime overhead and all loaded models.

Piper was fastest in this configuration. This small sample does not establish a general quality or speed ranking: the voices, runtimes, quantization and output durations differ. No human quality scores were assigned. A separate local `faster-whisper base.en` check retained “the second check fails” for all three. Piper's “add two lines” was recognized as “at two lines”; this may be a recognition error.

Generated local deliverables are under `runs/voice-comparison-2026-11-01/` (ignored by Git): `comparison.html` with audio players and a timing chart, `voice-comparison.mp4`, individual WAV/MP3/MP4 files, `results.json` with raw measurements/checksums, and `voice-demo-bundle.zip`. Preview MP3s are loudness-normalized at 64 kbps; 128 kbps MP3s and original WAVs are also available. The MP4s use labeled title cards with the same sample audio; they do not depict a browser replay.

The isolated runtimes and model downloads live under `.state/voice-benchmark/`. Production dependencies, persisted voice settings and provider defaults were not changed by this benchmark. Chatterbox needed the official source version with Nano support and the current official Perth implementation; the release packages did not work for Nano on this setup. The built-in voice and watermark were retained.

## Pinned sources

- [Kokoro JS](https://github.com/hexgrad/kokoro/blob/main/kokoro.js/README.md), package `1.2.1`; [ONNX weights](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/1939ad2a8e416c0acfeecc08a694d14ef25f2231), Q8.
- [Piper](https://github.com/OHF-Voice/piper1-gpl), package `1.8.0`; [voice model card](https://huggingface.co/rhasspy/piper-voices/blob/b4e358ffcb232591bf73a540e70f7de528e4174a/en/en_US/ljspeech/medium/MODEL_CARD), LJ Speech dataset marked public domain. Engine license is GPL-3.0.
- [Chatterbox source](https://github.com/resemble-ai/chatterbox/tree/5de7a54aa4e5e2baadb0182dde554908b48b85c2); [Nano weights](https://huggingface.co/ResembleAI/chatterbox-nano/tree/71ccd1d0081b430592cea481f4307e764e07bc64); [Perth watermark source](https://github.com/resemble-ai/Perth/tree/ff1c8ac55a976971245cdd53c18d6131ca00d993).
