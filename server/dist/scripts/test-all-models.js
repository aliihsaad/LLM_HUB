/**
 * Probe every enabled model with a minimal request to find broken model IDs.
 * Usage: npx tsx src/scripts/test-all-models.ts
 */
import { initDb, getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { getProvider } from '../providers/index.js';
initDb();
const db = getDb();
const models = db.prepare(`
  SELECT m.id, m.platform, m.model_id, m.display_name
    FROM models m
   WHERE m.enabled = 1
     AND EXISTS (SELECT 1 FROM api_keys k WHERE k.platform = m.platform AND k.enabled = 1)
   ORDER BY m.intelligence_rank, m.platform
`).all();
const keyStmt = db.prepare(`
  SELECT encrypted_key, iv, auth_tag FROM api_keys
   WHERE platform = ? AND enabled = 1 ORDER BY id LIMIT 1
`);
const results = [];
function previewContent(content) {
    if (typeof content === 'string')
        return content.slice(0, 40);
    if (Array.isArray(content)) {
        return content
            .map(part => (part && typeof part === 'object' && 'text' in part ? String(part.text ?? '') : ''))
            .join('')
            .slice(0, 40);
    }
    return '';
}
for (const row of models) {
    const keyRow = keyStmt.get(row.platform);
    if (!keyRow) {
        results.push({ row, ok: false, ms: 0, error: 'no key' });
        continue;
    }
    const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    const provider = getProvider(row.platform);
    if (!provider) {
        results.push({ row, ok: false, ms: 0, error: 'no provider' });
        continue;
    }
    const start = Date.now();
    try {
        const res = await provider.chatCompletion(apiKey, [{ role: 'user', content: 'hi' }], row.model_id, { max_tokens: 5 });
        const reply = previewContent(res.choices?.[0]?.message?.content);
        results.push({ row, ok: true, ms: Date.now() - start, reply });
    }
    catch (err) {
        results.push({ row, ok: false, ms: Date.now() - start, error: String(err?.message ?? err).slice(0, 200) });
    }
}
console.log('\n=== Results ===\n');
const pad = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
for (const r of results) {
    const status = r.ok ? '✓' : '✗';
    console.log(`${status} ${pad(r.row.platform, 12)} ${pad(r.row.model_id, 52)} ${String(r.ms).padStart(5)}ms  ${r.ok ? `"${r.reply}"` : r.error}`);
}
const okCount = results.filter(r => r.ok).length;
console.log(`\n${okCount}/${results.length} models working\n`);
process.exit(0);
//# sourceMappingURL=test-all-models.js.map