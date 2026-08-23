import { BaseProvider, readProviderErrorText } from './base.js';
const API_BASE = 'https://api.cohere.ai/compatibility/v1';
export class CohereProvider extends BaseProvider {
    platform = 'cohere';
    name = 'Cohere';
    // Both enabled rows are Large command models on the free trial tier.
    defaultTimeoutMs = 60000;
    async chatCompletion(apiKey, messages, modelId, options) {
        const body = {
            model: modelId,
            messages,
            temperature: options?.temperature,
            max_tokens: options?.max_tokens,
            top_p: options?.top_p,
            tools: options?.tools,
            tool_choice: options?.tool_choice,
        };
        const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Cohere API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const data = await res.json();
        data._routed_via = { platform: 'cohere', model: modelId };
        return data;
    }
    async *streamChatCompletion(apiKey, messages, modelId, options) {
        const body = {
            model: modelId,
            messages,
            temperature: options?.temperature,
            max_tokens: options?.max_tokens,
            top_p: options?.top_p,
            tools: options?.tools,
            tool_choice: options?.tool_choice,
            stream: true,
        };
        const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Cohere API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const reader = res.body?.getReader();
        if (!reader)
            throw new Error('No response body');
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: '))
                    continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]')
                    return;
                try {
                    yield JSON.parse(data);
                }
                catch {
                    // Skip malformed chunks
                }
            }
        }
    }
    async validateKey(apiKey) {
        // Transport errors propagate — health.ts marks status='error' without
        // counting toward auto-disable. Only confirmed 401/403 disables a key.
        const res = await this.fetchWithTimeout(`${API_BASE}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
        }, 10000);
        return res.status !== 401 && res.status !== 403;
    }
}
//# sourceMappingURL=cohere.js.map