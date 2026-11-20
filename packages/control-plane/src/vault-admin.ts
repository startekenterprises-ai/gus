/**
 * Vault admin CLI — OPERATOR SIDE ONLY.
 *
 * Invoked as a separate control-plane process invocation
 * (`node main.js vault-admin <add|list|remove> ...`) on the operator's
 * host / control-plane container, against the control-plane state dir.
 * It is never reachable from the sandbox: the comm bridge has no admin
 * surface, and this code path runs before any server starts and exits.
 *
 * Output discipline: `add` reads the value from argv (the operator's own
 * terminal — their secret, their shell history, their call) and NEVER
 * prints it back. `list` prints names only. There is no `get`.
 */
import { readFileSync } from "node:fs";
import type { VaultBroker } from "@gus/vault";

export function runVaultAdmin(argv: string[], vault: VaultBroker): number {
  const [cmd, name, value] = argv;
  try {
    switch (cmd) {
      case "add": {
        if (!name || value === undefined) {
          console.error("usage: vault-admin add <name> <value|->  ('-' reads the value from stdin)");
          return 2;
        }
        const v = value === "-" ? readFileSync(0, "utf8").trim() : value;
        vault.add(name, v);
        console.log(`vault: stored secret under name "${name}" (value not shown)`);
        return 0;
      }
      case "list": {
        const names = vault.listNames();
        console.log(names.length > 0 ? names.join("\n") : "(vault is empty)");
        return 0;
      }
      case "remove": {
        if (!name) {
          console.error("usage: vault-admin remove <name>");
          return 2;
        }
        console.log(vault.remove(name) ? `vault: removed "${name}"` : `vault: no secret named "${name}"`);
        return 0;
      }
      default:
        console.error("usage: vault-admin <add|list|remove> ...");
        return 2;
    }
  } catch (e) {
    console.error(`vault-admin: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
