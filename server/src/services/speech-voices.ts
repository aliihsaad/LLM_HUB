import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { GEMINI_TTS_MODEL, googleVoiceRequest } from '../providers/google-speech.js';

export const customVoicePattern = /^voice_[A-Za-z0-9_-]{1,200}$/;
export interface SavedVoice { id: string; display_name: string; key_id: number | null; voice_type: string }

export function voiceCredential(keyId: number): string {
  const row = getDb().prepare(`SELECT encrypted_key,iv,auth_tag FROM api_keys
    WHERE id=? AND platform='google' AND enabled=1 AND status!='invalid'`).get(keyId) as any;
  if (!row) throw Object.assign(new Error('The voice’s Google credential is unavailable. Choose an enabled Google key.'), { status: 409 });
  return decrypt(row.encrypted_key, row.iv, row.auth_tag);
}

export function findSpeechVoice(id: string): SavedVoice | undefined {
  return getDb().prepare('SELECT id,display_name,key_id,voice_type FROM speech_voices WHERE id=?').get(id) as SavedVoice | undefined;
}

export function listSpeechVoices() {
  return getDb().prepare(`SELECT v.*, k.label AS key_label,
    CASE WHEN k.enabled=1 AND k.status!='invalid' THEN 1 ELSE 0 END AS available
    FROM speech_voices v LEFT JOIN api_keys k ON k.id=v.key_id ORDER BY v.created_at DESC`).all();
}

function saveVoice(data: any, keyId: number, name?: string): SavedVoice {
  if (!customVoicePattern.test(data.id ?? '')) throw new Error('Google returned an invalid custom voice ID.');
  const existing = findSpeechVoice(data.id);
  // Import can rebind an inaccessible voice only after GET succeeded with the new key.
  getDb().prepare(`INSERT INTO speech_voices (id,display_name,key_id,voice_type) VALUES (?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,key_id=excluded.key_id`).run(
    data.id, name ?? data.display_name ?? existing?.display_name ?? 'Custom voice', keyId, data.type ?? 'prompted',
  );
  return findSpeechVoice(data.id)!;
}

export async function importSpeechVoice(keyId: number, id: string, name?: string) {
  const data = await googleVoiceRequest(voiceCredential(keyId), `voices/${encodeURIComponent(id)}`);
  if (data.id !== id) throw new Error('Google returned a different voice ID.');
  return saveVoice(data, keyId, name);
}

export async function designSpeechVoice(input: { key_id: number; display_name: string; prompt: string; language_code?: string; gender?: string }) {
  const data = await googleVoiceRequest(voiceCredential(input.key_id), 'voices', {
    store: true,
    voice: { model: GEMINI_TTS_MODEL, type: 'prompted', display_name: input.display_name,
      ...(input.language_code ? { language_code: input.language_code } : {}),
      ...(input.gender ? { gender: input.gender } : {}), prompted: { input: input.prompt } },
  });
  const voice = saveVoice(data, input.key_id, input.display_name);
  return { voice, preview_available: Boolean(data.sample_audio?.data) };
}

export async function speechVoicePreview(id: string) {
  const voice = findSpeechVoice(id);
  if (!voice?.key_id) throw Object.assign(new Error('Custom voice is not registered with an available credential.'), { status: 404 });
  const data = await googleVoiceRequest(voiceCredential(voice.key_id), `voices/${encodeURIComponent(id)}`);
  const sample = data.sample_audio;
  if (!sample?.data || sample.mime_type !== 'audio/wav') throw Object.assign(new Error('This voice has no WAV preview.'), { status: 404 });
  const bytes = Buffer.from(sample.data, 'base64');
  if (bytes.length > 10 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid voice preview.');
  return bytes;
}
