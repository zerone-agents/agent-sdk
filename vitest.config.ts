import { configDefaults, defineConfig } from 'vitest/config'

// vitest's default include globs don't respect .gitignore: linked worktrees
// under .worktrees/ (issue #4 et al.) get their tests scanned from the main
// checkout — doubled counts and flaky timing tests under load. Exclude them;
// CI is unaffected (the directory is ignored and never pushed).
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
  },
})
