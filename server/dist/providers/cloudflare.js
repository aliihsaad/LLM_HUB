import { BaseProvider, readProviderErrorText } from './base.js';
/**
 * Cloudflare Workers AI provider.
 * API key format expected: "account_id:api_token"
 * The account_id is extracted from the key to build the URL.
 */
export class CloudflareProvider extends BaseProvider {
    platform = 'cloudflare';
    name = 'Cloudflare Workers AI';
    // 7 of its 9 enabled catalog rows are Frontier/Large models on shared
    // Workers AI capacity, where cold starts are common.
    defaultTimeoutMs = 60000;
    parseKey(apiKey) {
        const sep = apiKey.indexOf(':');
        if (sep === -1)
            throw new Error('Cloudflare key must be in format "account_id:api_token"');
        return { accountId: apiKey.slice(0, sep), token: apiKey.slice(sep + 1) };
    }
    // Cloudflare's OpenAI-compat endpoint rejects `content: null` on assistant
    // messages that carry tool_calls, even though the OpenAI spec allows it.
    normalizeMessages(messages) {
        return messages.map(m => m.content === null ? { ...m, content: '' } : m);
    }
    async chatCompletion(apiKey, messages, modelId, options) {
        const { accountId, token } = this.parseKey(apiKey);
        const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
        const res = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: modelId,
                messages: this.normalizeMessages(messages),
                temperature: options?.temperature,
                max_tokens: options?.max_tokens,
                top_p: options?.top_p,
                tools: options?.tools,
                tool_choice: options?.tool_choice,
                parallel_tool_calls: options?.parallel_tool_calls,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Cloudflare API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
        }
        const data = await res.json();
        data._routed_via = { platform: 'cloudflare', model: modelId };
        return data;
    }
    async *streamChatCompletion(apiKey, messages, modelId, options) {
        const { accountId, token } = this.parseKey(apiKey);
        const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
        const res = await this.fetchWithTimeout(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: modelId,
                messages: this.normalizeMessages(messages),
                temperature: options?.temperature,
                max_tokens: options?.max_tokens,
                top_p: options?.top_p,
                tools: options?.tools,
                tool_choice: options?.tool_choice,
                parallel_tool_calls: options?.parallel_tool_calls,
                stream: true,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`Cloudflare API error ${res.status}: ${readProviderErrorText(err, res.statusText)}`);
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
        // counting toward auto-disable. Only confirmed bad/inactive tokens disable.
        const { token } = this.parseKey(apiKey);
        const res = await this.fetchWithTimeout('https://api.cloudflare.com/client/v4/user/tokens/verify', { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } }, 10000);
        if (res.status === 401 || res.status === 403)
            return false;
        if (!res.ok)
            return true; // unexpected non-2xx that isn't auth — don't disable
        const data = await res.json();
        return data.success === true && data.result?.status === 'active';
    }
}
//# sourceMappingURL=cloudflare.js.map