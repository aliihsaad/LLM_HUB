import { Router } from 'express';
import { z } from 'zod';
import { customVoicePattern, designSpeechVoice, importSpeechVoice, listSpeechVoices, speechVoicePreview } from '../services/speech-voices.js';

// Mounted under the dashboard's existing /api authentication boundary.
export const voicesRouter = Router();
const keyId = z.number().int().positive();
const name = z.string().trim().min(1).max(100);
const importSchema = z.object({ key_id: keyId, voice_id: z.string().regex(customVoicePattern), display_name: name.optional() });
const designSchema = z.object({ key_id: keyId, display_name: name,
  prompt: z.string().trim().min(10).max(2000), language_code: z.string().max(20).optional(),
  gender: z.enum(['male', 'female', 'neutral']).optional() });

voicesRouter.get('/', (_req, res) => { res.json(listSpeechVoices()); });
voicesRouter.post('/import', async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: 'Provide an enabled Google key and a valid voice_ ID.' } }); return; }
  try { res.status(201).json({ voice: await importSpeechVoice(parsed.data.key_id, parsed.data.voice_id, parsed.data.display_name) }); }
  catch (err: any) { res.status(err.status === 409 ? 409 : 502).json({ error: { message: err.message } }); }
});
voicesRouter.post('/design', async (req, res) => {
  const parsed = designSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: 'Provide a name, voice description, and enabled Google key.' } }); return; }
  try { res.status(201).json(await designSpeechVoice(parsed.data)); }
  catch (err: any) { res.status(err.status === 409 ? 409 : 502).json({ error: { message: err.message } }); }
});
voicesRouter.get('/:id/preview', async (req, res) => {
  if (!customVoicePattern.test(String(req.params.id))) { res.sendStatus(400); return; }
  try { res.setHeader('Cache-Control', 'no-store'); res.type('audio/wav').send(await speechVoicePreview(String(req.params.id))); }
  catch (err: any) { res.status(err.status === 404 || err.status === 409 ? err.status : 502).json({ error: { message: err.message } }); }
});
