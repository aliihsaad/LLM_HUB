import { Router } from 'express';
import { getModelsByCategory, getCategoryStats, setModelCategory, } from '../services/model-categorizer.js';
const router = Router();
/**
 * GET /api/models/categories
 * Returns all models grouped by category.
 */
router.get('/models/categories', (_req, res) => {
    const stats = getCategoryStats();
    const models = getModelsByCategory(undefined, true);
    // Group by category
    const grouped = new Map();
    for (const model of models) {
        const list = grouped.get(model.category) ?? [];
        list.push(model);
        grouped.set(model.category, list);
    }
    res.json({
        stats,
        categories: Object.fromEntries(grouped),
    });
});
/**
 * GET /api/models/categories/:category
 * Returns models for a specific category.
 */
router.get('/models/categories/:category', (req, res) => {
    const category = req.params.category;
    const validCategories = [
        'best_for_chat',
        'best_for_code',
        'best_for_vision',
        'best_for_reasoning',
        'fast',
        'precise',
        'creative',
        'general',
    ];
    if (!validCategories.includes(category)) {
        res.status(400).json({
            error: 'Invalid category',
            validCategories,
        });
        return;
    }
    const models = getModelsByCategory(category, true);
    res.json({
        category,
        count: models.length,
        models,
    });
});
/**
 * PATCH /api/models/:id/category
 * Override a model's category (admin only).
 */
router.patch('/models/:id/category', (req, res) => {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const modelDbId = parseInt(idParam, 10);
    const { category, specializations } = req.body;
    const validCategories = [
        'best_for_chat',
        'best_for_code',
        'best_for_vision',
        'best_for_reasoning',
        'fast',
        'precise',
        'creative',
        'general',
    ];
    if (!validCategories.includes(category)) {
        res.status(400).json({
            error: 'Invalid category',
            validCategories,
        });
        return;
    }
    setModelCategory(modelDbId, category, specializations);
    res.json({
        message: 'Category updated',
        modelDbId,
        category,
        specializations,
    });
});
export default router;
//# sourceMappingURL=model-categories.js.map