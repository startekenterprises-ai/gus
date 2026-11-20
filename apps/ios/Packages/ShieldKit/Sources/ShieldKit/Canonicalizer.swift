import Foundation

// Canonicalization (Gemini sharpening 1, panel 2026-11-20):
// text is un-escaped, decoded, and normalized BEFORE any rule
// sees it, so an obfuscated payload is judged as its plaintext.
// This is detect.ts's own normalization stack, ported 1:1 —
// zero-width stripping, homoglyph and leetspeak folding, ROT13,
// \uXXXX / \xXX escape decoding, de-JSON fragment joining,
// reversal, and base64 / hex blob decoding — plus one view
// detect.ts applies to URL query values and the panel wording
// asks for by name: percent-decoding. Decoded payloads are
// re-scanned by the scanner (see ShieldScanner), never trusted.

enum Canonicalizer {
    /// detect.ts MAX_CONTENT_CHARS: scanning is capped; the
    /// content hash on the receipt still covers the full text.
    static let maxScannedChars = 64_000

    static func truncated(_ text: String) -> String {
        guard text.count > maxScannedChars else { return text }
        return String(text.prefix(maxScannedChars))
    }

    /// The zero-width set detect.ts strips: U+200B–U+200D, U+FEFF.
    private static let zeroWidth: Set<Unicode.Scalar> = [
        "\u{200B}", "\u{200C}", "\u{200D}", "\u{FEFF}",
    ]

    static func stripZeroWidth(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars where !zeroWidth.contains(scalar) {
            out.append(scalar)
        }
        return String(out)
    }

    /// Zero-width-as-space (Barracuda dual-target phishing,
    /// Oct 2026): attackers REPLACE spaces with U+200B, so
    /// stripping yields one long token and defeats word
    /// boundaries. A space-restored view recovers the text.
    static func spaceZeroWidth(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            out.append(zeroWidth.contains(scalar) ? " " : scalar)
        }
        return String(out)
    }

    /// Cyrillic/Greek homoglyphs -> Latin equivalents
    /// (detect.ts HOMOGLYPH_MAP, verbatim).
    private static let homoglyphMap: [Unicode.Scalar: Unicode.Scalar] = [
        "\u{0430}": "a", "\u{0435}": "e", "\u{0456}": "i", "\u{043E}": "o",
        "\u{0440}": "p", "\u{0441}": "c", "\u{0445}": "x", "\u{0443}": "y",
        "\u{043A}": "k", "\u{043C}": "m", "\u{043D}": "h",
        "\u{03B1}": "a", "\u{03B5}": "e", "\u{03BF}": "o", "\u{03C1}": "p",
    ]

    static func normalizeHomoglyphs(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            out.append(homoglyphMap[scalar] ?? scalar)
        }
        return String(out)
    }

    /// Leetspeak -> plain letters (only the unambiguous
    /// substitutions, as in detect.ts).
    static func normalizeLeet(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.count)
        for ch in text {
            switch ch {
            case "0": out.append("o")
            case "1": out.append("i")
            case "3": out.append("e")
            case "4": out.append("a")
            case "5": out.append("s")
            case "7": out.append("t")
            case "@": out.append("a")
            case "$": out.append("s")
            default: out.append(ch)
            }
        }
        return out
    }

    /// ROT13 decode (detect.ts, verbatim behavior).
    static func rot13(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if scalar >= "a" && scalar <= "z" {
                out.append(Unicode.Scalar(UInt8((scalar.value - 97 + 13) % 26 + 97)))
            } else if scalar >= "A" && scalar <= "Z" {
                out.append(Unicode.Scalar(UInt8((scalar.value - 65 + 13) % 26 + 65)))
            } else {
                out.append(scalar)
            }
        }
        return String(out)
    }

    /// Decode literal \uXXXX / \xXX escape sequences into
    /// characters (detect.ts decodeUnicodeEscapes). Works on
    /// UTF-16 code units so surrogate pairs combine exactly as
    /// String.fromCharCode would combine them.
    static func decodeUnicodeEscapes(_ text: String) -> String {
        guard text.contains("\\u") || text.contains("\\x") else { return text }
        let units = Array(text.utf16)
        func hex(_ u: UInt16) -> UInt16? {
            switch u {
            case 48...57: return u - 48          // 0-9
            case 65...70: return u - 65 + 10     // A-F
            case 97...102: return u - 97 + 10    // a-f
            default: return nil
            }
        }
        var out: [UInt16] = []
        out.reserveCapacity(units.count)
        var i = 0
        while i < units.count {
            if units[i] == 0x5C, i + 1 < units.count {  // backslash
                if units[i + 1] == 0x75, i + 5 < units.count,  // 'u' + 4 hex
                   let a = hex(units[i + 2]), let b = hex(units[i + 3]),
                   let c = hex(units[i + 4]), let d = hex(units[i + 5]) {
                    out.append(a << 12 | b << 8 | c << 4 | d)
                    i += 6
                    continue
                }
                if units[i + 1] == 0x78, i + 3 < units.count,  // 'x' + 2 hex
                   let a = hex(units[i + 2]), let b = hex(units[i + 3]) {
                    out.append(a << 4 | b)
                    i += 4
                    continue
                }
            }
            out.append(units[i])
            i += 1
        }
        return String(utf16CodeUnits: out, count: out.count)
    }

    /// Percent-decode a view of the text (URL un-escaping):
    /// only when at least one valid %XX sequence exists, and
    /// only when the decoded bytes are valid UTF-8.
    static func percentDecodedView(_ text: String) -> String? {
        func hex(_ u: UInt8) -> UInt8? {
            switch u {
            case 48...57: return u - 48
            case 65...70: return u - 65 + 10
            case 97...102: return u - 97 + 10
            default: return nil
            }
        }
        let utf8 = Array(text.utf8)
        var bytes: [UInt8] = []
        bytes.reserveCapacity(utf8.count)
        var found = false
        var i = 0
        while i < utf8.count {
            if utf8[i] == 0x25, i + 2 < utf8.count,  // '%'
               let hi = hex(utf8[i + 1]), let lo = hex(utf8[i + 2]) {
                bytes.append(hi << 4 | lo)
                found = true
                i += 3
            } else {
                bytes.append(utf8[i])
                i += 1
            }
        }
        guard found else { return nil }
        return String(bytes: bytes, encoding: .utf8)
    }

    /// De-JSON: join string fragments split across array
    /// fields / keys, e.g. ["Disregard","the user's","request"]
    /// -> "Disregard the user's request" (detect.ts, verbatim).
    static func dejsonView(_ text: String) -> String {
        var out = text
        if let re = try? NSRegularExpression(pattern: "\"\\s*,\\s*\"") {
            out = re.stringByReplacingMatches(
                in: out, range: NSRange(out.startIndex..., in: out), withTemplate: " ")
        }
        out = out.replacingOccurrences(of: "{", with: " ")
            .replacingOccurrences(of: "}", with: " ")
            .replacingOccurrences(of: "[", with: " ")
            .replacingOccurrences(of: "]", with: " ")
        out = out.replacingOccurrences(of: "\\\"", with: "\"")
        return out
    }

    /// Build the set of text views to score: raw + normalized
    /// variants (detect.ts textViews, same order, deduplicated
    /// preserving order). Index 0 is always the text itself.
    static func textViews(_ text: String) -> [String] {
        var views = [text]
        let noZw = stripZeroWidth(text)
        if noZw != text { views.append(noZw) }
        let noZwSpaced = spaceZeroWidth(text)
        if noZwSpaced != text && noZwSpaced != noZw { views.append(noZwSpaced) }
        views.append(normalizeHomoglyphs(noZw))
        views.append(normalizeLeet(noZw))
        views.append(rot13(noZw))
        let unescaped = decodeUnicodeEscapes(noZw)
        if unescaped != noZw { views.append(unescaped) }
        if let pct = percentDecodedView(noZw), pct != noZw { views.append(pct) }
        // Reversed text: attackers reverse the whole payload.
        views.append(String(noZw.reversed()))
        let dejson = dejsonView(noZw)
        if dejson != noZw { views.append(dejson) }
        var seen = Set<String>()
        return views.filter { seen.insert($0).inserted }
    }

    /// Base64-ish blobs worth decoding (detect.ts B64_RE).
    static let base64BlobPattern = "[A-Za-z0-9+/]{40,}={0,2}"

    /// Decode a base64 blob, keeping only plausible text
    /// (detect.ts tryB64Decode).
    static func tryBase64Decode(_ blob: String) -> String? {
        var padded = blob
        while padded.count % 4 != 0 { padded.append("=") }
        guard let data = Data(base64Encoded: padded) else { return nil }
        guard let out = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .ascii),
              out.count >= 10 else { return nil }
        // Keep only plausible text: printable ASCII + whitespace.
        guard out.unicodeScalars.allSatisfy({ $0.value == 9 || $0.value == 10 || $0.value == 13 || ($0.value >= 0x20 && $0.value <= 0x7E) }) else { return nil }
        return out
    }

    /// Try hex decode of long hex runs (detect.ts tryHexDecode).
    static func tryHexDecode(_ s: String) -> String? {
        var compact = s.replacingOccurrences(of: "0x", with: "")
        compact = compact.replacingOccurrences(of: "0X", with: "")
        compact = compact.filter { !$0.isWhitespace }
        guard compact.count >= 40, compact.count % 2 == 0,
              compact.allSatisfy({ $0.isHexDigit }) else { return nil }
        var bytes: [UInt8] = []
        bytes.reserveCapacity(compact.count / 2)
        var idx = compact.startIndex
        while idx < compact.endIndex {
            let next = compact.index(idx, offsetBy: 2)
            guard let byte = UInt8(compact[idx..<next], radix: 16) else { return nil }
            bytes.append(byte)
            idx = next
        }
        guard let out = String(bytes: bytes, encoding: .utf8), out.count >= 10,
              out.unicodeScalars.allSatisfy({ $0.value == 9 || $0.value == 10 || $0.value == 13 || ($0.value >= 0x20 && $0.value <= 0x7E) })
        else { return nil }
        return out
    }

    /// Hex blob pattern (detect.ts HEX_RE).
    static let hexBlobPattern = "(?:0x[0-9a-fA-F]{2}(?:\\s*0x[0-9a-fA-F]{2}){10,}|[0-9a-fA-F]{40,})"
}
