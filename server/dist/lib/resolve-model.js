import { isFreeOnlyMode } from './app-settings.js';
/**
 * Resolve an explicitly requested model id to a routable catalog row.
 * Order of precedence: unknown → capability → disabled → paid (so error
 * messages never leak paid-model existence distinctions before validity).
 */
export function resolveRoutableModel(db, modelId, requiredCapability) {
    // The same model_id can exist on several providers (e.g. an aggregator's
    // auto-discovered `gemma-4-31b-it` alongside Google's own). A bare `.get()`
    // returned whichever row had the lowest id, so a disabled/paid duplicate
    // could shadow a perfectly routable one. Rank the candidates instead:
    // enabled first, then providers that actually have a usable key, then free.
    const row = db.prepare(`
    SELECT m.id, m.enabled AS model_enabled, m.is_free,
           COUNT(ak.id) AS key_count
    FROM models m
    LEFT JOIN api_keys ak
      ON ak.platform = m.platform
      AND ak.enabled = 1
      AND ak.status != 'invalid'
    WHERE m.model_id = ?
    GROUP BY m.id
    ORDER BY (m.enabled = 1) DESC,
             (COUNT(ak.id) > 0) DESC,
             (m.is_free = 1) DESC,
             m.id ASC
    LIMIT 1
  `).get(modelId);
    if (!row)
        return { kind: 'not_found' };
    if (requiredCapability) {
        const cap = db.prepare(`
      SELECT enabled FROM model_capabilities
      WHERE model_db_id = ? AND capability = ?
    `).get(row.id, requiredCapability);
        if (!cap?.enabled)
            return { kind: 'capability_missing', capability: requiredCapability };
    }
    if (row.model_enabled !== 1)
        return { kind: 'disabled' };
    if (row.is_free !== 1 && isFreeOnlyMode(db))
        return { kind: 'paid_blocked' };
    return { kind: 'ok', id: row.id };
}
// DB capability keys don't always read naturally in prose (e.g. the catalog
// stores 'image_generation', 'image_edit', 'realtime_audio'). Map the ones
// that differ from their existing human-readable error wording; anything
// absent from this table falls back to the raw capability string unchanged.
const CAPABILITY_LABELS = {
    image_generation: 'image generation',
    image_edit: 'image edits',
    image_variation: 'image variations',
    realtime_audio: 'realtime audio',
};
/** Send the standard error payload for a non-ok resolution. */
export function sendResolutionError(res, modelId, r) {
    if (r.kind === 'paid_blocked') {
        res.status(403).json({
            error: {
                message: `Model '${modelId}' is a paid model and free-tier-only mode is on. ` +
                    `Disable it in Settings → Free-tier only, or pick a free model from /v1/models.`,
                type: 'invalid_request_error',
                code: 'paid_model_blocked',
            },
        });
        return;
    }
    const reason = r.kind === 'not_found' ? 'is not in the catalog'
        : r.kind === 'disabled' ? 'is disabled'
            : `does not support ${r.kind === 'capability_missing' ? (CAPABILITY_LABELS[r.capability] ?? r.capability) : ''}`;
    res.status(400).json({
        error: {
            message: `Model '${modelId}' ${reason}. Omit the 'model' field to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
        },
    });
}
//# sourceMappingURL=resolve-model.js.map