export declare const customVoicePattern: RegExp;
export interface SavedVoice {
    id: string;
    display_name: string;
    key_id: number | null;
    voice_type: string;
}
export declare function voiceCredential(keyId: number): string;
export declare function findSpeechVoice(id: string): SavedVoice | undefined;
export declare function listSpeechVoices(): unknown[];
export declare function importSpeechVoice(keyId: number, id: string, name?: string): Promise<SavedVoice>;
export declare function designSpeechVoice(input: {
    key_id: number;
    display_name: string;
    prompt: string;
    language_code?: string;
    gender?: string;
}): Promise<{
    voice: SavedVoice;
    preview_available: boolean;
}>;
export declare function speechVoicePreview(id: string): Promise<Buffer<ArrayBuffer>>;
//# sourceMappingURL=speech-voices.d.ts.map