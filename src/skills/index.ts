/**
 * Skills Module - Public API
 */

// Types
export type {
  SkillDefinition,
  SkillContentBlock,
  SkillResult,
} from './types.js'

// Registry
export {
  SkillRegistry,
  defaultRegistry,
  registerSkill,
  getSkill,
  getAllSkills,
  getUserInvocableSkills,
  hasSkill,
  unregisterSkill,
  formatSkillsForPrompt,
  formatSkillsForSystemPrompt,
  formatSkillsForToolDescription,
  filterSkillsByAllowlist,
} from './registry.js'

// Filesystem loading
export { loadSkillsFromFilesystem } from './filesystem.js'
export type { ExtraDirs } from './filesystem.js'
