/**
 * Sandbox tool executors + the post-condition checker.
 *
 * These are FIXED runtime code, not model-generated: the model proposes
 * arguments; this code executes them inside the workspace jail and nothing
 * else. The same executors answer control-plane `verify` requests, which
 * is what makes verification a check on reality instead of the model's
 * self-report.
 *
 * Jail rules (in code, on top of the container's read-only rootfs and
 * dropped capabilities): every path is resolved inside the workspace
 * root; `..` escapes and absolute paths outside it are refused.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class Workspace {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  private jail(path: string): string {
    const full = resolve(this.root, path.replace(/^\/+/, ""));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`path escapes workspace: ${path}`);
    }
    return full;
  }

  write(path: string, content: string): { digest: string } {
    const full = this.jail(path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return { digest: sha256Hex(content) };
  }

  read(path: string): string {
    const full = this.jail(path);
    if (!existsSync(full)) throw new Error(`no such file: ${path}`);
    return readFileSync(full, "utf8");
  }

  digest(path: string): string {
    return sha256Hex(this.read(path));
  }
}

export interface ToolOutcome {
  ok: boolean;
  summary: string;
}

/**
 * Execute an authorized tool. `signal.aborted` is polled by long-running
 * tools so a control-plane kill lands between steps, not after the job.
 */
export async function executeTool(
  ws: Workspace,
  tool: string,
  args: Record<string, unknown>,
  signal: { aborted: boolean },
  heartbeat: () => void,
): Promise<ToolOutcome> {
  switch (tool) {
    case "workspace_write": {
      const { digest } = ws.write(String(args.path), String(args.content));
      return { ok: true, summary: `wrote ${String(args.path)} sha256=${digest.slice(0, 12)}…` };
    }
    case "workspace_read": {
      const content = ws.read(String(args.path));
      return { ok: true, summary: `read ${String(args.path)} (${content.length} chars)` };
    }
    case "slow_work": {
      const steps = Number(args.steps ?? 60);
      for (let i = 0; i < steps; i++) {
        if (signal.aborted) return { ok: false, summary: `slow_work aborted at step ${i}/${steps}` };
        heartbeat();
        await new Promise((r) => setTimeout(r, 150));
      }
      return { ok: true, summary: `slow_work completed ${steps} steps` };
    }
    default:
      return { ok: false, summary: `unknown tool ${tool}` };
  }
}
