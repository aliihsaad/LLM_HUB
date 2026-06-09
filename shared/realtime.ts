export interface RealtimeAudioChunk {
  data: string;
  mimeType: string;
}

export interface RealtimeServerMessageSummary {
  labels: string[];
  text: string;
  inputTranscription?: string;
  outputTranscription?: string;
  audioChunks: RealtimeAudioChunk[];
  interrupted: boolean;
  turnComplete: boolean;
  setupComplete: boolean;
  usage?: Record<string, unknown>;
  raw: unknown;
}

export type RealtimeAudioWireFormat = 'audio' | 'mediaChunks';

export interface RealtimeSetupOptions {
  model: string;
  responseModalities: ('AUDIO' | 'TEXT')[];
  instructions?: string;
  inputAudioTranscription?: boolean;
  outputAudioTranscription?: boolean;
  temperature?: number;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function createRealtimeTextInputMessage(text: string) {
  return {
    realtimeInput: {
      text,
    },
  };
}

export function createRealtimeAudioInputMessage(
  data: string,
  sampleRate = 16000,
  wireFormat: RealtimeAudioWireFormat = 'audio',
) {
  const audio = {
    data,
    mimeType: `audio/pcm;rate=${sampleRate}`,
  };

  return {
    realtimeInput: wireFormat === 'mediaChunks'
      ? {
        mediaChunks: [audio],
      }
      : {
        audio,
      },
  };
}

export function createRealtimeSetupMessage(options: RealtimeSetupOptions) {
  const setup: Record<string, unknown> = {
    model: options.model.startsWith('models/') ? options.model : `models/${options.model}`,
    generationConfig: pruneUndefined({
      responseModalities: options.responseModalities,
      temperature: options.temperature,
    }),
  };

  if (options.instructions) {
    setup.systemInstruction = {
      parts: [{ text: options.instructions }],
    };
  }

  if (options.inputAudioTranscription) setup.inputAudioTranscription = {};
  if (options.outputAudioTranscription) setup.outputAudioTranscription = {};

  return { setup };
}

export function createRealtimeClientContentMessage(text: string) {
  return {
    clientContent: {
      turns: [{
        role: 'user',
        parts: [{ text }],
      }],
      turnComplete: true,
    },
  };
}

export function createRealtimeMediaChunksAudioInputMessage(data: string, sampleRate = 16000) {
  return {
    realtimeInput: {
      mediaChunks: [{
        data,
        mimeType: `audio/pcm;rate=${sampleRate}`,
      }],
    },
  };
}

export function createRealtimeAudioStreamEndMessage() {
  return {
    realtimeInput: {
      audioStreamEnd: true,
    },
  };
}

export function parsePcmMimeTypeSampleRate(mimeType: string | undefined, fallback = 24000) {
  const match = mimeType?.match(/(?:^|[;\s])rate=(\d+)/i);
  if (!match) return fallback;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function float32ToPcm16Base64(
  samples: Float32Array,
  inputSampleRate: number,
  outputSampleRate = 16000,
) {
  const normalizedOutputRate = normalizeSampleRate(outputSampleRate, 16000);
  const resampled = resampleFloat32(samples, normalizeSampleRate(inputSampleRate, normalizedOutputRate), normalizedOutputRate);
  const bytes = new Uint8Array(resampled.length * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < resampled.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, resampled[index] ?? 0));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, Math.round(int16), true);
  }

  return bytesToBase64(bytes);
}

export function base64ToPcm16Float32(value: string) {
  const bytes = base64ToBytes(value);
  const length = Math.floor(bytes.length / 2);
  const samples = new Float32Array(length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let index = 0; index < length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }

  return samples;
}

export function summarizeRealtimeServerMessage(message: unknown): RealtimeServerMessageSummary {
  const root = asRecord(message);
  const serverContent = asRecord(root.serverContent ?? root.server_content);
  const labels: string[] = [];
  const audioChunks: RealtimeAudioChunk[] = [];
  const textParts: string[] = [];

  const setupComplete = Boolean(root.setupComplete ?? root.setup_complete);
  const interrupted = Boolean(serverContent.interrupted);
  const turnComplete = Boolean(serverContent.turnComplete ?? serverContent.turn_complete);
  const inputTranscription = readNestedText(serverContent.inputTranscription ?? serverContent.input_transcription);
  const outputTranscription = readNestedText(serverContent.outputTranscription ?? serverContent.output_transcription);
  const usage = asRecord(root.usageMetadata ?? root.usage_metadata);
  const modelTurn = asRecord(serverContent.modelTurn ?? serverContent.model_turn);
  const parts = Array.isArray(modelTurn.parts) ? modelTurn.parts : [];

  for (const rawPart of parts) {
    const part = asRecord(rawPart);
    if (typeof part.text === 'string' && part.text.length > 0) {
      textParts.push(part.text);
    }

    const inlineData = asRecord(part.inlineData ?? part.inline_data);
    const data = inlineData.data;
    if (typeof data === 'string' && data.length > 0) {
      audioChunks.push({
        data,
        mimeType: typeof inlineData.mimeType === 'string'
          ? inlineData.mimeType
          : typeof inlineData.mime_type === 'string'
            ? inlineData.mime_type
            : 'audio/pcm;rate=24000',
      });
    }
  }

  if (setupComplete) labels.push('setup complete');
  if (textParts.length > 0) labels.push('text');
  if (audioChunks.length > 0) labels.push('audio');
  if (inputTranscription) labels.push('input transcript');
  if (outputTranscription) labels.push('output transcript');
  if (interrupted) labels.push('interrupted');
  if (turnComplete) labels.push('turn complete');
  if (Object.keys(usage).length > 0) labels.push('usage');

  return {
    labels,
    text: textParts.join('\n'),
    inputTranscription,
    outputTranscription,
    audioChunks,
    interrupted,
    turnComplete,
    setupComplete,
    usage: Object.keys(usage).length > 0 ? usage : undefined,
    raw: message,
  };
}

function normalizeSampleRate(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resampleFloat32(samples: Float32Array, inputSampleRate: number, outputSampleRate: number) {
  if (samples.length === 0 || inputSampleRate === outputSampleRate) return samples;

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      sum += samples[sourceIndex] ?? 0;
    }
    output[index] = sum / Math.max(1, end - start);
  }

  return output;
}

function bytesToBase64(bytes: Uint8Array) {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;

    output += BASE64_ALPHABET[(combined >> 18) & 63];
    output += BASE64_ALPHABET[(combined >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(combined >> 6) & 63] : '=';
    output += index + 2 < bytes.length ? BASE64_ALPHABET[combined & 63] : '=';
  }
  return output;
}

function base64ToBytes(value: string) {
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes: number[] = [];

  for (let index = 0; index < clean.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(clean[index] ?? 'A');
    const second = BASE64_ALPHABET.indexOf(clean[index + 1] ?? 'A');
    const thirdChar = clean[index + 2] ?? '=';
    const fourthChar = clean[index + 3] ?? '=';
    const third = thirdChar === '=' ? 0 : BASE64_ALPHABET.indexOf(thirdChar);
    const fourth = fourthChar === '=' ? 0 : BASE64_ALPHABET.indexOf(fourthChar);
    const combined = (first << 18) | (second << 12) | (third << 6) | fourth;

    bytes.push((combined >> 16) & 255);
    if (thirdChar !== '=') bytes.push((combined >> 8) & 255);
    if (fourthChar !== '=') bytes.push(combined & 255);
  }

  return new Uint8Array(bytes);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function readNestedText(value: unknown) {
  const record = asRecord(value);
  return typeof record.text === 'string' && record.text.length > 0 ? record.text : undefined;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
