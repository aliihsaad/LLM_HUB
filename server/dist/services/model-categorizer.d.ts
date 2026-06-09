import type { Platform } from 'llmhub-shared/types.js';
export type ModelCategory = 'best_for_chat' | 'best_for_code' | 'best_for_vision' | 'best_for_reasoning' | 'fast' | 'precise' | 'creative' | 'general';
export interface CategorizedModel {
    id: number;
    platform: Platform;
    modelId: string;
    displayName: string;
    category: ModelCategory;
    specializations: string[];
    intelligenceRank: number;
    speedRank: number;
    sizeLabel: string;
    availabilityStatus?: string;
}
/**
 * Heuristic-based categorization of models.
 * Uses model_id, display_name, and metadata to assign the best category.
 */
export declare function categorizeModel(modelId: string, displayName: string, intelligenceRank: number, speedRank: number, sizeLabel: string): {
    category: ModelCategory;
    specializations: string[];
};
/**
 * Auto-categorize all models in the database.
 * Call this after seeding or when new models are discovered.
 */
export declare function autoCategorizeAllModels(): void;
/**
 * Get models by category, optionally filtered by availability.
 */
export declare function getModelsByCategory(category?: ModelCategory, onlyAvailable?: boolean): CategorizedModel[];
/**
 * Update a model's category manually (admin override).
 */
export declare function setModelCategory(modelDbId: number, category: ModelCategory, specializations?: string[]): void;
/**
 * Get all available categories with model counts.
 */
export declare function getCategoryStats(): Array<{
    category: ModelCategory;
    count: number;
    freeCount: number;
}>;
//# sourceMappingURL=model-categorizer.d.ts.map