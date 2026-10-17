import type { SpeechRequest, SpeechResult } from 'llmhub-shared/types.js';
export declare const GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
export declare const isGemini38Tts: (model: string) => model is "gemini-3.8-flash-tts";
export declare function googleVoiceRequest(apiKey: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any>;
export declare function speech38Body(request: SpeechRequest, voice: string, stream?: boolean): {
    stream?: boolean | undefined;
    model: string;
    input: {
        type: string;
        content: {
            annotations?: {
                type: string;
                style: string;
            }[] | undefined;
            type: string;
            text: string;
        }[];
    }[];
    response_format: {
        type: string;
        mime_type: string;
    };
    generation_config: {
        speech_config: {
            voice: string;
        }[];
    };
    store: boolean;
};
export declare function createSpeech38(apiKey: string, request: SpeechRequest, voice: string, signal?: AbortSignal): Promise<SpeechResult>;
/** Decode SSE incrementally, including records split across network chunks. */
export declare function streamSpeech38(apiKey: string, request: SpeechRequest, voice: string, signal: AbortSignal): AsyncGenerator<Uint8Array>;
//# sourceMappingURL=google-speech.d.ts.map