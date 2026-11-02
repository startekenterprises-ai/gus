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
