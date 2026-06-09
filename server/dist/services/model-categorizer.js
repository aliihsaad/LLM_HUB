import { getDb } from '../db/index.js';
/**
 * Heuristic-based categorization of models.
 * Uses model_id, display_name, and metadata to assign the best category.
 */
export function categorizeModel(modelId, displayName, intelligenceRank, speedRank, sizeLabel) {
    const id = modelId.toLowerCase();
    const name = displayName.toLowerCase();
    const specializations = [];
    // Code models
    if (/code|coder|codestral|devstral|mistral-medium/.test(id + name)) {
        specializations.push('programming', 'debugging', 'code-review');
        return { category: 'best_for_code', specializations };
    }
    // Vision models
    if (/vision|vl|glm-4\.\dv|gemini.*pro.*vision/.test(id + name)) {
        specializations.push('image-understanding', 'ocr', 'visual-qa');
        return { category: 'best_for_vision', specializations };
    }
    // Reasoning models
    if (/reasoning|r1|deepseek|o1|o3|thinking|qwq/.test(id + name)) {
        specializations.push('math', 'logic', 'step-by-step', 'problem-solving');
        return { category: 'best_for_reasoning', specializations };
    }
    // Fast models
    if (/flash|instant|nano|lite|small|8b|1\.2b|9b/.test(id + name) ||
        (speedRank <= 3 && !/frontier|large/.test(sizeLabel.toLowerCase()))) {
        specializations.push('low-latency', 'high-throughput', 'quick-answers');
        return { category: 'fast', specializations };
    }
    // Precise/Frontier models
    if ((intelligenceRank <= 5 || /pro|frontier|maverick|k2|gpt-5/.test(id + name)) &&
        !/flash|lite|nano/.test(id + name)) {
        specializations.push('accuracy', 'complex-tasks', 'analysis', 'research');
        return { category: 'precise', specializations };
    }
    // Creative models
    if (/story|write|poem|creative|gpt-oss/.test(id + name)) {
        specializations.push('writing', 'storytelling', 'brainstorming');
        return { category: 'creative', specializations };
    }
    // Default
    specializations.push('general-purpose', 'conversation');
    return { category: 'general', specializations };
}
/**
 * Auto-categorize all models in the database.
 * Call this after seeding or when new models are discovered.
 */
export function autoCategorizeAllModels() {
    const db = getDb();
    const models = db.prepare(`
    SELECT id, platform, model_id, display_name, intelligence_rank, speed_rank, size_label
    FROM models
  `).all();
    const update = db.prepare(`
    UPDATE models
    SET category = ?, specializations = ?
    WHERE id = ?
  `);
    const tx = db.transaction(() => {
        for (const m of models) {
            const { category, specializations } = categorizeModel(m.model_id, m.display_name, m.intelligence_rank, m.speed_rank, m.size_label);
            update.run(category, specializations.join(','), m.id);
        }
    });
    tx();
    console.log(`[Categorizer] Auto-categorized ${models.length} models`);
}
/**
 * Get models by category, optionally filtered by availability.
 */
export function getModelsByCategory(category, onlyAvailable = true) {
    const db = getDb();
    let sql = `
    SELECT 
      m.id,
      m.platform,
      m.model_id,
      m.display_name,
      m.category,
      m.specializations,
      m.intelligence_rank,
      m.speed_rank,
      m.size_label,
      COALESCE(a.status, 'unknown') AS availability_status
    FROM models m
    LEFT JOIN model_availability a ON a.model_db_id = m.id
    WHERE m.enabled = 1
  `;
    if (category) {
        sql += ` AND m.category = ?`;
    }
    if (onlyAvailable) {
        sql += ` AND (a.status IS NULL OR a.status IN ('free', 'rate_limited', 'unknown'))`;
    }
    sql += ` ORDER BY m.intelligence_rank ASC, m.speed_rank ASC`;
    const rows = category
        ? db.prepare(sql).all(category)
        : db.prepare(sql).all();
    return rows.map(r => ({
        id: r.id,
        platform: r.platform,
        modelId: r.model_id,
        displayName: r.display_name,
        category: r.category,
        specializations: r.specializations ? r.specializations.split(',') : [],
        intelligenceRank: r.intelligence_rank,
        speedRank: r.speed_rank,
        sizeLabel: r.size_label,
        availabilityStatus: r.availability_status,
    }));
}
/**
 * Update a model's category manually (admin override).
 */
export function setModelCategory(modelDbId, category, specializations) {
    const db = getDb();
    db.prepare(`
    UPDATE models SET category = ?, specializations = ? WHERE id = ?
  `).run(category, specializations ? specializations.join(',') : '', modelDbId);
}
/**
 * Get all available categories with model counts.
 */
export function getCategoryStats() {
    const db = getDb();
    const rows = db.prepare(`
    SELECT 
      m.category,
      COUNT(*) AS count,
      SUM(CASE WHEN a.status = 'free' THEN 1 ELSE 0 END) AS free_count
    FROM models m
    LEFT JOIN model_availability a ON a.model_db_id = m.id
    WHERE m.enabled = 1
    GROUP BY m.category
    ORDER BY count DESC
  `).all();
    return rows.map(r => ({
        category: r.category,
        count: r.count,
        freeCount: r.free_count,
    }));
}
//# sourceMappingURL=model-categorizer.js.map