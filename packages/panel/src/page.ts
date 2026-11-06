/**
 * The panel page — one self-contained HTML document, no external
 * assets (the control plane serves it from its own process; there is
 * nothing to CDN and nothing to phone home). Plain language,
 * mobile-readable, and honest in the product's own terms: a receipt
 * is "no known-bad patterns detected," a stub receipt is labeled a
 * stub, and the Shield fail-mode tradeoff is stated where the
 * operator chooses it.
 */
export const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GUS — control panel</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 880px; padding: 16px; line-height: 1.45; }
  h1 { font-size: 1.4rem; margin: 0 0 2px; }
  h2 { font-size: 1.1rem; margin: 28px 0 8px; border-bottom: 1px solid #8884; padding-bottom: 4px; }
  .sub { opacity: .75; font-size: .9rem; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
  .card { border: 1px solid #8885; border-radius: 10px; padding: 10px 14px; min-width: 150px; flex: 1; }
  .card b { display: block; font-size: 1.15rem; }
  .ok { color: #1a7f37; } .bad { color: #c0392b; } .warn { color: #b7791f; }
  button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 1px solid #8888; cursor: pointer; background: #8882; }
  button.danger { background: #c0392b; color: #fff; border-color: #c0392b; }
  button.primary { background: #1a7f37; color: #fff; border-color: #1a7f37; }
  input, select { font: inherit; padding: 7px; border-radius: 8px; border: 1px solid #8888; width: 100%; box-sizing: border-box; margin: 4px 0 10px; }
  label { font-weight: 600; font-size: .92rem; }
  .hint { font-size: .86rem; opacity: .8; margin: 2px 0 10px; }
  table { border-collapse: collapse; width: 100%; font-size: .88rem; }
  td, th { border-bottom: 1px solid #8883; padding: 5px 6px; text-align: left; vertical-align: top; }
  .row { border: 1px solid #8885; border-radius: 10px; padding: 10px 14px; margin: 8px 0; }
  .row .acts { margin-top: 8px; display: flex; gap: 8px; }
  .step { border: 1px solid #8885; border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
  .step.done { opacity: .75; }
  .msg { padding: 8px 12px; border-radius: 8px; margin: 8px 0; display: none; }
  .msg.ok { background: #1a7f3722; display: block; }
  .msg.err { background: #c0392b22; display: block; }
  code { font-size: .85em; word-break: break-all; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>GUS control panel</h1>
<div class="sub" id="subtitle">Loading…</div>
<div id="flash" class="msg"></div>

<h2>Status</h2>
<div class="cards" id="status-cards"></div>
<div class="row">
  <b>Kill switch</b>
  <div class="hint">Stops the agent immediately: no new model calls, running jobs end as failed-loudly with receipts. The same switch as Telegram's /stop.</div>
  <div class="acts">
    <button class="danger" id="kill-on">⏹ Stop GUS now</button>
    <button id="kill-off">▶ Resume</button>
  </div>
</div>
<div class="row">
  <b>Governor mode</b>
  <div class="hint"><b>Enforcing</b>: Shield verdicts and approval parks bind. <b>Permissive</b> (SELinux-style): everything is still scanned, classified, capped and receipted, but blocks and parks are recorded instead of enforced — the troubleshooting mode, with a report of what it let through. Two floors never relax: vault reads stay denied, and the spend caps and kill switch are unchanged.</div>
  <div class="acts">
    <button id="mode-enforcing">🛡 Enforcing</button>
    <button id="mode-permissive">⚠️ Permissive</button>
  </div>
  <div id="permissive-report" class="hint"></div>
</div>
<div class="row" id="delegation-row">
  <b>Approval delegation</b>
  <div class="hint">In <b>Permissive</b> mode only, a parked action can be routed to an agent approver instead of proceeding on the mode's say-so: GUS itself (a metered decision by the configured model, made in the control plane — a failed or unparseable decision is a denial), or a named delegate resolving a park on a job it did not submit. Some classes are floors and are <b>never</b> delegable: vault reads, deletes, installs, sends and posts, git push, sudo/kill-class shell, and keychain access. Every delegated approval is hash-bound, single-use, rate-limited, and receipted with who approved it and their reason. In Enforcing mode none of this applies — approvals stay with the operator, exactly as always — so these controls are greyed out until the Governor is permissive.</div>
  <fieldset id="delegation-fields" style="border:0;padding:0;margin:0">
    <label style="display:block;font-weight:400"><input type="checkbox" id="del-gus-delegates" style="width:auto;margin-right:6px">GUS may approve delegates' parked actions</label>
    <label style="display:block;font-weight:400"><input type="checkbox" id="del-gus-own" style="width:auto;margin-right:6px">GUS may approve its own jobs' parked actions</label>
    <label style="display:block;font-weight:400"><input type="checkbox" id="del-delegates" style="width:auto;margin-right:6px">Named delegates may approve parked actions on jobs they did not submit</label>
    <label>Scope</label>
    <select id="del-scope">
      <option value="bounded">Bounded — Mac input injection, file writes outside the work folders, non-allowlisted shell</option>
      <option value="all_except_floors">Everything except the floors</option>
    </select>
    <label>Max agent approvals per hour (across all agent approvers)</label>
    <input id="del-max" type="number" min="0" max="1000" step="1">
    <div class="acts"><button id="del-save">Save delegation policy</button></div>
  </fieldset>
  <div id="delegation-state" class="hint"></div>
</div>
<div class="row">
  <b>Settings on file</b>
  <div class="hint">What is actually saved right now — so a save is something you can verify, not something you hope happened. Keys are shown as stored or not; values never appear here.</div>
  <div id="settings-on-file" class="hint">Loading…</div>
</div>

<h2>Approvals waiting</h2>
<div id="approvals"><div class="hint">Nothing is waiting.</div></div>

<h2>Money — where it went</h2>
<div class="cards" id="money-cards"></div>
<div class="hint" id="ledger-note"></div>
<div style="overflow-x:auto"><table id="ledger"><thead><tr><th>When</th><th>Job</th><th>Model</th><th>What</th><th>Cost</th></tr></thead><tbody></tbody></table></div>

<h2>Jobs &amp; receipts</h2>
<div id="jobs"></div>

<h2>Setup — get GUS running</h2>
<div class="hint">Five short steps. Every secret you type here goes straight into GUS's encrypted vault on this machine — never into chat, never into a log. (Telegram bot chats are <b>not</b> end-to-end encrypted, which is why secrets only ever travel through this panel.)</div>

<div class="step" id="step-shield">
  <b>1 · Turn on the Agent-Shield gate</b>
  <div class="hint">Agent-Shield scans every message, tool call, and fetched page before the agent can act on it, and leaves a verifiable receipt. GUS can create its free key by itself — no form, no email.</div>
  <label>If Agent-Shield can't be reached, GUS should…</label>
  <select id="shield-fail">
    <option value="closed">Block the message/action (recommended). Safer — a Shield outage pauses the agent.</option>
    <option value="open">Let it through UNSCANNED, flagged, with no receipt. The agent keeps working during an outage, unprotected.</option>
  </select>
  <button class="primary" data-act="shield">Provision the free key &amp; turn on the gate</button>
</div>

<div class="step" id="step-telegram">
  <b>2 · Connect Telegram</b>
  <div class="hint">Create a bot with @BotFather in Telegram, then paste its token here. It is stored in the vault; it never appears in chat.</div>
  <label>Bot token</label>
  <input id="tg-token" type="password" autocomplete="off" placeholder="123456789:AA…">
  <button class="primary" data-act="telegram">Store the token</button>
</div>

<div class="step" id="step-provider">
  <b>3 · Choose how GUS thinks</b>
  <div class="hint">Your own provider key (stored in the vault, metered by the same caps), a model running on your own machine (Ollama — free), or the StarTek starter gateway when configured. New here? Gemini is the recommended starter: a free key from Google AI Studio (aistudio.google.com) is enough to begin. One honest catch: on Google's free tier, Google may use what you send to improve its models — a paid Gemini key removes that.</div>
  <label>Provider</label>
  <select id="pv-kind">
    <option value="gemini">Google Gemini — my key (recommended starter: free key from Google AI Studio)</option>
    <option value="anthropic">Anthropic (Claude) — my key</option>
    <option value="openai">OpenAI — my key</option>
    <option value="ollama">Ollama on my machine — no key, $0</option>
    <option value="gateway">StarTek starter gateway</option>
    <option value="stub">Offline stub (testing only — not a real model)</option>
  </select>
  <label>Model</label>
  <input id="pv-model" value="gemini-3.5-flash">
  <label>API key (not needed for Ollama)</label>
  <input id="pv-key" type="password" autocomplete="off" placeholder="paste key — goes to the vault only">
  <label>Base URL (optional — Ollama / gateway)</label>
  <input id="pv-base" placeholder="http://127.0.0.1:11434/v1">
  <button class="primary" data-act="provider">Save provider</button>
</div>

<div class="step" id="step-caps">
  <b>4 · Spending caps</b>
  <div class="hint">Hard ceilings, enforced outside the model — the agent cannot raise them or talk its way past them. Pre-filled with sane defaults; change them if you like.</div>
  <label>Max per task (USD)</label><input id="cap-task" type="number" step="0.5" min="0">
  <label>Max per day (USD)</label><input id="cap-day" type="number" step="1" min="0">
  <label>Max per month (USD)</label><input id="cap-month" type="number" step="5" min="0">
  <button class="primary" data-act="caps">Save caps</button>
</div>

<div class="step" id="step-firstjob">
  <b>5 · Run your first job</b>
  <div class="hint">The daily digest, end to end through every gate, with a receipt — proof the whole path works.</div>
  <button class="primary" data-act="firstjob">Run the daily digest now</button>
</div>

<h2>Vault</h2>
<div class="hint">Secrets live here, encrypted. This page can add one and list names — nothing anywhere can display a value back.</div>
<div id="vault-names" class="hint"></div>
<label>New secret — name (lowercase, e.g. openai)</label>
<input id="vault-name" placeholder="name">
<label>Value</label>
<input id="vault-value" type="password" autocomplete="off" placeholder="value — stored encrypted, never shown again">
<button data-act="vault">Store in vault</button>

<h2>Skills</h2>
<div class="hint">A skill is admitted only after the local scanner (agent-shield-scan checks) passes it. A "do not install" verdict is refused — there is no override button, on purpose.</div>
<div id="skills-list" class="hint"></div>
<label>Skill folder or MCP config path on this machine</label>
<input id="skill-path" placeholder="/path/to/skill">
<button data-act="skill">Scan &amp; install</button>
<div id="skill-result" class="hint"></div>

<script>
const $ = (s) => document.querySelector(s);
async function api(path, opts) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || ("HTTP " + res.status));
  return body;
}
function flash(text, ok) {
  const el = $("#flash");
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
  window.scrollTo({ top: 0, behavior: "smooth" });
}
const money = (n) => "$" + Number(n || 0).toFixed(4);
async function refresh() {
  const [status, ledger, jobs, approvals, onboarding, skills, vault] = await Promise.all([
    api("/api/status"), api("/api/ledger"), api("/api/jobs"), api("/api/approvals"),
    api("/api/onboarding"), api("/api/skills"), api("/api/vault"),
  ]);
  $("#subtitle").textContent = "GUS v" + status.version + (status.runtimeVersion ? " · agent runtime v" + status.runtimeVersion : "") +
    " · provider: " + status.provider.id + " / " + status.provider.model;
  $("#status-cards").innerHTML =
    '<div class="card">Kill switch<b class="' + (status.killed ? "bad" : "ok") + '">' + (status.killed ? "ON — stopped" : "Off — live") + "</b></div>" +
    '<div class="card">Agent-Shield gate<b class="' + (status.shield.provisioned ? "ok" : "warn") + '">' +
      (status.shield.provisioned ? "On · fail-" + status.shield.onUnavailable : "Not provisioned yet") + "</b></div>" +
    '<div class="card">Approvals waiting<b>' + status.pendingApprovals + "</b></div>" +
    '<div class="card">Governor mode<b class="' + (status.governorMode === "permissive" ? "warn" : "ok") + '">' +
      (status.governorMode === "permissive" ? "⚠️ Permissive" : "🛡 Enforcing") + "</b></div>" +
    '<div class="card">Spent today<b>' + money(status.spendTodayUsd) + "</b></div>";
  const st = status.settings || {};
  const keyLine = st.providerKey === "stored" ? "stored in the vault ✓"
    : st.providerKey === "missing" ? "NOT stored — add it in Setup below"
    : "not required for this provider";
  const capsLine = st.caps && (st.caps.maxUsdPerTask != null || st.caps.maxUsdPerDay != null || st.caps.maxUsdPerMonth != null)
    ? "per task " + money(st.caps.maxUsdPerTask) + " · per day " + money(st.caps.maxUsdPerDay) + " · per month " + money(st.caps.maxUsdPerMonth)
    : "conservative defaults (token caps)";
  const ap = st.approverPolicy || { gusApprovesDelegates: false, gusApprovesOwn: false, delegatesMayApprove: false, scope: "bounded", maxApprovalsPerHour: 30 };
  const apOn = ap.gusApprovesDelegates || ap.gusApprovesOwn || ap.delegatesMayApprove;
  const apLine = !apOn
    ? "off — approvals are the operator's"
    : "GUS→delegates " + (ap.gusApprovesDelegates ? "on" : "off") + " · GUS→own " + (ap.gusApprovesOwn ? "on" : "off") +
      " · delegates " + (ap.delegatesMayApprove ? "on" : "off") + " · scope " + (ap.scope === "all_except_floors" ? "all except floors" : "bounded") +
      " · ≤" + ap.maxApprovalsPerHour + "/hr" + (status.governorMode === "permissive" ? " · LIVE (permissive)" : " · inert while enforcing");
  $("#settings-on-file").innerHTML =
    "Provider: <b>" + status.provider.id + " / " + status.provider.model + "</b> · API key: <b>" + keyLine + "</b><br>" +
    "Telegram: <b>" + (st.telegramConfigured ? "bot token stored ✓" : "not configured") + "</b> · " +
    "Agent-Shield gate: <b>" + (status.shield.provisioned ? "key stored ✓ · fail-" + status.shield.onUnavailable : "not provisioned") + "</b><br>" +
    "Spend caps: <b>" + capsLine + "</b><br>" +
    "Named delegates: <b>" + (st.delegates ?? 0) + "</b> · Mac work folders: <b>" + (st.macWorkDirs ?? 0) + "</b><br>" +
    "Approval delegation: <b>" + apLine + "</b>";
  const dFields = $("#delegation-fields");
  dFields.disabled = status.governorMode !== "permissive";
  $("#delegation-state").textContent = status.governorMode === "permissive"
    ? "Live: the Governor is permissive, so this policy routes parks from now on."
    : "Inert while the Governor is enforcing — flip to Permissive above to enable these controls.";
  if (!$("#delegation-row").contains(document.activeElement)) {
    $("#del-gus-delegates").checked = !!ap.gusApprovesDelegates;
    $("#del-gus-own").checked = !!ap.gusApprovesOwn;
    $("#del-delegates").checked = !!ap.delegatesMayApprove;
    $("#del-scope").value = ap.scope;
    $("#del-max").value = ap.maxApprovalsPerHour;
  }
  const pr = status.permissiveToday || { count: 0, recent: [] };
  $("#permissive-report").innerHTML = pr.count === 0
    ? "Permissive let-throughs today: none."
    : "Permissive let-throughs today: <b>" + pr.count + "</b>" + pr.recent.map((a) =>
        "<br>· " + new Date(a.ts).toLocaleTimeString() + " [" + a.kind + "] " + a.detail).join("");
  $("#money-cards").innerHTML =
    '<div class="card">Today<b>' + money(ledger.summary.todayUsd) + '</b></div>' +
    '<div class="card">This month<b>' + money(ledger.summary.monthUsd) + '</b></div>' +
    '<div class="card">All time<b>' + money(ledger.summary.totalUsd) + '</b></div>' +
    '<div class="card">Ledger check<b class="' + (ledger.audit.reconciles ? "ok" : "bad") + '">' +
      (ledger.audit.reconciles ? "Reconciles exactly" : "DOES NOT RECONCILE") + "</b></div>";
  const caps = ledger.summary.caps || {};
  $("#ledger-note").textContent = "Caps: per task " + (caps.maxUsdPerTask != null ? money(caps.maxUsdPerTask) : "token-only") +
    " · per day " + (caps.maxUsdPerDay != null ? money(caps.maxUsdPerDay) : "token-only") +
    " · per month " + (caps.maxUsdPerMonth != null ? money(caps.maxUsdPerMonth) : "token-only") +
    ". Every settled call is in the ledger; reservations always equal settlements plus refunds.";
  $("#ledger tbody").innerHTML = ledger.entries.slice(-25).reverse().map((e) =>
    "<tr><td>" + new Date(e.ts).toLocaleTimeString() + "</td><td><code>" + (e.jobId || "") + "</code></td><td>" +
    (e.model || "") + "</td><td>" + e.kind + "</td><td>" + (e.kind === "settle" ? money(e.costUsd) : "") + "</td></tr>").join("");
  $("#approvals").innerHTML = approvals.length ? "" : '<div class="hint">Nothing is waiting.</div>';
  for (const a of approvals) {
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML = "<b>" + a.summary + "</b><div class='hint'>Why: " + a.reason + " · No answer in time counts as a denial.</div>";
    const acts = document.createElement("div"); acts.className = "acts";
    const yes = document.createElement("button"); yes.className = "primary"; yes.textContent = "✅ Approve — exactly this";
    const no = document.createElement("button"); no.className = "danger"; no.textContent = "🚫 Deny";
    yes.onclick = () => act(() => api("/api/approvals/" + a.id + "/approve", { method: "POST" }), "Approved — executing exactly that.");
    no.onclick = () => act(() => api("/api/approvals/" + a.id + "/deny", { method: "POST" }), "Denied. Nothing ran.");
    acts.append(yes, no); div.append(acts); $("#approvals").append(div);
  }
  $("#jobs").innerHTML = jobs.slice(0, 20).map((j) => {
    const shield = (j.shieldReceipts || []).map((r) => r.verifyUrl
      ? ' · <a href="' + r.verifyUrl + '" target="_blank" rel="noopener">Shield receipt ' + r.receiptId + "</a>"
      : " · Shield receipt " + r.receiptId).join("");
    const settlement = j.receiptId
      ? (j.receiptId.startsWith("rcpt_")
          ? ' · settlement receipt: ' + (j.receiptVerifyUrl ? '<a href="' + j.receiptVerifyUrl + '" target="_blank" rel="noopener">' + j.receiptId + "</a>" : j.receiptId) + " (real, verifiable)"
          : " · settlement receipt: " + j.receiptId + " (local stub — no Shield call applied)")
      : "";
    return '<div class="row"><b>' + j.kind + "</b> · " + j.state + " · " + money(j.costUsd) +
      "<div class='hint'>" + new Date(j.createdAt).toLocaleString() + (j.outcomeNote ? " — " + j.outcomeNote : "") + shield + settlement + "</div></div>";
  }).join("") || '<div class="hint">No jobs yet.</div>';
  for (const [step, id] of Object.entries({ shield: "#step-shield", telegram: "#step-telegram", provider: "#step-provider", caps: "#step-caps", firstJob: "#step-firstjob" })) {
    const el = $(id);
    el.classList.toggle("done", !!onboarding.steps[step].done);
    const title = el.querySelector("b");
    if (onboarding.steps[step].done && !title.textContent.startsWith("✓")) title.textContent = "✓ " + title.textContent;
  }
  if (!$("#cap-task").value) {
    $("#cap-task").value = onboarding.suggestedCaps.maxUsdPerTask;
    $("#cap-day").value = onboarding.suggestedCaps.maxUsdPerDay;
    $("#cap-month").value = onboarding.suggestedCaps.maxUsdPerMonth;
  }
  $("#vault-names").textContent = "Stored (names only): " + (vault.names.length ? vault.names.join(", ") : "nothing yet");
  $("#skills-list").textContent = skills.length
    ? "Installed: " + skills.map((s) => s.name + " (" + s.verdict + ")").join(", ")
    : "No third-party skills installed.";
}
async function act(fn, okText) {
  try { const r = await fn(); flash(r.detail || okText, true); }
  catch (e) { flash(String(e.message || e), false); }
  refresh().catch(() => {});
}
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-act]");
  if (!b) return;
  const kind = b.dataset.act;
  if (kind === "shield") act(() => api("/api/onboarding/shield", { method: "POST", body: JSON.stringify({ onUnavailable: $("#shield-fail").value }) }), "Gate on.");
  if (kind === "telegram") act(() => api("/api/onboarding/telegram", { method: "POST", body: JSON.stringify({ token: $("#tg-token").value }) }), "Token stored.");
  if (kind === "provider") act(() => api("/api/onboarding/provider", { method: "POST", body: JSON.stringify({
    provider: $("#pv-kind").value, model: $("#pv-model").value, apiKey: $("#pv-key").value || undefined, baseUrl: $("#pv-base").value || undefined }) }), "Provider saved.");
  if (kind === "caps") act(() => api("/api/onboarding/caps", { method: "POST", body: JSON.stringify({
    maxUsdPerTask: Number($("#cap-task").value), maxUsdPerDay: Number($("#cap-day").value), maxUsdPerMonth: Number($("#cap-month").value) }) }), "Caps saved.");
  if (kind === "firstjob") act(() => api("/api/onboarding/first-job", { method: "POST", body: "{}" }), "First job started — watch Jobs above.");
  if (kind === "vault") act(() => api("/api/vault", { method: "POST", body: JSON.stringify({ name: $("#vault-name").value, value: $("#vault-value").value }) }), "Stored.");
  if (kind === "skill") {
    api("/api/skills/install", { method: "POST", body: JSON.stringify({ path: $("#skill-path").value }) })
      .then((r) => { $("#skill-result").textContent = r.detail; flash(r.detail, r.ok); refresh().catch(() => {}); })
      .catch((e) => flash(String(e.message || e), false));
  }
});
$("#kill-on").onclick = () => act(() => api("/api/kill", { method: "POST", body: JSON.stringify({ on: true }) }), "Kill switch ON.");
$("#kill-off").onclick = () => act(() => api("/api/kill", { method: "POST", body: JSON.stringify({ on: false }) }), "Kill switch off.");
$("#mode-enforcing").onclick = () => act(() => api("/api/governor-mode", { method: "POST", body: JSON.stringify({ mode: "enforcing" }) }), "Governor mode: ENFORCING.");
$("#mode-permissive").onclick = () => act(() => api("/api/governor-mode", { method: "POST", body: JSON.stringify({ mode: "permissive" }) }), "Governor mode: PERMISSIVE — blocks and parks are recorded, not enforced.");
$("#del-save").onclick = () => act(() => api("/api/approver-policy", { method: "POST", body: JSON.stringify({
  gusApprovesDelegates: $("#del-gus-delegates").checked, gusApprovesOwn: $("#del-gus-own").checked,
  delegatesMayApprove: $("#del-delegates").checked, scope: $("#del-scope").value,
  maxApprovalsPerHour: Number($("#del-max").value) }) }), "Delegation policy saved.");
$("#pv-kind").addEventListener("change", () => {
  const models = { gemini: "gemini-3.5-flash", anthropic: "claude-sonnet-5", openai: "gpt-5-mini", ollama: "llama3.1:8b", gateway: "llama3.1:8b", stub: "stub-v0" };
  $("#pv-model").value = models[$("#pv-kind").value] || "";
});
refresh().catch((e) => { $("#subtitle").textContent = "Could not load the panel: " + e.message; });
</script>
</body>
</html>
`;
