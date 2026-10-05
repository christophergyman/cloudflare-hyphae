/**
 * The durable merge Workflow (ADR-014).
 *
 * One conflict job runs inside `step.do`, so Workflows persists its result and
 * retries it without re-running a completed merge. All decision logic stays in
 * @hyphae/merge-agent; this file only adapts the runtime bindings and wires the
 * container-backed verifier.
 *
 * This module imports the workerd-only `cloudflare:workers` API and is
 * therefore not Bun-testable. Keep src/index.ts and src/runner.ts free of that
 * import so the existing Bun tests keep running.
 */

import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type {
  MergeWorkflowEnv as BaseMergeWorkflowEnv,
  ConflictJob,
  MergeWorkflowResult,
} from "./runner.ts";
import { runConflictJob } from "./runner.ts";

/** Payload for a merge Workflow instance: exactly the conflict job shape. */
export type MergeJobParams = ConflictJob;

/** The Durable Object RPC surface a container-backed verifier needs. */
interface SandboxStub {
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface MergeWorkflowEnv extends BaseMergeWorkflowEnv {
  /** The Workflow binding this Worker triggers. */
  MERGE_WORKFLOW: Workflow<MergeJobParams>;
  /** Container-backed verifier. Present when the Sandbox DO is bound. */
  SANDBOX?: DurableObjectNamespace;
}

/**
 * Prefer the container-backed Sandbox when the deployment binds one, so
 * untrusted repo code and tests run in an isolated container. An explicitly
 * injected `Sandbox` always wins, which keeps the Hub inline path and tests
 * working without a container.
 *
 * A fresh Durable Object id per attempt means one container per merge, so a
 * retried step never reuses a dirty filesystem from an earlier attempt.
 */
function withSandbox(env: MergeWorkflowEnv): BaseMergeWorkflowEnv {
  if (env.Sandbox || !env.SANDBOX) return env;
  const stub = env.SANDBOX.get(env.SANDBOX.newUniqueId()) as unknown as SandboxStub;
  return {
    ...env,
    Sandbox: {
      writeFile: (path, content) => stub.writeFile(path, content),
      exec: (command) => stub.exec(command),
    },
  };
}

export class MergeWorkflow extends WorkflowEntrypoint<MergeWorkflowEnv, MergeJobParams> {
  override async run(
    event: WorkflowEvent<MergeJobParams>,
    step: WorkflowStep,
  ): Promise<MergeWorkflowResult> {
    return await step.do("merge", async () => runConflictJob(withSandbox(this.env), event.payload));
  }
}
