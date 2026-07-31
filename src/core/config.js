import { paths } from '../util/paths.js';
import { readJSON, writeJSON } from '../util/fsx.js';

export const DEFAULT_CONFIG = {
  version: 1,

  /**
   * Hard ceilings, in estimated tokens, for each block of injected context.
   * This is the central design constraint. When a section exceeds its budget,
   * the lowest-scoring facts are evicted. A memory system without a ceiling
   * degrades into a second, worse copy of the transcript.
   */
  budget: {
    identity: 1200,
    project: 800,
    session: 400,
  },

  /** A fact must be seen in this many distinct sessions before it reaches long-term memory. */
  promotionThreshold: 2,

  /** Half-life in days for the recency term of the score. Pinned facts do not decay. */
  halfLife: {
    identity: 90,
    project: 45,
  },

  /** Prompts longer than this are still stored for review but never mined for facts. */
  maxPromptChars: 4000,

  /** Extra regexes (as strings) that disqualify a candidate. Case-insensitive. */
  denyPatterns: [],

  /** Sections rendered, in order, in identity.md */
  identitySections: ['Who', 'Preferences', 'Working style', 'Constraints'],
  projectSections: ['Stack', 'Decisions', 'Conventions', 'Open loops'],

  language: 'auto',
  capture: true,
};

export function loadConfig() {
  const stored = readJSON(paths.config(), null);
  if (!stored) return { ...DEFAULT_CONFIG };
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    budget: { ...DEFAULT_CONFIG.budget, ...(stored.budget || {}) },
    halfLife: { ...DEFAULT_CONFIG.halfLife, ...(stored.halfLife || {}) },
    identitySections: stored.identitySections || DEFAULT_CONFIG.identitySections,
    projectSections: stored.projectSections || DEFAULT_CONFIG.projectSections,
    denyPatterns: stored.denyPatterns || DEFAULT_CONFIG.denyPatterns,
  };
}

export function saveConfig(config) {
  writeJSON(paths.config(), config);
  return config;
}
