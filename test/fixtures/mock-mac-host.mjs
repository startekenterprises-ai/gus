/**
 * Mock GusMacHost for the Phase 8 adapter tests.
 *
 * A Node stand-in for the Swift helper (hosts/mac-app): speaks the
 * exact newline-delimited JSON protocol over a unix socket and
 * returns the exact canonical receipt strings macActionReceipt
 * (packages/control-plane/src/mac.ts) defines — the protocol tests
 * pin those strings here so the Swift side has one form to match.
 *
 *   node mock-mac-host.mjs <socket-path>
 *
 * Test hooks, driven by request params (no other magic):
 *   click element "__error__"    -> { ok: false, error: "mock helper exploded" }
 *   click element "__mismatch__" -> a receipt for a different action
 *   click element "__slow__"     -> answers after 2s (timeout tests)
 *
 * State is in-memory and probe reports it, like the real helper:
 * openApp/focusWindow move the front app, pickerSelect records the
 * selection.
 */
import { createServer } from "node:net";
import { unlinkSync } from "node:fs";

const socketPath = process.argv[2];
if (!socketPath) {
  console.error("usage: node mock-mac-host.mjs <socket-path>");
  process.exit(2);
}

const state = {
  frontApp: "Finder",
  windowTitle: "Desktop",
  focusedElement: undefined,
  pickerSelection: undefined,
};

function fmtNum(n) {
  return n === undefined || n === null ? "?" : String(n);
}

function receipt(method, p) {
  switch (method) {
    case "click":
      return p.element
        ? `clicked element "${p.element}"`
        : `clicked point (${fmtNum(p.x)}, ${fmtNum(p.y)})`;
    case "type":
      return `typed ${String(p.text ?? "").length} chars`;
    case "key":
      return `pressed ${String(p.combo ?? "")}`;
    case "scroll":
      return `scrolled ${String(p.direction ?? "")} by ${fmtNum(p.amount)}`;
    case "openApp":
      return `opened "${String(p.app ?? "")}"`;
    case "focusWindow":
      return p.title
        ? `focused window "${p.title}"`
        : `focused app "${String(p.app ?? "")}"`;
    case "pickerSelect":
      return `selected "${String(p.path ?? "")}"`;
    default:
      return `applied ${method}`;
  }
}

function handle(method, p) {
  switch (method) {
    case "observe":
      return {
        app: state.frontApp,
        windowTitle: state.windowTitle,
        focusedElement: state.focusedElement,
        text: `front app: ${state.frontApp}; window: ${state.windowTitle}`,
      };
    case "probe":
      return {
        frontApp: state.frontApp,
        windowTitle: state.windowTitle,
        focusedElement: state.focusedElement,
        pickerSelection: state.pickerSelection,
      };
    case "click":
      state.focusedElement = p.element ?? `point (${fmtNum(p.x)}, ${fmtNum(p.y)})`;
      if (p.element === "__mismatch__") return "clicked something else entirely";
      return receipt("click", p);
    case "openApp":
      state.frontApp = p.app;
      state.windowTitle = p.app;
      return receipt("openApp", p);
    case "focusWindow":
      if (p.app) state.frontApp = p.app;
      if (p.title) state.windowTitle = p.title;
      return receipt("focusWindow", p);
    case "pickerSelect":
      state.pickerSelection = p.path;
      return receipt("pickerSelect", p);
    case "type":
    case "key":
    case "scroll":
      return receipt(method, p);
    default:
      throw new Error(`unknown method "${method}"`);
  }
}

try { unlinkSync(socketPath); } catch { /* not there yet */ }

const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      const respond = () => {
        let out;
        if (req.method === "click" && req.params?.element === "__error__") {
          out = { id: req.id, ok: false, error: "mock helper exploded" };
        } else {
          try {
            out = { id: req.id, ok: true, result: handle(req.method, req.params ?? {}) };
          } catch (e) {
            out = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        socket.write(JSON.stringify(out) + "\n");
      };
      if (req.method === "click" && req.params?.element === "__slow__") {
        setTimeout(respond, 2000);
      } else {
        respond();
      }
    }
  });
});

server.listen(socketPath, () => {
  console.log(`mock mac host listening on ${socketPath}`);
});
