import { describe, expect, it } from 'vitest';
import {
  createRealtimeAudioInputMessage,
  createRealtimeAudioStreamEndMessage,
  createRealtimeClientContentMessage,
  createRealtimeSetupMessage,
  createRealtimeTextInputMessage,
  float32ToPcm16Base64,
  parsePcmMimeTypeSampleRate,
  summarizeRealtimeServerMessage,
} from 'llmhub-shared/realtime.js';

describe('realtime protocol helpers', () => {
  it('builds Gemini Live realtime input messages', () => {
    expect(createRealtimeTextInputMessage('hello')).toEqual({
      realtimeInput: { text: 'hello' },
    });
    expect(createRealtimeAudioInputMessage('AQID', 16000)).toEqual({
      realtimeInput: {
        audio: {
          data: 'AQID',
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    });
    expect(createRealtimeAudioInputMessage('AQID', 16000, 'mediaChunks')).toEqual({
      realtimeInput: {
        mediaChunks: [{
          data: 'AQID',
          mimeType: 'audio/pcm;rate=16000',
        }],
      },
    });
    expect(createRealtimeAudioStreamEndMessage()).toEqual({
      realtimeInput: { audioStreamEnd: true },
    });
  });

  it('builds setup and client content messages for raw Live WebSockets', () => {
    expect(createRealtimeSetupMessage({
      model: 'gemini-live-test',
      responseModalities: ['AUDIO'],
      instructions: 'Speak briefly.',
      inputAudioTranscription: true,
      outputAudioTranscription: true,
      temperature: 0.7,
    })).toEqual({
      setup: {
        model: 'models/gemini-live-test',
        generationConfig: {
          responseModalities: ['AUDIO'],
          temperature: 0.7,
        },
        systemInstruction: {
          parts: [{ text: 'Speak briefly.' }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    });

    expect(createRealtimeClientContentMessage('hello')).toEqual({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: 'hello' }] }],
        turnComplete: true,
      },
    });
  });

  it('converts float audio samples to little-endian PCM16 base64', () => {
    expect(float32ToPcm16Base64(new Float32Array([-1, 0, 1]), 16000, 16000)).toBe('AIAAAP9/');
  });

  it('summarizes server messages with audio, transcripts, text, and interruptions', () => {
    const summary = summarizeRealtimeServerMessage({
      serverContent: {
        interrupted: true,
        turnComplete: true,
        inputTranscription: { text: 'user words' },
        outputTranscription: { text: 'model words' },
        modelTurn: {
          parts: [
            { text: 'hello' },
            { inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } },
          ],
        },
      },
      usageMetadata: { totalTokenCount: 12 },
    });

    expect(summary.labels).toEqual(expect.arrayContaining([
      'text',
      'audio',
      'input transcript',
      'output transcript',
      'interrupted',
      'turn complete',
      'usage',
    ]));
    expect(summary.text).toContain('hello');
    expect(summary.inputTranscription).toBe('user words');
    expect(summary.outputTranscription).toBe('model words');
    expect(summary.audioChunks).toEqual([{ data: 'AAAA', mimeType: 'audio/pcm;rate=24000' }]);
  });

  it('parses PCM sample rates with safe fallback', () => {
    expect(parsePcmMimeTypeSampleRate('audio/pcm;rate=16000')).toBe(16000);
    expect(parsePcmMimeTypeSampleRate('audio/L16;codec=pcm;rate=24000')).toBe(24000);
    expect(parsePcmMimeTypeSampleRate('audio/pcm')).toBe(24000);
  });
});
