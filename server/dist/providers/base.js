export class BaseProvider {
    async createEmbedding(_apiKey, _input, _modelId, _options) {
        throw new Error(`${this.name} does not support embeddings`);
    }
    async createImage(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support image generation`);
    }
    async editImage(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support image edits`);
    }
    async createImageVariation(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support image variations`);
    }
    async createSpeech(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support speech`);
    }
    async transcribeAudio(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support transcription`);
    }
    async translateAudio(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support translation`);
    }
    async createRealtimeSession(_apiKey, _request, _modelId) {
        throw new Error(`${this.name} does not support realtime sessions`);
    }
    async fetchWithTimeout(url, init, timeoutMs = 15000) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...init, signal: controller.signal });
        }
        finally {
            clearTimeout(timeout);
        }
    }
    makeId() {
        return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
}
//# sourceMappingURL=base.js.map