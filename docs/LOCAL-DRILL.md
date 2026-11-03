# Running the Phase 0 drill in the authoring VM (podman substitution)

The canonical Phase 0 artifacts are the Dockerfiles and
`packages/sandbox/docker-compose.yml`. The VM where Phase 0 was authored
cannot run a Docker daemon usefully:

- no `CAP_NET_ADMIN` in the nested user namespace (the process uid 0
  maps to a high host uid), so dockerd's network setup fails;
- `/sys/fs/cgroup` is a read-only cgroup2 mount;
- registry egress for dockerd is unavailable (the host reaches the
  internet through an authenticated egress proxy that was deliberately
  NOT wired into any container config).

So the drill was executed with an equivalent OCI stack:

- **podman 4.9.3 + crun 1.24** (static crun binary; the distro's 1.14
  was too old for `podman run` with these options).
- Containers run with `--userns=auto` (uid/gid mapping from
  `/etc/subuid|gid`), which grants `CAP_NET_ADMIN` *inside* the user
  namespace — enough to bring up loopback.
- A crun wrapper strips the cgroup configuration from the OCI bundle
  (cgroupfs is read-only here) and bind-mounts the host `/proc`
  read-only (a child user namespace cannot mount a fresh procfs over
  this host's locked overmounts).
- Registry pulls are unavailable, so the drill images were built on a
  locally assembled `gus-node-base:24-local` base (the host's Node
  24 + its shared libraries) via the Dockerfiles' `BASE` build arg.
  On any normal host the default `node:24-alpine` base is used.

- The drill's working directory was relocated with
  `DRILL_DIR=/var/tmp/gus-drill/phase0`: podman's `:U` bind-mount chown
  cannot operate on the workspace disk's file ownership in this VM.
  Evidence and metrics are copied back into `drill/phase0/` in the repo
  at the end of the run.

- The fake-transport harness files are pre-created mode 666 by the
  drill: in this VM the host harness and the container user are
  different uids, and the control plane (correctly) could not read a
  root-owned 0600/0660 inbound file. On a normal single-user Docker
  host the files are same-owner and this is a non-issue. The adapter
  now logs transport read failures (rate-limited) instead of spinning
  silently.
- `podman exec` cannot setns into containers in this VM, so the escape
  probes run as a fresh, identically-configured sandbox container
  sharing the comm + workspace volumes, rather than exec'ing into the
  live one. Same image, flags, and mounts; the assertions are the same.
- Container RSS is measured host-side (VmRSS summed over each
  container's process tree) because cgroup accounting is unavailable.

Consequences to keep in mind when reading the drill evidence:

- **CPU/RAM cgroup limits are declared but not enforced in this VM.**
  The ≤1 GB budget is therefore verified by *measured RSS*
  (`podman top`), and the compose `mem_limit` values are additionally
  checked statically by `npm run check:budget`.
- The sandbox's `/proc` is a read-only bind of the host proc; in
  production Docker it is a private procfs. The escape assertions the
  drill makes (no state dir, no network, read-only rootfs) are
  unaffected.
- Image *contents* are identical to the Docker build: same packed
  `dist-bundle/`, same entrypoints, same users, same hardening flags
  (read-only rootfs, `cap_drop: ALL`, `no-new-privileges`,
  `network_mode: none` for the sandbox).

# Phase 1 additions (credential red-team drill)

`test/promise/phase1-drill.sh` runs on the same vehicle, with three
further substitutions to know about when reading its evidence:

- **The "outside world" shares the control plane's container.** The
  drill's test API (127.0.0.1:8901) and attacker sink (127.0.0.2:8902)
  need to live in the control plane's network namespace (the proxy
  fetches loopback; the sandbox has no network). A second container
  cannot join that namespace here — `setns` across user namespaces is
  denied, the same limitation that rules out `podman exec` — so the
  test servers start inside the control-plane container via the
  drill-only entrypoint `test/fixtures/drill-entry.mjs` (packed into
  the bundle by `scripts/pack.mjs`; production entrypoint remains
  `main.js`). The proxy still crosses a real HTTP boundary, and the
  fixture's processes ride inside the control container's measured RSS
  (disclosed in the drill output; a few MB).
- **Vault encryption is ChaCha20-Poly1305, not age/XChaCha.** Node's
  built-in crypto provides `chacha20-poly1305` (12-byte nonce form)
  with no external dependency; the spec's property — authenticated
  encryption under an operator-held 0600 key file, ciphertext-only at
  rest — is unchanged. See `packages/vault/README.md`.
- **Container cleanup removes by ID.** A wedged never-started container
  in this environment can survive a name-based `podman rm -f` while
  reporting success; the Phase 1 drill resolves names to IDs and
  removes by ID.
- The podman vfs store on this VM's 2 GB `/var/tmp` tmpfs fills fast
  (every layer is a full copy): remove stale `gus-*` images before
  rebuilding, and `podman image prune` between build rounds.

# Phase 2 additions (Yue drill + runaway-cap drill)

`test/promise/phase2-drill.sh` runs on the same vehicle and the same
drill-entry test world as Phase 1. Phase-2-specific notes:

- **Three more operator state files** join the drill's state dir:
  `policy.json` (approval policy: bulk threshold, 12 s approval timeout
  chosen so the timeout section runs in drill time), `governor.json`
  (caps + price table; the drill rewrites it mid-run to tighten the
  per-task cap to $0.50 for the runaway section — legal because the
  Governor re-reads its config on every authorization, which is also
  how a real operator edit takes effect), and the stores the code
  creates (`approvals.jsonl`, `ledger.jsonl`).
- **The harness plays the operator on the real channel path:**
  approvals are resolved by appending Bot API-shaped `callback_query`
  updates (button presses) and `/approve <id>` message updates to the
  fake transport's inbound file — the same adapter parsing production
  uses. The Phase 1 drill gained the same helper: fetches naming a
  vault secret park under Phase 2 policy, so its harness now approves
  them before the original assertions run (all 29 Phase 1 checks are
  unchanged and green).
- **Exact cap arithmetic:** the stub provider is deterministic, so the
  comm server computes a call's exact tokens before authorizing;
  reservation estimate == settlement. The runaway section asserts from
  the ledger file itself: settled total $0.484 ≤ $0.50 cap, and
  $0.484 + the $0.05 steady per-call cost > $0.50 — the refused call is
  provably the first that would have exceeded the cap.
- **The runtime hop ceiling was raised 6 → 1000** as part of Phase 2:
  a hop counter is not the spend brake (the Governor is), and the
  runaway drill needs a loop that only the cap can stop. The ceiling
  remains as a liveness backstop.

# Phase 3 additions (bad-update drill)

`test/promise/phase3-drill.sh` runs on the same vehicle. Phase 3
changes the boot topology — the containers now run the slot
**launcher** (`packages/sandbox/launcher.mjs`, a fixed non-versioned
supervisor baked into the image) instead of a bare entrypoint:

- **Topology:** the control container's entrypoint is the fixture
  `test/fixtures/drill3-entry.mjs`, which starts the egress test
  servers and then the launcher in the control role — the test world
  must survive control-plane restarts, because promotion IS a
  control-plane restart. The sandbox container's entrypoint is the
  launcher in the sandbox role. Both launchers follow
  `<install>/current.json` on a new shared **install volume**
  (host dir mode 0777, sandbox mounts it `:ro`): slot A is seeded
  from the image on first boot; updates stage into slot B and the
  pointer flips. The images also still carry the legacy flat layout
  (default `ENTRYPOINT ["node","main.js"]`), which is what the
  Phase 0–2 drills boot — all three stay green on the same images.
- **Shared volumes must NOT use `:U`:** comm and install are mounted
  without it and pre-created mode 0777. A `:U` bind mount re-chowns
  the shared tree to whichever container mounted it last, in that
  container's userns range — the other container then gets EACCES on
  the comm socket (and `existsSync` returns false on EACCES, which
  made the control plane report "flat layout" while its pointer sat
  unreadable). Single-container volumes (state, run, apilog,
  workspace) keep `:U`, as in Phases 0–2.
- **Canary scratch workspace:** the sandbox launcher's canary child
  defaults to `/tmp/gus-canary-ws`; this vehicle's tmpfs is not
  writable by the container user, so the drill passes
  `GUS_CANARY_WORKSPACE=/workspace/.canary-ws` (the sandbox-owned
  volume). That EACCES caught a real bug, now fixed: the launcher
  treats canary setup failure as non-fatal (logs and skips) instead
  of dying and taking the live runtime's supervisor with it.
- **Releases are built host-side** with `test/fixtures/
  gen-update-key.mjs` (Ed25519 keypair; the PRIVATE key stays in the
  drill dir on the host and never enters a container) and
  `test/fixtures/make-release.mjs` (version-patches the packed
  `dist-bundle` — the stub greeting is the visible change — then
  signs a manifest). The public key is pinned into state as
  `update-pubkey.pem`. Four of the five drill releases are genuinely
  signed bad builds (crashy runtime, write-tamper, crashy control
  plane) plus one altered after signing: signature checks alone
  cannot catch a bad build, which is the point of the drill.
- **The fake-file transport now starts at end-of-file** on boot: a
  restarted control plane (promotion, watchdog rollback) must not
  replay the whole inbound transcript as new jobs.
- **Image store discipline in this VM:** `podman` here means
  `podman --storage-driver vfs --root /var/tmp/podman-root`, and
  /var/tmp is a 2 GB tmpfs in which vfs stores a full ~128 MB copy
  per image layer while buildah leaks its per-step containers
  ("identifier is not a container"). Builds therefore run in a
  second store on the roomy disk (`--root ~/podman-root`) and the
  finished images are transferred with `podman save`/`load` **one
  image at a time**: a combined two-image load aliased both tags
  onto the control image (the Phase 3 drill still passed — its
  launcher topology is image-agnostic — but the flat-entrypoint
  drills caught it). Verify each tag's image ID + Env after a load.
  `~/podman-root` is a build farm only; containers cannot run from
  it here (userdata chown fails on that filesystem).
