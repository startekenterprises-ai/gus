import Foundation
import LLM

// The on-device brain (v0.15.0 chunk 2) — the call's other
// engine room. In on-device mode a local LLM answers turns on
// this iPhone: no network, airplane-mode capable, nothing
// leaves the phone. Runtime: llama.cpp through LLM.swift
// (MIT, pinned exact in the project), running the manifest's
// GGUF (Qwen3-4B-Instruct-2507 Q4_K_M — a 4B-class Apache-2.0
// instruct model; the largest class that runs WELL on a Pro
// Max, per the spec's RAM/thermal reasoning).
//
// Shape of a turn: tokens stream → complete sentences are cut
// as they land → each sentence passes SpokenForm (the same
// rules the core applies) → the call speaks it while the rest
// of the reply is still generating. First words arrive in
// well under a second of generation instead of after the whole
// reply — the difference between a call and a walkie-talkie.
//
// Honest limits: a 4B is a conversationalist, not the
// workshop (the spec says it plainly) — it chats, pitches,
// and answers; tools and multi-step jobs are Core mode's work.
// Sustained generation warms the phone; long calls throttle.

final class LocalBrain {
    /// Which self-description the brain carries (v0.20.0).
    /// The DEFAULT is the general-purpose prompt below. The
    /// email pitch was this brain's only prompt through
    /// v0.19.0 — M2's self-pitch was its demo job — and it
    /// biased every ordinary conversation toward email
    /// security. The pitch survives as the Gmail demo's
    /// prompt: demo mode (the Settings toggle, persisted
    /// here) selects it, and everything else gets the
    /// general one. The choice is read when the brain loads;
    /// the call and the chat each load the brain once and
    /// keep it, so flipping the toggle takes effect the
    /// next time the app starts.
    static var demoPitchEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "gus.brain.demoPitch") }
        set { UserDefaults.standard.set(newValue, forKey: "gus.brain.demoPitch") }
    }

    static var activePrompt: String {
        demoPitchEnabled ? emailDemoPrompt : generalPrompt
    }

    /// The general-purpose default (v0.20.0): spoken answers,
    /// plain words, GUS's character — a private agent on the
    /// person's own devices, its work on a signed record —
    /// and no product pitch in its pocket.
    static let generalPrompt = """
        You are GUS, a secure, open-source AI agent who lives on the \
        person's own devices. You are speaking out loud in a live phone \
        call, so every reply must sound like natural speech: one to three \
        short sentences, plain everyday words, no lists, no markdown, no \
        code. Be warm, direct, and helpful: answer what was asked, ask a \
        short question back when something is unclear, and say plainly \
        when you don't know something instead of inventing it. If asked \
        what you are or what you do, say this in your own words: you are \
        a private assistant that runs on the person's own hardware, so \
        their words stay on their devices — and everything you do for \
        them is written into a signed record they can check, so nothing \
        happens behind their back, and anything that matters waits for \
        their say-so. Keep answers short; the person can always ask \
        for more.
        """

    /// The Gmail demo's prompt: the adopted two-pains pitch,
    /// in its own words rather than recited. Selected only
    /// in demo mode (see demoPitchEnabled above); through
    /// v0.19.0 this was the brain's only prompt.
    static let emailDemoPrompt = """
        You are GUS, a secure, open-source AI agent. You are speaking out loud \
        in a live phone call, so every reply must sound like natural speech: \
        one to three short sentences, plain everyday words, no lists, no \
        markdown, no code. If asked what you are or what you do, say this in \
        your own words: most AI agents leave people with two pains — an \
        overflowing email inbox, and no way to see what the agent actually \
        did. GUS fixes both: it works through your email overnight, archives \
        but never deletes, never sends anything without your tap, and keeps a \
        signed receipt for every action, so you can check everything it did. \
        Keep answers short; the person can always ask for more.
        """

    private let bot: LLM

    /// Fails (nil) when the model file can't be loaded — the
    /// caller treats that as "on-device mode unavailable",
    /// never as a silent dead end.
    init?(modelURL: URL) {
        guard let bot = LLM(
            from: modelURL,
            template: .chatML(LocalBrain.activePrompt),
            temp: 0.7,
            historyLimit: 40,
            maxTokenCount: 4096
        ) else { return nil }
        self.bot = bot
    }

    /// Cut generation short — barge-in's other half (the call
    /// also cuts the speech itself).
    func stop() {
        bot.stop()
    }

    /// Answer one turn. `onSentence` fires per completed
    /// sentence, already in spoken form, as generation streams;
    /// it is called from the generation task, NOT the main
    /// actor. Returns the full reply as spoken (the turn
    /// record's text) once generation ends.
    func respond(to input: String, onSentence: @escaping (String) -> Void) async -> String {
        let splitter = SentenceSplitter()
        let box = ReplyBox()
        await bot.respond(to: input) { stream in
            var think = ThinkGuard()
            for await delta in stream {
                box.raw += delta
                for sentence in think.feed(delta, into: splitter) {
                    box.spoken += (box.spoken.isEmpty ? "" : " ") + sentence
                    onSentence(sentence)
                }
            }
            if let last = splitter.flush() {
                let spokenLast = SpokenForm.apply(last)
                if !spokenLast.isEmpty {
                    box.spoken += (box.spoken.isEmpty ? "" : " ") + spokenLast
                    onSentence(spokenLast)
                }
            }
            return box.spoken
        }
        if box.spoken.isEmpty {
            // Nothing survived the sentence pass (e.g. a reply
            // that was all system jargon): the whole-text rules
            // decide what is said — the limit line, never silence.
            let whole = SpokenForm.apply(box.raw)
            if !whole.isEmpty {
                box.spoken = whole
                onSentence(whole)
            }
        }
        return box.spoken
    }
}

/// The streaming closure's catch-box: what the model wrote
/// (raw) and what was actually spoken (spoken form), kept
/// apart exactly as the core keeps them apart.
private final class ReplyBox {
    var raw = ""
    var spoken = ""
}

/// Suppresses <think>…</think> spans from the spoken stream.
/// The shipped brain (Instruct-2507) doesn't emit them; the
/// downloadable library may hold models that do, and reasoning
/// must never be read aloud. Partial tags straddling deltas
/// are held back until they resolve.
private struct ThinkGuard {
    private var holding = ""
    private var inThink = false

    mutating func feed(_ delta: String, into splitter: SentenceSplitter) -> [String] {
        holding += delta
        var out: [String] = []
        while true {
            if inThink {
                if let range = holding.range(of: "</think>") {
                    holding = String(holding[range.upperBound...])
                    inThink = false
                    continue
                }
                // Keep only a possible partial closing tag.
                if holding.count > 8 { holding = String(holding.suffix(8)) }
                return out
            }
            if let range = holding.range(of: "<think>") {
                let before = String(holding[..<range.lowerBound])
                out += splitter.feed(before)
                holding = String(holding[range.upperBound...])
                inThink = true
                continue
            }
            // Hold back a trailing partial "<think" prefix.
            var safe = holding
            var holdCount = 0
            for n in stride(from: min(6, holding.count), through: 1, by: -1) {
                if "<think>".hasPrefix(String(holding.suffix(n))) {
                    holdCount = n
                    break
                }
            }
            if holdCount > 0 {
                safe = String(holding.dropLast(holdCount))
                holding = String(holding.suffix(holdCount))
            } else {
                holding = ""
            }
            out += splitter.feed(safe)
            return out
        }
    }
}

/// Cuts a token stream into sentences. A sentence is emitted
/// only once text AFTER its terminator has arrived (proof it
/// really ended — a trailing "3." may still become "3.5"), or
/// at flush() when the stream ends. Emitted sentences pass
/// SpokenForm here so every consumer hears the spoken rules.
private final class SentenceSplitter {
    private var pending = ""

    func feed(_ text: String) -> [String] {
        pending += text
        var out: [String] = []
        while let cut = firstProvenSentenceEnd(in: pending) {
            let raw = String(pending[..<cut])
            pending = String(pending[cut...])
            let spoken = SpokenForm.apply(raw)
            if !spoken.isEmpty { out.append(spoken) }
        }
        return out
    }

    func flush() -> String? {
        let rest = pending.trimmingCharacters(in: .whitespacesAndNewlines)
        pending = ""
        return rest.isEmpty ? nil : rest
    }

    /// Index just past the first sentence whose terminator is
    /// followed by more non-space text, or nil if no sentence
    /// is proven complete yet.
    private func firstProvenSentenceEnd(in text: String) -> String.Index? {
        var i = text.startIndex
        while i < text.endIndex {
            let ch = text[i]
            if ch == "." || ch == "!" || ch == "?" {
                var j = text.index(after: i)
                // Closing quotes/brackets ride the sentence.
                while j < text.endIndex, "\"')\u{201D}]".contains(text[j]) {
                    j = text.index(after: j)
                }
                // Proven complete only if real text follows.
                var k = j
                while k < text.endIndex, text[k] == " " || text[k] == "\n" {
                    k = text.index(after: k)
                }
                if k < text.endIndex {
                    return j
                }
                return nil
            }
            i = text.index(after: i)
        }
        return nil
    }
}
