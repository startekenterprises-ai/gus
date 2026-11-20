# The secret-guard demo — run it yourself

**Status: launch asset. Reproducible today against the local stack.**

The demo: you paste what looks like an AWS key into the chat. GUS
refuses it — warns you, creates no job, stores nothing, and the key
string ends up *nowhere* on disk. Then you grep the entire state to
prove it. Takes about two minutes once the images are built.

The key used below is the project's published synthetic test key. It
is not a real credential — it exists so this demo can be public.

## Steps

1. Build and start the two containers (same as the Phase 0 drill):

   ```sh
   npm install && npm run build && npm run pack
   docker build -f packages/sandbox/Dockerfile.control -t gus-control:dev .
   docker build -f packages/sandbox/Dockerfile.agent   -t gus-agent:dev .
   ```

2. Run the Phase 0 drill and watch section 6 (it performs exactly
   this sequence against the fake-file channel):

   ```sh
   bash test/promise/phase0-drill.sh
   ```

   Or drive it by hand: start the stack from the drill's harness (or
   your own install), then append one line to the channel's inbound
   file — a chat message whose text is the pasted key:

   ```sh
   echo '{"update_id":99,"message":{"message_id":99,"date":1730000000,"text":"my aws key is <redacted> — can you store it?","chat":{"id":4242},"from":{"id":4242}}}' \
     >> drill/phase0/run/inbound.ndjson
   ```

3. Read what comes back (the outbound file is "what the user sees"):

   ```sh
   cat drill/phase0/run/outbound.ndjson
   ```

   You will see, verbatim:

   > ⚠️ That looked like a secret (aws_key), so I refused it: it was
   > not forwarded, stored, or added to the agent's context. If it was
   > real, rotate it now — I can't unsend what other people in this
   > chat may already have seen.

4. Prove the negative — the key exists nowhere in GUS's world:

   ```sh
   grep -r "AKIAGUSTEST123456789" drill/phase0/state drill/phase0/run/outbound.ndjson
   # → no matches. The only trace is the redacted form:
   grep -o "\[secret refused: aws_key\]" drill/phase0/state/guard.jsonl
   ```

## What this proves (and what it doesn't)

- Proves: channel ingress screening with the same S1 detector
  patterns the scanner ships; refusal is structural (no job is
  created, the runtime never sees the text), not a polite model
  behavior; every store — jobs, logs, outbound transcript — holds
  only the redacted form.
- Doesn't prove: that every secret shape is caught. The detector is
  pattern-based (the same honesty as the scanner's published
  benchmarks). Unknown formats can slip; anything caught is refused
  completely. And the warning's last line is load-bearing: if you
  paste a real secret into a group chat, other humans may already
  have it — GUS can only stop *itself* from propagating it.

Demo video script (for the launch post): terminal on the left, the
outbound transcript on the right; paste the key at 0:10; the warning
lands; the grep at 0:40 returns nothing. No narration needed until
the last line: *"Your agent should refuse your passwords. GUS does."*
