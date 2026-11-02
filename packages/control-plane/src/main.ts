/**
 * Control plane entrypoint.
 *
 * Env:
 *   GUS_STATE_DIR     durable state (ledger, jobs, receipts, kill flag)
 *   GUS_COMM_SOCKET   unix socket path inside the shared comm volume
 *   GUS_CHANNEL       "fake-file" (Phase 0 harness) | "telegram"
 *   GUS_FAKE_INBOUND / GUS_FAKE_OUTBOUND   fake transport files
 *   GUS_TELEGRAM_BOT_TOKEN                 telegram channel credential
 *   GUS_TELEGRAM_TRANSPORT "botapi" (default when channel=telegram)
 */
import { appendFileSync, mkdirSync } from "node:fs";
import type { ChannelAdapter } from "@gus/shared";
import { BotApiTransport, FakeFileTransport, TelegramAdapter } from "@gus/telegram";
import { LocalReceiptIssuer } from "@gus/gate";
import { Governor } from "./governor.js";
import { JobRunner } from "./jobs.js";
import { CommServer } from "./comm-server.js";
import { ChannelHost } from "./channel-host.js";

const stateDir = process.env.GUS_STATE_DIR ?? "/state";
const socketPath = process.env.GUS_COMM_SOCKET ?? "/comm/gus.sock";
mkdirSync(stateDir, { recursive: true });

const governor = new Governor(stateDir);
const receipts = new LocalReceiptIssuer(`${stateDir}/receipt-stub.key`);
const jobs = new JobRunner(stateDir, receipts);

const channelKind = process.env.GUS_CHANNEL ?? "fake-file";
let adapter: ChannelAdapter;
if (channelKind === "telegram") {
  const token = process.env.GUS_TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("GUS_TELEGRAM_BOT_TOKEN is required for channel=telegram");
  adapter = new TelegramAdapter(new BotApiTransport(token));
} else {
  const inbound = process.env.GUS_FAKE_INBOUND ?? "/run/gus/inbound.ndjson";
  const outbound = process.env.GUS_FAKE_OUTBOUND ?? "/run/gus/outbound.ndjson";
  adapter = new TelegramAdapter(new FakeFileTransport(inbound, outbound));
}

const host = new ChannelHost(stateDir, governor, jobs, [adapter]);
const comm = new CommServer(socketPath, governor, jobs, {
  onRuntimeHello: () => host.onRuntimeHello(),
  onModelIssued: (jobId, text) => host.onModelIssued(jobId, text),
  noteAuthorizedWrite: (jobId, path, content) => host.noteAuthorizedWrite(jobId, path, content),
  onParked: (jobId, tool) => host.onParked(jobId, tool),
  onJobUpdate: (jobId, note) => host.onJobUpdate(jobId, note),
  onJobFinal: (jobId, text) => host.onJobFinal(jobId, text),
  logRuntime: (level, text) =>
    appendFileSync(`${stateDir}/runtime-log.jsonl`, JSON.stringify({ ts: Date.now(), level, text }) + "\n"),
});
host.attachComm(comm);

await comm.start();
await host.start();
appendFileSync(
  `${stateDir}/runtime-log.jsonl`,
  JSON.stringify({ ts: Date.now(), level: "info", text: `control plane up; channel=${adapter.name} transport=${channelKind} killed=${governor.isKilled()}` }) + "\n",
);
console.log(`gus control plane up (channel=${channelKind}, killed=${governor.isKilled()})`);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
