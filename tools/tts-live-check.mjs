// Bounded live acceptance in an isolated in-memory Hub. Production DB is read-only.
// Run on the Hub server: node tools/tts-live-check.mjs /opt/llm-hub
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { initEncryptionKey, decrypt, encrypt } from '../server/dist/lib/crypto.js';
import { initDb } from '../server/dist/db/index.js';
import { createApp } from '../server/dist/app.js';

const source = path.resolve(process.argv[2] ?? '');
const streamOnly = process.argv.includes('--stream-only');
if (!process.argv[2]) throw new Error('Pass the existing Hub directory explicitly.');
dotenv.config({ path: path.join(source, '.env'), quiet: true });
const production = new Database(path.join(source, 'server/data/freeapi.db'), { readonly: true, fileMustExist: true });
if (!process.env.ENCRYPTION_KEY && !production.prepare("SELECT 1 FROM settings WHERE key='encryption_key'").get()) throw new Error('Missing encryption configuration.');
initEncryptionKey(production);
const credential = production.prepare("SELECT id,encrypted_key,iv,auth_tag FROM api_keys WHERE platform='google' AND enabled=1 AND status!='invalid' ORDER BY id LIMIT 1").get();
if (!credential) throw new Error('No enabled Google credential.');
const apiKey = decrypt(credential.encrypted_key, credential.iv, credential.auth_tag);
production.close();
const log = console.log; console.log = () => {};
const db = await initDb(':memory:'); console.log = log;
const encrypted = encrypt(apiKey);
db.prepare("INSERT INTO api_keys (id,platform,label,encrypted_key,iv,auth_tag,enabled,status) VALUES (?,'google','Live acceptance',?,?,?,1,'valid')")
  .run(credential.id, encrypted.encrypted, encrypted.iv, encrypted.authTag);
const output = path.resolve('output/tts-check'); fs.mkdirSync(output, { recursive: true });
const evidencePath = path.join(output, 'evidence.json');
let evidence = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : {};
const server = createApp().listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function post(route, body) {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(130_000) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(`${route}: HTTP ${response.status}: ${error.error?.message ?? 'request failed'}`);
  }
  return response;
}
try {
  const start = Date.now();
  const voiceResponse = evidence.voiceId
    ? await post('/api/voices/import', { key_id: credential.id, voice_id: evidence.voiceId, display_name: 'Hub TTS test — calm' })
    : await post('/api/voices/design', { key_id: credential.id, display_name: 'Hub TTS test — calm', prompt: 'A calm, clear adult voice with a warm mid-range tone and a neutral English accent. Natural, friendly conversation with precise pronunciation.' });
  const { voice } = await voiceResponse.json();
  evidence = { ...evidence, voiceId: voice.id, credentialRef: credential.id, voiceSetupMs: Date.now() - start, samples: streamOnly ? evidence.samples ?? [] : [] };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  const preview = await fetch(base + `/api/voices/${voice.id}/preview`);
  if (!preview.ok) throw new Error(`Preview failed: HTTP ${preview.status}`);
  evidence.previewBytes = (await preview.arrayBuffer()).byteLength;
  const sentences = streamOnly ? [] : ['Hello. This is the first custom voice test through the Hub.', 'The same voice can read a different sentence with a warmer, more conversational tone.'];
  for (const [index, text] of sentences.entries()) {
    const began = Date.now();
    const response = await post('/v1/audio/speech', { model: 'gemini-3.8-flash-tts', voice: voice.id, input: text, instructions: 'Warm and conversational', response_format: 'wav' });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid live WAV.');
    fs.writeFileSync(path.join(output, `custom-${index + 1}.wav`), bytes);
    evidence.samples.push({ file: `custom-${index + 1}.wav`, bytes: bytes.length, elapsedMs: Date.now() - began, route: response.headers.get('x-routed-via') });
  }
  const began = Date.now(); let firstAudioMs, chunks = 0; const audio = [];
  const response = await post('/v1/audio/speech', { model: 'gemini-3.8-flash-tts', voice: voice.id, input: 'This is the streaming test. The same custom voice is delivered in small pieces.', stream: true, response_format: 'pcm' });
  for await (const chunk of response.body) { firstAudioMs ??= Date.now() - began; chunks++; audio.push(chunk); }
  const pcm = Buffer.concat(audio); if (!pcm.length || pcm.length % 2) throw new Error('Invalid live PCM.');
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(path.join(output, 'custom-stream.wav'), Buffer.concat([header, pcm]));
  evidence.stream = { chunks, bytes: pcm.length, firstAudioMs, elapsedMs: Date.now() - began };
  evidence.completedAt = new Date().toISOString();
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); }
