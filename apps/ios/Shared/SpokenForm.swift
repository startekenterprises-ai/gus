import Foundation

// Spoken form (v0.15.0 chunk 2) — the Swift port of the core's
// v0.14.7 transform (packages/channels/voice/src/spoken-form.ts),
// so a reply generated ON this phone is spoken by the same
// rules as one the core speaks: plain sentences, no spend-cap
// jargon, no bare token counts, record ids replaced by the
// words a person would use, no emoji or markdown. The rules
// below mirror the TS in order and intent; where the two ever
// disagree, the TS is the original and this is the copy — the
// header there explains the why (a Governor cap refusal was
// once read aloud verbatim, numbers and all).
//
// THE EXEMPTION, same as the original: approval read-backs
// (park notices, approve/deny resolutions) pass verbatim —
// the words heard are the words on the record. On-device mode
// has no approval surface yet, but the exemption is ported
// with the rest so the rule survives the trip.

enum SpokenForm {
    private static let capLine =
        "Heads up — I've hit my usage limit for today, so that stopped. " +
        "You can raise the limit in Settings, under Protection, Budget."
    private static let deniedLine = "That action was blocked by my safety rules, so it didn't run."
    private static let withheldLine =
        "I had a reply, but it was withheld because it looked like it contained a secret."
    private static let limitLine = "That hit a limit on my side, so it didn't finish."

    /// Sentences matching any of these are system bookkeeping,
    /// not conversation: dropped from spoken form. Deliberately
    /// narrow, exactly as the original.
    private static let jargon: [NSRegularExpression] = [
        regex("token cap", caseInsensitive: true),
        regex("per-day cap", caseInsensitive: true),
        regex("per-job cap", caseInsensitive: true),
        regex("spend cap", caseInsensitive: true),
        regex("cap_exceeded", caseInsensitive: true),
        regex("would be exceeded", caseInsensitive: true),
        regex("failed-loudly", caseInsensitive: true),
        regex("Governor cap", caseInsensitive: false),
        regex("the ledger shows", caseInsensitive: true),
        regex(#"\b\d[\d,]*\s+tokens\b"#, caseInsensitive: true),
    ]

    /// Record ids are unpronounceable; spoken, they become the noun.
    private static let idScrub: [(NSRegularExpression, String)] = [
        (regex(#"\bjob_[a-z0-9_]+\b"#, caseInsensitive: true), "the job"),
        (regex(#"\b(?:gus_)?rcpt_[0-9a-z]+\b"#, caseInsensitive: true), "a receipt"),
    ]

    private static let sentencePattern =
        regex(#"[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$"#, caseInsensitive: false)

    private static func regex(_ pattern: String, caseInsensitive: Bool) -> NSRegularExpression {
        // Patterns are literals in this file; a failure here is
        // a build-time bug, not a runtime condition.
        try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
    }

    /// The spoken form of a reply text. Pure; the input is the
    /// model's reply, the output is what the call actually says.
    static func apply(_ text: String) -> String {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return raw }

        // The approval read-back exemption.
        if raw.hasPrefix("⏸ Job parked") || raw.hasPrefix("✅ Approved") || raw.hasPrefix("🚫 Denied: ") {
            return raw
        }

        // Rule 1: whole-notice rewrites, keyed on the host
        // templates' openings — those strings are the contract.
        if raw.hasPrefix("💸 Governor cap reached") { return capLine }
        if raw.hasPrefix("🚫 Denied by the control plane") { return deniedLine }
        if raw.hasPrefix("[A reply was withheld by secret-guard") { return withheldLine }

        // Rule 2: the sentence pass. Matches tile the input, so
        // kept text is rejoined with NO separator — the original
        // spacing and punctuation survive byte-for-byte.
        let ns = raw as NSString
        let matches = sentencePattern.matches(in: raw, range: NSRange(location: 0, length: ns.length))
        let sentences = matches.isEmpty ? [raw] : matches.map { ns.substring(with: $0.range) }
        var kept: [String] = []
        var dropped = 0
        for s in sentences {
            let sentence = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if sentence.isEmpty { continue }
            if jargon.contains(where: { $0.firstMatch(in: sentence, range: NSRange(location: 0, length: (sentence as NSString).length)) != nil }) {
                dropped += 1
                continue
            }
            var out = s
            for (pattern, noun) in idScrub {
                out = pattern.stringByReplacingMatches(
                    in: out, range: NSRange(location: 0, length: (out as NSString).length),
                    withTemplate: noun)
            }
            kept.append(out)
        }
        if kept.isEmpty { return dropped > 0 ? limitLine : speechCleanup(raw) }
        return speechCleanup(kept.joined())
    }

    /// Split a reply into speakable sentences (the same tiling
    /// the sentence pass uses) — the local brain feeds the
    /// speech engine one sentence at a time, as the core does.
    static func sentences(of text: String) -> [String] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return [] }
        let ns = trimmed as NSString
        let matches = sentencePattern.matches(in: trimmed, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return [trimmed] }
        return matches
            .map { ns.substring(with: $0.range).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    /// Rule 3: speech cleanup — emoji, markdown emphasis, and
    /// code backticks never reach the synthesizer.
    private static func speechCleanup(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if scalar.value == 0xFE0E || scalar.value == 0xFE0F { continue }
            if scalar.properties.isEmojiPresentation { continue }
            if (0x1F000...0x1FAFF).contains(scalar.value) { continue }
            if (0x2600...0x27BF).contains(scalar.value) { continue }
            scalars.append(scalar)
        }
        var out = String(scalars)
        out = out.replacingOccurrences(of: "**", with: "")
        out = out.replacingOccurrences(of: "__", with: "")
        out = out.filter { $0 != "*" && $0 != "_" && $0 != "`" }
        if let headers = try? NSRegularExpression(pattern: #"(?m)^#{1,6}\s+"#) {
            out = headers.stringByReplacingMatches(
                in: out, range: NSRange(location: 0, length: (out as NSString).length),
                withTemplate: "")
        }
        out = out.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
