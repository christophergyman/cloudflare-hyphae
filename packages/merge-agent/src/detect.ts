/**
 * Test command detection (ADR Part 7.2 open question 1).
 *
 * Decides what to run to verify a merge, in order of preference:
 *   1. an explicit per-repo config
 *   2. a package.json "test" script (npm test)
 *   3. a build-only fallback
 */

export interface DetectionInput {
  /** A per-repo override, if the user set one. */
  configured?: string;
  /** Raw package.json contents, if present. */
  packageJson?: string;
}

export interface DetectionResult {
  command: string;
  source: "config" | "package-json" | "fallback";
}

export function detectTestCommand(input: DetectionInput): DetectionResult {
  if (input.configured && input.configured.trim().length > 0) {
    return { command: input.configured.trim(), source: "config" };
  }

  if (input.packageJson) {
    try {
      const pkg = JSON.parse(input.packageJson) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) {
        return { command: "npm test", source: "package-json" };
      }
      if (pkg.scripts?.build) {
        return { command: "npm run build", source: "package-json" };
      }
    } catch {
      // Malformed package.json: fall through to the default.
    }
  }

  return { command: "npm test", source: "fallback" };
}
