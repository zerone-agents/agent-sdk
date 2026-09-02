/**
 * Resolve the environment passed to tool subprocesses (Bash, Grep).
 *
 * Called once per agent build; result is cached on RuntimeEnvironment and
 * forwarded to ToolContext.subprocessEnv for every tool invocation.
 *
 * @param opts.toolEnv         Explicit env vars for subprocesses.
 * @param opts.toolEnvInherit  Default true: merge toolEnv over process.env.
 *                             False: use toolEnv only (host fully controls).
 * @returns A fresh env record. Never returns process.env itself.
 */
export function resolveSubprocessEnv(opts: {
  toolEnv?: Record<string, string | undefined>
  toolEnvInherit?: boolean
}): Record<string, string | undefined> {
  const inherit = opts.toolEnvInherit !== false // default true
  return inherit
    ? { ...process.env, ...(opts.toolEnv ?? {}) }
    : { ...(opts.toolEnv ?? {}) }
}
