import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';
import { synthesizeSpeech, speechUsage, normalizeSpeech } from '../src/speech.ts';
import { defaultVoiceOptions } from '../src/demo-contract.ts';

test('Realtime transport follows session/item/response events, assembles PCM and records measured usage', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => server.once('listening', r));
  const received: any[] = [];
  const script = 'Recorded step 1 failed.';
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'session.created', session: { id: 'fixture' } }));
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      received.push(event);
      if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
      if (event.type === 'response.create') {
        socket.send(
          JSON.stringify({
            type: 'response.output_audio.delta',
            delta: Buffer.from([1, 2]).toString('base64'),
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.output_audio.delta',
            delta: Buffer.from([3, 4]).toString('base64'),
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.output_audio_transcript.done',
            transcript: script,
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.done',
            response: {
              id: 'response-fixture',
              status: 'completed',
              usage: {
                input_token_details: {
                  text_tokens: 100,
                  cached_tokens_details: { text_tokens: 20 },
                },
                output_token_details: { audio_tokens: 200, text_tokens: 15 },
              },
            },
          }),
        );
      }
    });
  });
  try {
    const result = await synthesizeSpeech(script, defaultVoiceOptions, 'test-key', AbortSignal.timeout(5000), (url, options) => {
      assert.equal(url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      return new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}`);
    });
    assert.deepEqual(result.pcm, Buffer.from([1, 2, 3, 4]));
    assert.equal(result.transcript, script);
    assert.equal(result.usage.outputAudioTokens, 200);
    assert.equal(result.usage.billedCostUsd, null);
    assert.ok(Math.abs(result.usage.estimatedApiCostUsd! - (80 * 0.6 + 20 * 0.06 + 200 * 20 + 15 * 2.4) / 1e6) < 1e-12);
    assert.deepEqual(
      received.map((e) => e.type),
      ['session.update', 'conversation.item.create', 'response.create'],
    );
    assert.equal(received[0].session.audio.input.turn_detection, null);
    assert.deepEqual(received[0].session.audio.output.format, {
      type: 'audio/pcm',
      rate: 24000,
    });
    assert.equal(received[1].item.content[0].text, script);
    assert.deepEqual(received[2].response.output_modalities, ['audio']);
    assert.equal(normalizeSpeech('Recorded step one failed!'), normalizeSpeech(script));
    assert.equal(speechUsage({ usage: {} }).estimatedApiCostUsd, null);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('Realtime abort sends cancellation and errors never echo credentials or raw provider responses', async () => {
  for (const mode of ['abort', 'error'] as const) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', r));
    const controller = new AbortController();
    let cancelled = false;
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'session.created' }));
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
        if (event.type === 'response.create') {
          if (mode === 'abort') controller.abort();
          else
            socket.send(
              JSON.stringify({
                type: 'error',
                error: { message: 'secret-test-key-do-not-echo' },
              }),
            );
        }
        if (event.type === 'response.cancel') cancelled = true;
      });
    });
    try {
      await assert.rejects(
        synthesizeSpeech(
          'A failed step.',
          defaultVoiceOptions,
          'secret-test-key-do-not-echo',
          controller.signal,
          () => new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}`),
        ),
        (e: any) => {
          assert.doesNotMatch(e.message, /secret-test-key/);
          assert.equal(e.code, mode === 'abort' ? 'CANCELLED' : 'SPEECH_REJECTED');
          return true;
        },
      );
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(cancelled, true);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});
