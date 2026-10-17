export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';
const API = 'https://generativelanguage.googleapis.com/v1beta';
export const isGemini38Tts = (model) => model === GEMINI_TTS_MODEL;
export async function googleVoiceRequest(apiKey, path, body, signal) {
    const response = await fetch(`${API}/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
        // Never copy a provider URL, credential, or biometric payload into logs.
        throw Object.assign(new Error(`Google voice request failed (HTTP ${response.status}).`), { status: response.status });
    }
    return response.json();
}
export function speech38Body(request, voice, stream = false) {
    return {
        model: GEMINI_TTS_MODEL,
        input: [{ type: 'user_input', content: [{
                        type: 'text', text: request.input,
                        ...(request.instructions?.trim() ? { annotations: [{
                                    type: 'speech_metadata', style: request.instructions.trim(),
                                }] } : {}),
                    }] }],
        response_format: { type: 'audio', mime_type: stream || request.response_format === 'pcm' ? 'audio/l16' : 'audio/wav' },
        generation_config: { speech_config: [{ voice }] },
        // Speech is stateless; do not retain transcripts as Interactions history.
        store: false,
        ...(stream ? { stream: true } : {}),
    };
}
export async function createSpeech38(apiKey, request, voice, signal) {
    const result = await googleVoiceRequest(apiKey, 'interactions', speech38Body(request, voice), signal);
    const parts = (result.steps ?? []).filter((step) => step.type === 'model_output')
        .flatMap((step) => step.content ?? []).filter((part) => part.type === 'audio');
    const audio = parts.at(-1) ?? result.output_audio;
    if (typeof audio?.data !== 'string' || !audio.data)
        throw new Error('Google speech generation returned no audio data.');
    const data = Buffer.from(audio.data, 'base64');
    const pcm = request.response_format === 'pcm';
    const mime = String(audio.mime_type ?? audio.mimeType ?? '').toLowerCase();
    if (pcm ? !/^audio\/(l16|pcm)(;|$)/.test(mime) : !/^audio\/(wav|wave|x-wav)(;|$)/.test(mime)) {
        throw new Error('Google returned an unexpected speech audio format.');
    }
    if (pcm ? data.length === 0 || data.length % 2 !== 0 : data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Google returned invalid speech audio.');
    }
    return { data, contentType: pcm ? 'audio/pcm;rate=24000' : 'audio/wav', format: pcm ? 'pcm' : 'wav' };
}
/** Decode SSE incrementally, including records split across network chunks. */
export async function* streamSpeech38(apiKey, request, voice, signal) {
    const response = await fetch(`${API}/interactions`, {
        method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(speech38Body(request, voice, true)),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok)
        throw Object.assign(new Error(`Google speech stream failed (HTTP ${response.status}).`), { status: response.status });
    if (!response.body)
        throw new Error('Google returned no speech stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '', received = false, completed = false;
    function decode(record) {
        const data = record.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]')
            return;
        const event = JSON.parse(data);
        const type = event.event_type ?? event.type ?? record.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim();
        if (event.error || ['error', 'interaction.failed', 'interaction.cancelled', 'interaction.requires_action'].includes(type))
            throw new Error('Google speech stream failed.');
        if (type === 'interaction.completed') {
            if (event.interaction?.status && event.interaction.status !== 'completed')
                throw new Error('Google speech stream did not complete.');
            completed = true;
        }
        if (type === 'step.delta' && event.delta?.type === 'audio' && typeof event.delta.data === 'string') {
            const bytes = Buffer.from(event.delta.data, 'base64');
            if (bytes.length) {
                received = true;
                return bytes;
            }
        }
    }
    try {
        for (;;) {
            const { value, done } = await reader.read();
            pending += decoder.decode(value, { stream: !done });
            if (pending.length > 16 * 1024 * 1024)
                throw new Error('Speech stream record exceeded the size limit.');
            let match;
            while ((match = /\r?\n\r?\n/.exec(pending))) {
                const record = pending.slice(0, match.index);
                pending = pending.slice(match.index + match[0].length);
                const audio = decode(record);
                if (audio)
                    yield audio;
            }
            if (done)
                break;
        }
        if (pending.trim()) {
            const audio = decode(pending);
            if (audio)
                yield audio;
        }
        if (!received)
            throw new Error('Google speech stream returned no audio.');
        if (!completed)
            throw new Error('Google speech stream ended before completion.');
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
//# sourceMappingURL=google-speech.js.map