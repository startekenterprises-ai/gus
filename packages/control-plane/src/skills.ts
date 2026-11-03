/**
 * Skill installation behind the local scan gate (foundation spec
 * §1.7, choke point 5) — Phase 4.
 *
 * Installing a skill is admitting third-party instructions into the
 * agent's context, so the admission runs the agent-shield-scan checks
 * (ported into @gus/gate, local, no network): a "do not install"
 * verdict — any finding of high severity or worse — REFUSES the
 * install. There is deliberately no operator override: an override
 * button on a malware gate is how the gate stops mattering. "review"
 * (lower-severity findings) installs, with the findings recorded so
 * the admission is auditable, not silent.
 *
 * Records land in <state>/skills.jsonl; admitted content is copied to
 * <state>/skills/<name>/. Executing installed skills is Phase 5+
 * scope — v1 admits and registers them; the runtime does not load
 * third-party skills yet, and this file does not pretend otherwise.
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { scanSkillTree, type SkillScanResult } from "@gus/gate";

export interface SkillInstallResult {
  ok: boolean;
  detail: string;
  verdict?: SkillScanResult["verdict"];
  findings?: {
    check: string;
    severity: string;
    file: string;
    line: number | null;
    summary: string;
  }[];
  name?: string;
}

export interface InstalledSkill {
  name: string;
  verdict: string;
  installedAt: number;
}

function safeName(raw: string): string | undefined {
  const name = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return name.length >= 1 && name.length <= 64 ? name : undefined;
}

export class SkillInstaller {
  constructor(private stateDir: string) {}

  private logPath(): string {
    return `${this.stateDir}/skills.jsonl`;
  }

  private skillsDir(): string {
    return `${this.stateDir}/skills`;
  }

  install(sourcePath: string): SkillInstallResult {
    const source = sourcePath.trim();
    if (!source || !existsSync(source)) {
      return { ok: false, detail: `No skill found at "${sourcePath}". Nothing was installed.` };
    }
    let result: SkillScanResult;
    try {
      result = scanSkillTree(source);
    } catch (e) {
      return {
        ok: false,
        detail: `The local scan could not run on "${source}": ${e instanceof Error ? e.message : String(e)}. Nothing was installed.`,
      };
    }
    const findings = result.findings.map((f) => ({
      check: f.check,
      severity: f.severity,
      file: f.file,
      line: f.line,
      summary: f.summary,
    }));
    const rawName = basename(source.replace(/\/+$/, "")).replace(/\.(md|json)$/i, "");
    const name = safeName(rawName) ?? "skill";

    const record = (installed: boolean, why: string) => {
      appendFileSync(
        this.logPath(),
        JSON.stringify({
          ts: Date.now(),
          name,
          source,
          verdict: result.verdict,
          findings: result.findings.length,
          installed,
          why,
        }) + "\n",
      );
    };

    if (result.verdict === "do_not_install") {
      record(false, "refused by the local scan gate");
      const worst = result.findings
        .filter((f) => f.severity === "critical" || f.severity === "high")
        .slice(0, 3)
        .map((f) => `${f.check} in ${f.file}:${f.line ?? "?"} — ${f.summary}`)
        .join("; ");
      return {
        ok: false,
        verdict: result.verdict,
        findings,
        name,
        detail:
          `Refused: the local scanner returned DO NOT INSTALL (${result.findings.length} finding(s)). ` +
          `${worst}. Nothing was copied into GUS. There is no override for this verdict.`,
      };
    }

    try {
      mkdirSync(this.skillsDir(), { recursive: true });
      const dest = join(this.skillsDir(), name);
      const st = statSync(source);
      if (st.isDirectory()) {
        cpSync(source, dest, { recursive: true });
      } else {
        mkdirSync(dest, { recursive: true });
        cpSync(source, join(dest, basename(source)));
      }
    } catch (e) {
      return {
        ok: false,
        verdict: result.verdict,
        findings,
        name,
        detail: `Scan passed (${result.verdict}) but copying into GUS failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    record(true, result.verdict === "review" ? "installed with findings recorded" : "installed clean");
    return {
      ok: true,
      verdict: result.verdict,
      findings,
      name,
      detail:
        result.verdict === "review"
          ? `Installed as "${name}" with ${result.findings.length} lower-severity finding(s) on record (the scan details are in skills.jsonl).`
          : `Installed as "${name}" — the local scan found nothing. (Registered for use; the v1 runtime does not execute third-party skills yet.)`,
    };
  }

  /** Installed skills, from the admission log (latest per name). */
  listInstalled(): InstalledSkill[] {
    const byName = new Map<string, InstalledSkill>();
    if (!existsSync(this.logPath())) return [];
    for (const line of readFileSync(this.logPath(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as {
          ts: number;
          name: string;
          verdict: string;
          installed: boolean;
        };
        if (r.installed) byName.set(r.name, { name: r.name, verdict: r.verdict, installedAt: r.ts });
      } catch { /* skip torn lines */ }
    }
    return [...byName.values()].sort((a, b) => b.installedAt - a.installedAt);
  }
}
