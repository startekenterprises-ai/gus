import CryptoKit
import Foundation

// The deterministic Shield scanner — a faithful Swift port of
// the production engine in agent-shield-connector/worker/src/
// detect.ts (analyzer "heuristic_v5"). Same leak patterns, same
// SSRF taxonomy, same injection signals and weights, same
// dampening and combination bonuses, same medium-sensitivity
// thresholds (malicious 0.85 / suspicious 0.40), same verdict
// mapping (malicious -> block, suspicious -> review, clean ->
// allow; here review is named quarantine). No new rules were
// invented and the semantic stage was NOT ported.
//
// Faithfulness notes:
//  - JS \d is ASCII-only; ICU \d is not. Every \d in detect.ts
//    is written [0-9] here — the faithful translation.
//  - detect.ts resolves URL hostnames over DNS and classifies
//    the answers. A phone scanner is offline and must answer in
//    milliseconds, so a non-literal hostname is classified
//    "unresolved" (risk 0, finding recorded) — exactly the
//    outcome detect.ts produces when resolution returns
//    nothing. IP literals, metadata hosts, shorteners,
//    loopback names, and file:// URLs are classified locally,
//    exactly as in production.
//  - Raw sensitive content is never echoed into findings:
//    findings carry { class, count, detail } only, and the
//    receipt carries a short content hash, never the text.

public struct ShieldFinding: Sendable {
    public let name: String
    public let count: Int
    public let detail: String?

    public init(name: String, count: Int, detail: String? = nil) {
        self.name = name
        self.count = count
        self.detail = detail
    }
}

public struct ShieldScores: Sendable {
    public let promptInjection: Double
    public let secretsExposure: Double
    public let piiDisclosure: Double
    public let ssrfRisk: Double

    public var peak: Double {
        max(promptInjection, secretsExposure, piiDisclosure, ssrfRisk)
    }
}

public struct ShieldScanResult: Sendable {
    /// The verdict the app acts on (posture applied).
    public let verdict: ShieldVerdict
    /// What the rules concluded, before posture.
    public let rulesVerdict: ShieldRawVerdict
    public let posture: ShieldPosture
    /// The rule that drove the verdict, e.g.
    /// "prompt_injection:concealment_directive", "secrets:aws_key",
    /// "ssrf:cloud_metadata" — or "clean" / "unevaluable".
    public let primaryRuleID: String
    public let findings: [ShieldFinding]
    public let scores: ShieldScores
    /// First 16 hex chars of the content's SHA-256 — audit
    /// correlation, never the content.
    public let contentHash: String
    public let rulesVersion: String
}

public enum ShieldScanner {
    public static var rulesVersion: String { shieldRulesVersion }

    // detect.ts SENSITIVITY_THRESHOLDS.medium — the production
    // default sensitivity.
    private static let maliciousThreshold = 0.85
    private static let suspiciousThreshold = 0.40

    public static func scan(_ text: String, posture: ShieldPosture) -> ShieldScanResult {
        let contentHash = shortContentHash(text)
        guard Patterns.allValid else {
            // The scanner itself cannot evaluate (a bundled
            // pattern failed to compile): un-evaluable input,
            // answered by posture — quarantine in Standard,
            // block in Strict, warn-and-log in Permissive.
            // Never a silent pass.
            let raw = ShieldRawVerdict.unevaluable
            return ShieldScanResult(
                verdict: posture.effectiveVerdict(for: raw),
                rulesVerdict: raw,
                posture: posture,
                primaryRuleID: "unevaluable",
                findings: [],
                scores: ShieldScores(promptInjection: 0, secretsExposure: 0, piiDisclosure: 0, ssrfRisk: 0),
                contentHash: contentHash,
                rulesVersion: shieldRulesVersion)
        }

        let scanText = Canonicalizer.truncated(text)
        let cleaned = Canonicalizer.stripZeroWidth(scanText)

        // 1. Secrets / PII (deterministic patterns) — on the raw
        // text, plus base64-decoded blobs merged in (an encoded
        // secret counts like its plaintext; detect.ts day-37).
        var leakCounts = scanLeaks(scanText)
        for blob in blobMatches(in: cleaned) {
            guard let decoded = Canonicalizer.tryBase64Decode(blob) else { continue }
            mergeLeakCounts(&leakCounts, scanLeaks(decoded))
        }
        var findings: [ShieldFinding] = leakCounts.map {
            ShieldFinding(name: $0.name, count: $0.count)
        }
        let countOf = { (name: String) in leakCounts.first(where: { $0.name == name })?.count ?? 0 }
        let ssnN = countOf("ssn")
        let ccN = countOf("credit_card")
        var piiScore = 0.0
        if ssnN > 0 || ccN > 0 {
            piiScore = min(1, 0.6 + 0.2 * Double(max(ssnN, ccN)))
        }
        let secretClasses = ["aws_key", "aws_secret_key", "github_token", "pem_key", "generic_secret", "unquoted_secret_assignment"]
        let secretTotal = secretClasses.reduce(0) { $0 + countOf($1) }
        var secretsScore = 0.0
        if secretTotal > 0 {
            secretsScore = min(1, 0.7 + 0.15 * Double(secretTotal))
        }

        // 2. SSRF: extract URLs, classify destinations.
        let ssrf = scanSSRF(scanText)
        findings.append(contentsOf: ssrf.findings)

        // 3. Prompt-injection heuristics.
        let injection = scoreInjection(scanText)
        for signal in injection.signals {
            findings.append(ShieldFinding(name: "prompt_injection_signal", count: 1, detail: signal))
        }

        let scores = ShieldScores(
            promptInjection: injection.score,
            secretsExposure: secretsScore,
            piiDisclosure: piiScore,
            ssrfRisk: ssrf.risk)
        let peak = scores.peak
        let raw: ShieldRawVerdict =
            peak >= maliciousThreshold ? .block :
            peak >= suspiciousThreshold ? .quarantine : .allow

        // The rule that drove the verdict: the category that
        // reached the peak, in detect.ts ScanScores field order.
        let primaryRuleID: String
        if raw == .allow {
            primaryRuleID = "clean"
        } else if scores.promptInjection == peak, let signal = injection.primarySignal {
            primaryRuleID = "prompt_injection:\(signal)"
        } else if scores.secretsExposure == peak,
                  let cls = secretClasses.first(where: { countOf($0) > 0 }) {
            primaryRuleID = "secrets:\(cls)"
        } else if scores.piiDisclosure == peak {
            primaryRuleID = "pii:\(ssnN > 0 ? "ssn" : "credit_card")"
        } else if let cls = ssrf.worstClass {
            primaryRuleID = "ssrf:\(cls)"
        } else {
            primaryRuleID = "clean"
        }

        return ShieldScanResult(
            verdict: posture.effectiveVerdict(for: raw),
            rulesVerdict: raw,
            posture: posture,
            primaryRuleID: primaryRuleID,
            findings: findings,
            scores: scores,
            contentHash: contentHash,
            rulesVersion: shieldRulesVersion)
    }

    private static func shortContentHash(_ text: String) -> String {
        let digest = SHA256.hash(data: Data(text.utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(16))
    }

    // MARK: - Regex plumbing

    private static func compile(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern, options: options)
    }

    private static func allMatches(_ re: NSRegularExpression?, in text: String) -> [NSTextCheckingResult] {
        guard let re else { return [] }
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text))
    }

    private static func firstMatch(_ re: NSRegularExpression?, in text: String) -> NSTextCheckingResult? {
        guard let re else { return nil }
        return re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
    }

    private static func matchedString(_ result: NSTextCheckingResult, group: Int, in text: String) -> String? {
        guard group < result.numberOfRanges else { return nil }
        let range = result.range(at: group)
        guard range.location != NSNotFound, let swiftRange = Range(range, in: text) else { return nil }
        return String(text[swiftRange])
    }

    private static func blobMatches(in text: String) -> [String] {
        allMatches(Patterns.base64Blob, in: text).compactMap { matchedString($0, group: 0, in: text) }
    }

    // MARK: - Leak patterns (detect.ts LEAK_PATTERNS, verbatim)

    private struct LeakRule {
        let name: String
        let re: NSRegularExpression?
        let luhn: Bool
        let grouped: Bool  // value lives in capture group 1
    }

    private static let leakRules: [LeakRule] = [
        LeakRule(name: "ssn", re: compile(#"\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b"#), luhn: false, grouped: false),
        LeakRule(name: "credit_card", re: compile(#"\b[0-9]{13,19}\b"#), luhn: true, grouped: false),
        LeakRule(name: "aws_key", re: compile(#"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"#), luhn: false, grouped: false),
        LeakRule(
            name: "aws_secret_key",
            re: compile(#"\baws_secret(?:_access)?_key\b\s*[:=]\s*\\?["']([A-Za-z0-9_\-+/=]{20,})\\?["']"#, .caseInsensitive),
            luhn: false, grouped: true),
        LeakRule(name: "github_token", re: compile(#"\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{22,}\b"#), luhn: false, grouped: false),
        LeakRule(name: "pem_key", re: compile(#"-----BEGIN [A-Z ]*PRIVATE KEY-----"#), luhn: false, grouped: false),
        LeakRule(
            name: "generic_secret",
            re: compile(#"\b(?:password|passwd|secret|secretKey|api[_-]?key|auth[_-]?token|access[_-]?token)\b\\?["']?\s*[:=]\s*\\?["']([A-Za-z0-9_\-+/=]{20,})\\?["']"#, .caseInsensitive),
            luhn: false, grouped: true),
        LeakRule(
            name: "unquoted_secret_assignment",
            re: compile(#"\b(?:aws_access_key_id|password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|key(?:\s+i\s+used)?)\b\s*[:=]\s*(?=[A-Za-z0-9_\-+/=]*[A-Z])(?=[A-Za-z0-9_\-+/=]*[0-9])[A-Za-z0-9_\-+/=]{16,}\b"#, .caseInsensitive),
            luhn: false, grouped: false),
    ]

    /// Documentation placeholders that must never count as
    /// leaked secrets (detect.ts SECRET_ALLOWLIST, verbatim).
    private static let secretAllowlist: Set<String> = [
        "AKIAIOSFODNN7EXAMPLE",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "EXAMPLEKEY",
        "YOUR_TOKEN_HERE",
        "FAKE_KEY_MATERIAL_FOR_PARSER_TESTS",
    ]

    private static func luhnOk(_ digits: String) -> Bool {
        let chars = Array(digits)
        var total = 0
        for i in 0..<chars.count {
            guard var d = chars[chars.count - 1 - i].wholeNumberValue else { return false }
            if i % 2 == 1 {
                d *= 2
                if d > 9 { d -= 9 }
            }
            total += d
        }
        return total % 10 == 0
    }

    private static func scanLeaks(_ text: String) -> [(name: String, count: Int)] {
        var out: [(name: String, count: Int)] = []
        for rule in leakRules {
            var n = 0
            for match in allMatches(rule.re, in: text) {
                let value = (rule.grouped ? matchedString(match, group: 1, in: text) : nil)
                    ?? matchedString(match, group: 0, in: text) ?? ""
                if secretAllowlist.contains(value) { continue }
                if rule.luhn && !luhnOk(value) { continue }
                n += 1
            }
            if n > 0 { out.append((rule.name, n)) }
        }
        return out
    }

    private static func mergeLeakCounts(
        _ into: inout [(name: String, count: Int)],
        _ more: [(name: String, count: Int)]
    ) {
        for entry in more {
            if let idx = into.firstIndex(where: { $0.name == entry.name }) {
                into[idx].count += entry.count
            } else {
                into.append(entry)
            }
        }
    }
}

// MARK: - Compiled patterns

private enum Patterns {
    static let base64Blob = ShieldScanner.compileForStore(Canonicalizer.base64BlobPattern)
    static let hexBlob = ShieldScanner.compileForStore(Canonicalizer.hexBlobPattern)
    static let url = ShieldScanner.compileForStore(#"https?://[^\s"'<>`]+"#, .caseInsensitive)
    static let fileURL = ShieldScanner.compileForStore(#"file://[^\s"'<>`]+"#, .caseInsensitive)
    static let zoneStrip = ShieldScanner.compileForStore(#"\[([0-9A-Fa-f:.]+)(?:%25|%)[^\]]*\]"#)
    static let defangScheme = ShieldScanner.compileForStore(#"\bhxxps?://"#, .caseInsensitive)
    static let defangDot = ShieldScanner.compileForStore(#"\(\s*dot\s*\)"#, .caseInsensitive)
    static let dottedQuad = ShieldScanner.compileForStore(#"^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$"#)
    static let dottedQuadGroups = ShieldScanner.compileForStore(#"^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$"#)
    static let loopbackSensitivePath = ShieldScanner.compileForStore(
        #"\/(admin|internal|metrics|debug|actuator|console|management|private|config|env|heapdump|server-status)([\/\-_]|$)"#,
        .caseInsensitive)
    static let attribution = ShieldScanner.compileForStore(
        #"(says?|said|wrote|writes?|according\s+to|for\s+example|such\s+as|e\.g\.|called|titled|article|write-?up|documentation|quoting|quote)[\s\S]{0,120}["“”]|["“”][^"“”]{0,300}["“”]\s*(says?|writes?|notes?|explains?)"#,
        .caseInsensitive)
    static let educational = ShieldScanner.compileForStore(
        #"for\s+educational\s+purposes|do\s+not\s+execute|example\s+of\s+what\s+not\s+to\s+do|threat\s+briefing|security\s+(article|training|policy|write-?up)|ctf\s+write-?up|documentation\s+sample|in\s+this\s+write-?up|defense\s+against"#,
        .caseInsensitive)
    static let externalContact = ShieldScanner.compileForStore(
        #"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|https?://[^\s"'<>`]+"#,
        .caseInsensitive)

    static var allValid: Bool {
        base64Blob != nil && hexBlob != nil && url != nil && fileURL != nil
            && zoneStrip != nil && defangScheme != nil && defangDot != nil
            && dottedQuad != nil && dottedQuadGroups != nil
            && loopbackSensitivePath != nil && attribution != nil
            && educational != nil && externalContact != nil
            && ShieldScanner.injectionSignals.allSatisfy { $0.re != nil }
    }
}

extension ShieldScanner {
    fileprivate static func compileForStore(
        _ pattern: String, _ options: NSRegularExpression.Options = []
    ) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern, options: options)
    }
}

// MARK: - SSRF (detect.ts Addendum A, ported)

extension ShieldScanner {
    private static let maxURLs = 50

    private static let ssrfRisk: [String: Double] = [
        "cloud_metadata": 1.0,
        "loopback": 0.9,
        "local_file": 0.9,
        "link_local": 0.8,
        "private": 0.7,
        "reserved": 0.6,
        "multicast": 0.6,
        "url_shortener": 0.4,
        "public": 0.05,
        "invalid": 0.0,
        "unresolved": 0.0,
    ]

    /// Well-known cloud metadata hostnames (detect.ts
    /// METADATA_HOSTS, verbatim).
    private static let metadataHosts: [String: String] = [
        "metadata.google.internal": "cloud_metadata",
        "instance-data-compute-internal": "cloud_metadata",
    ]

    /// Well-known public URL shorteners (detect.ts
    /// URL_SHORTENER_HOSTS, verbatim).
    private static let urlShortenerHosts: Set<String> = [
        "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd",
        "buff.ly", "shorturl.at", "rb.gy", "cutt.ly", "tiny.cc",
        "rebrand.ly", "lnkd.in", "t2m.io", "bl.ink", "soo.gd", "v.gd",
        "qr.ae", "u.to", "t.ly", "shorte.st", "adf.ly",
    ]

    /// Normalize common URL defanging (hxxp, [.] , (dot)) so
    /// obfuscated SSRF targets are still extracted and
    /// classified (detect.ts normalizeDefanged).
    private static func normalizeDefanged(_ text: String) -> String {
        var out = text
        if let re = Patterns.defangScheme {
            out = re.stringByReplacingMatches(
                in: out, range: NSRange(out.startIndex..., in: out), withTemplate: "http://")
        }
        out = out.replacingOccurrences(of: "[.]", with: ".")
        if let re = Patterns.defangDot {
            out = re.stringByReplacingMatches(
                in: out, range: NSRange(out.startIndex..., in: out), withTemplate: ".")
        }
        return out
    }

    private struct URLCandidate {
        let host: String
        let path: String
        let key: String
    }

    /// Manual scheme/authority/path split — deliberately NOT
    /// Foundation's URL parser, whose normalization differs
    /// from the WHATWG behavior detect.ts classifies against.
    /// The host substring is classified by the taxonomy below,
    /// which itself normalizes hex/octal/decimal IP spellings.
    private static func parseCandidate(_ raw0: String) -> URLCandidate? {
        var raw = String(raw0.prefix(2048))
        // IPv6 zone identifier: strip the zone from bracketed
        // literals so classification sees the real address.
        if let re = Patterns.zoneStrip {
            raw = re.stringByReplacingMatches(
                in: raw, range: NSRange(raw.startIndex..., in: raw), withTemplate: "[$1]")
        }
        guard let schemeEnd = raw.range(of: "://") else { return nil }
        let rest = raw[schemeEnd.upperBound...]
        let authEnd = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) ?? rest.endIndex
        var authority = String(rest[..<authEnd])
        var path = "/"
        if authEnd < rest.endIndex, rest[authEnd] == "/" {
            let tail = rest[authEnd...]
            let pathEnd = tail.firstIndex(where: { $0 == "?" || $0 == "#" }) ?? tail.endIndex
            path = String(tail[..<pathEnd])
            if path.isEmpty { path = "/" }
        }
        var host: String
        var port: String?
        if authority.hasPrefix("[") {
            guard let close = authority.firstIndex(of: "]") else { return nil }
            host = String(authority[authority.index(after: authority.startIndex)..<close])
            if let pct = host.firstIndex(of: "%") { host = String(host[..<pct]) }
            let after = authority[authority.index(after: close)...]
            if after.hasPrefix(":") { port = String(after.dropFirst()) }
        } else {
            if let at = authority.lastIndex(of: "@") {
                authority = String(authority[authority.index(after: at)...])
            }
            if let colon = authority.lastIndex(of: ":") {
                let suffix = authority[authority.index(after: colon)...]
                if !suffix.isEmpty, suffix.allSatisfy({ $0.isNumber }) {
                    host = String(authority[..<colon])
                    port = String(suffix)
                } else {
                    host = authority
                }
            } else {
                host = authority
            }
        }
        host = host.lowercased()
        guard !host.isEmpty else { return nil }
        let key = host + (port.map { ":\($0)" } ?? "") + path
        return URLCandidate(host: host, path: path, key: key)
    }

    private static func extractCandidates(_ text: String) -> [URLCandidate] {
        let normalized = normalizeDefanged(text)
        var found: [URLCandidate] = []
        var seen = Set<String>()
        func push(_ raw: String) {
            guard found.count < maxURLs, let cand = parseCandidate(raw) else { return }
            guard seen.insert(cand.key).inserted else { return }
            found.append(cand)
        }
        for match in allMatches(Patterns.url, in: normalized) {
            if found.count >= maxURLs { break }
            guard let raw = matchedString(match, group: 0, in: normalized) else { continue }
            push(raw)
            // Open-redirect shape: classify URLs embedded in
            // query parameter values too — the scanner must see
            // the real destination, not just the redirector.
            guard let qMark = raw.firstIndex(of: "?") else { continue }
            let query = raw[raw.index(after: qMark)...].prefix(while: { $0 != "#" })
            for pair in query.split(separator: "&") {
                let value: String
                if let eq = pair.firstIndex(of: "=") {
                    value = String(pair[pair.index(after: eq)...])
                } else {
                    value = ""
                }
                let decoded = value.removingPercentEncoding ?? value
                for inner in allMatches(Patterns.url, in: decoded) {
                    if found.count >= maxURLs { break }
                    if let innerRaw = matchedString(inner, group: 0, in: decoded) {
                        push(innerRaw)
                    }
                }
            }
        }
        return found
    }

    private static func stripTrailingDots(_ host: String) -> String {
        var h = host
        while h.hasSuffix(".") { h.removeLast() }
        return h
    }

    private static func isLoopbackNameHost(_ host: String) -> Bool {
        let h = stripTrailingDots(host)
        return h == "localhost" || h.hasSuffix(".localhost")
    }

    /// True when the text wires this loopback host into a
    /// fetchable config slot (url: / endpoint: / webhook …).
    private static func hasLoopbackConfigIntent(_ text: String, host: String) -> Bool {
        let esc = NSRegularExpression.escapedPattern(for: host)
        let pattern = "\\b(?:url|endpoint|webhook(?:_url)?|callback(?:_url)?|target|base_url|api_url)\\s*[:=]\\s*[\"']?https?://"
            + esc + "(?::[0-9]+)?\\b"
        return firstMatch(compile(pattern, .caseInsensitive), in: text) != nil
    }

    /// Is this host an IP literal (after un-disguising numeric
    /// spellings the way WHATWG parsing would surface them)?
    private static func ipLiteralClass(_ host: String) -> String? {
        if host.contains(":") { return classifyIp(host) }
        if firstMatch(Patterns.dottedQuad, in: host) != nil { return classifyIp(host) }
        let normalized = normalizeIpLiteral(host)
        if normalized != host, firstMatch(Patterns.dottedQuad, in: normalized) != nil {
            return classifyIp(normalized)
        }
        return nil
    }

    private static func scanSSRF(_ text: String) -> (risk: Double, findings: [ShieldFinding], worstClass: String?) {
        var risk = 0.0
        var findings: [ShieldFinding] = []
        var worstClass: String?
        let defanged = normalizeDefanged(text)

        func apply(_ r: Double, ipClass: String, emitFinding: Bool) {
            if r > risk {
                risk = r
                worstClass = ipClass
            }
            if emitFinding {
                findings.append(ShieldFinding(name: "ssrf", count: 1, detail: ipClass))
            }
        }

        for cand in extractCandidates(text) {
            // Loopback hostnames: classified locally, flagged
            // only with actionable context (the narrowed
            // day-24 rule that shipped in production).
            if isLoopbackNameHost(cand.host) {
                let actionable =
                    firstMatch(Patterns.loopbackSensitivePath, in: cand.path) != nil
                    || hasLoopbackConfigIntent(defanged, host: stripTrailingDots(cand.host))
                if actionable {
                    apply(ssrfRisk["loopback"] ?? 0.9, ipClass: "loopback", emitFinding: true)
                }
                continue
            }
            if let metaClass = metadataHosts[stripTrailingDots(cand.host)] {
                apply(ssrfRisk[metaClass] ?? 0, ipClass: metaClass, emitFinding: true)
                continue
            }
            // URL shortener: the destination is hidden behind
            // an opaque token — suspicious floor, never fetched.
            if urlShortenerHosts.contains(stripTrailingDots(cand.host)) {
                apply(ssrfRisk["url_shortener"] ?? 0.4, ipClass: "url_shortener", emitFinding: true)
                continue
            }
            if let cls = ipLiteralClass(cand.host) {
                apply(ssrfRisk[cls] ?? 0, ipClass: cls, emitFinding: cls != "public")
                continue
            }
            // Non-literal hostname: no DNS on the phone (see
            // the header note) — detect.ts's unresolved outcome.
            findings.append(ShieldFinding(name: "ssrf", count: 1, detail: "unresolved"))
        }

        // file:// URLs: a local-file read attempt, flagged like
        // loopback — or worse when its host is an IP literal
        // that classifies worse (file://169.254.169.254/…).
        var seenFile = Set<String>()
        for match in allMatches(Patterns.fileURL, in: text) {
            if seenFile.count >= maxURLs { break }
            guard let rawFile = matchedString(match, group: 0, in: text) else { continue }
            let raw = String(rawFile.prefix(2048))
            guard seenFile.insert(raw).inserted else { continue }
            var r = ssrfRisk["local_file"] ?? 0.9
            var ipClass = "local_file"
            if let host = fileURLHost(raw), !host.isEmpty {
                let cls = classifyIp(host)
                if (ssrfRisk[cls] ?? 0) > r {
                    r = ssrfRisk[cls] ?? 0
                    ipClass = cls
                }
            }
            apply(r, ipClass: ipClass, emitFinding: true)
        }
        return (risk, findings, worstClass)
    }

    private static func fileURLHost(_ raw: String) -> String? {
        guard let schemeEnd = raw.range(of: "://") else { return nil }
        let rest = raw[schemeEnd.upperBound...]
        let end = rest.firstIndex(of: "/") ?? rest.endIndex
        var authority = String(rest[..<end])
        if let at = authority.lastIndex(of: "@") {
            authority = String(authority[authority.index(after: at)...])
        }
        if let colon = authority.lastIndex(of: ":"), !authority.hasPrefix("[") {
            let suffix = authority[authority.index(after: colon)...]
            if suffix.allSatisfy({ $0.isNumber }) {
                authority = String(authority[..<colon])
            }
        }
        return authority.lowercased()
    }

    /// Normalize non-standard IPv4 literals to dotted decimal
    /// before classification (detect.ts normalizeIpLiteral):
    /// 127.0.0.1 written as 0x7f000001, 2130706433, 017700000001,
    /// or mixed per-octet forms all resolve to loopback.
    private static func normalizeIpLiteral(_ host: String) -> String {
        var h = host.lowercased()
        if h.hasPrefix("[") { h.removeFirst() }
        if h.hasSuffix("]") { h.removeLast() }
        func asInt(_ s: String) -> UInt64? {
            if s.hasPrefix("0x") {
                let digits = s.dropFirst(2)
                guard !digits.isEmpty, digits.allSatisfy({ $0.isHexDigit }) else { return nil }
                return UInt64(digits, radix: 16)
            }
            if s.count > 1, s.hasPrefix("0"), s.allSatisfy({ "01234567".contains($0) }) {
                return UInt64(s, radix: 8)
            }
            if !s.isEmpty, s.allSatisfy({ $0.isASCII && $0.isNumber }) {
                guard let n = UInt64(s), n <= 0xFFFF_FFFF else { return nil }
                return n
            }
            return nil
        }
        if let single = asInt(h), !h.contains("."), !h.contains(":") {
            let v = UInt32(truncatingIfNeeded: single)
            return [v >> 24 & 255, v >> 16 & 255, v >> 8 & 255, v & 255]
                .map(String.init).joined(separator: ".")
        }
        if h.contains(".") {
            let parts = h.split(separator: ".", omittingEmptySubsequences: false)
            if parts.count == 4 {
                var nums: [UInt64] = []
                for part in parts {
                    guard let n = asInt(String(part)), n <= 255 else { return host }
                    nums.append(n)
                }
                return nums.map(String.init).joined(separator: ".")
            }
        }
        return host
    }

    /// Classify an IP per the SSRF taxonomy (detect.ts
    /// classifyIp, branch for branch, order preserved).
    private static func classifyIp(_ ip: String) -> String {
        let norm = normalizeIpLiteral(ip)
        if let m = firstMatch(Patterns.dottedQuadGroups, in: norm) {
            let o = (1...4).compactMap { matchedString(m, group: $0, in: norm).flatMap { Int($0) } }
            if o.count == 4 {
                if o.contains(where: { $0 > 255 }) { return "invalid" }
                let a = o[0], b = o[1]
                if a == 169 && b == 254 { return "cloud_metadata" }  // 169.254.0.0/16
                // Alibaba Cloud metadata — the only major cloud
                // metadata IP outside 169.254/16; exact match, so
                // the rest of 100.64/10 CGNAT stays public.
                if a == 100 && b == 100 && o[2] == 100 && o[3] == 200 { return "cloud_metadata" }
                if a == 127 { return "loopback" }
                if a == 10 { return "private" }
                if a == 172 && b >= 16 && b <= 31 { return "private" }
                if a == 192 && b == 168 { return "private" }
                if a >= 224 && a <= 239 { return "multicast" }
                if a == 0 || a >= 240 { return "reserved" }
                return "public"
            }
        }
        var v6 = ip.lowercased()
        if v6.hasPrefix("[") { v6.removeFirst() }
        if v6.hasSuffix("]") { v6.removeLast() }
        if v6 == "::1" { return "loopback" }
        if v6.hasPrefix("fe80:") { return "link_local" }       // fe80::/10
        if v6.hasPrefix("fc") || v6.hasPrefix("fd") { return "private" }  // fc00::/7
        if v6.hasPrefix("ff") { return "multicast" }
        // Deprecated IPv6 site-local fec0::/10.
        let firstHextet = Int(v6.split(separator: ":").first.map(String.init) ?? "0", radix: 16) ?? 0
        if firstHextet >= 0xFEC0 && firstHextet <= 0xFEFF { return "link_local" }
        // IPv4-mapped forms: ::ffff:a9fe:a9fe (hex groups) and
        // ::ffff:169.254.169.254 (dotted tail).
        if let m = firstMatch(compile(#"::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$"#), in: v6),
           let g1 = matchedString(m, group: 1, in: v6), let g2 = matchedString(m, group: 2, in: v6) {
            return classifyIp(dottedFromHexGroups(g1, g2))
        }
        if let m = firstMatch(compile(#"::ffff:([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$"#), in: v6),
           let dotted = matchedString(m, group: 1, in: v6) {
            return classifyIp(dotted)
        }
        // NAT64 well-known prefix 64:ff9b::/96 — the IPv4
        // destination hides in the low 32 bits.
        if let m = firstMatch(compile(#"^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$"#), in: v6),
           let g1 = matchedString(m, group: 1, in: v6), let g2 = matchedString(m, group: 2, in: v6) {
            return classifyIp(dottedFromHexGroups(g1, g2))
        }
        if let m = firstMatch(compile(#"^64:ff9b::([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$"#), in: v6),
           let dotted = matchedString(m, group: 1, in: v6) {
            return classifyIp(dotted)
        }
        // RFC 8215 local-use NAT64 prefix 64:ff9b:1::/48.
        if let m = firstMatch(compile(#"^64:ff9b:1::([0-9a-f]{1,4}):([0-9a-f]{1,4})$"#), in: v6),
           let g1 = matchedString(m, group: 1, in: v6), let g2 = matchedString(m, group: 2, in: v6) {
            return classifyIp(dottedFromHexGroups(g1, g2))
        }
        if v6.contains(":"), v6.allSatisfy({ $0.isHexDigit || $0 == ":" }) {
            if let m = firstMatch(compile(#"::ffff:([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$"#), in: v6),
               let dotted = matchedString(m, group: 1, in: v6) {
                return classifyIp(dotted)
            }
            return "public"
        }
        return "invalid"
    }

    private static func dottedFromHexGroups(_ g1: String, _ g2: String) -> String {
        let a = Int(g1, radix: 16) ?? 0
        let b = Int(g2, radix: 16) ?? 0
        return [a >> 8 & 255, a & 255, b >> 8 & 255, b & 255]
            .map(String.init).joined(separator: ".")
    }
}

// MARK: - Prompt-injection heuristics (detect.ts, ported)

extension ShieldScanner {
    struct InjectionSignal {
        let name: String
        let re: NSRegularExpression?
        let weight: Double
    }

    // Verbs attackers use to cancel existing instructions...
    private static let overrideVerbs =
        #"ignor(e|ing)|disregard|forget|drop|overrid(e|ing)|abandon|bypass|defy|cancel|void|nullify|eras(e|ing)|rescind|supersed(e|ing)|throw\s+out|set\s+aside|stop\s+following|do\s+not\s+follow"#
    // ...and the nouns they target.
    private static let overrideTargets =
        #"instructions?|guidelines?|rules?|constraints?|safety(\s+rules|\s+training)?|content\s+polic(y|ies)|guardrails?|directives?|training|alignment|system(\s+prompt)?|prior\s+context|all\s+rules"#

    private static let instructionOverridePattern =
        "(?:\(overrideVerbs))\\s+(?:your\\s+|the\\s+|all\\s+|previous\\s+|prior\\s+|my\\s+|current\\s+)*(?:\(overrideTargets))"

    /// detect.ts INJECTION_SIGNALS, verbatim — names, patterns,
    /// weights, order.
    static let injectionSignals: [InjectionSignal] = [
        InjectionSignal(
            name: "instruction_override",
            re: compile(instructionOverridePattern, .caseInsensitive),
            weight: 0.45),
        InjectionSignal(
            name: "system_prompt_extraction",
            re: compile(#"reveal\s+(your\s+|the\s+)?system\s+(prompt|instructions)|disclose\s+(your\s+)?(system\s+|initial\s+)?(prompt|instructions)|print\s+(your\s+|the\s+)?(instructions|system\s+prompt)\s+verbatim|what\s+are\s+your\s+(exact\s+)?instructions|output\s+everything\s+above|repeat\s+after\s+me|translate\s+your\s+system\s+prompt|list\s+(every|all)\s+instructions?|read\s+back\s+(the\s+)?(full\s+)?system\s+prompt|show\s+me\s+the\s+script|quote\s+(them|it)\s+exactly|system\s+prompt\s+verbatim|exfiltrat(e|ing)\s+your\s+own\s+system\s+prompt"#, .caseInsensitive),
            weight: 0.45),
        InjectionSignal(
            name: "role_spoofing",
            re: compile(#"\[(system|admin|developer|privileged|moderator)\]|<(system|admin|sys)\b|<<\s*sys\s*>>|#{2,}\s*system\b|system\s+(note|notice|override|transcript)\b|internal\s+memo\b|debug\s+mode\b|sudo\s+mode\b|role\s*:\s*system\b|begin\s+system\s+transcript"#, .caseInsensitive),
            weight: 0.35),
        InjectionSignal(
            name: "authority_claim",
            re: compile(#"you\s+are\s+now\b(?! a helpful)|from\s+now\s+on,?\s+you\s+(are|will)|new\s+(instructions|directive|system\s+update)\s*:|you\s+are\s+(dan|venom)\b|unrestricted\s+mode|no\s+(restrictions|safety\s+rules)|never\s+refuse|policy\s+disabled|safety\s+(interlocks?\s+disengaged|filters?\s+disabled|layer\s+(was\s+)?removed)"#, .caseInsensitive),
            weight: 0.30),
        InjectionSignal(
            name: "exfiltration_directive",
            re: compile(#"(forward|send|exfiltrate|upload|post|export|email)\s+.{0,60}(api[_-]?key|secret|token|password|credential|database|contact\s+list|environment\s+variables|chat)"#, .caseInsensitive),
            weight: 0.50),
        InjectionSignal(
            name: "hidden_instruction",
            re: compile(#"<!--[\s\S]{0,800}?(system|instruction|forward|ignore|assistant)[\s\S]{0,800}?-->|\(hidden\s*:|<span[^>]*display\s*:\s*none[^>]*>"#, .caseInsensitive),
            weight: 0.40),
        InjectionSignal(
            name: "embedded_assistant_directive",
            re: compile(#"\bassistant\s*[:,]\s*(ignore|disregard|cancel|delete|send|email|forward|disable|mark|recommend|omit|skip|share|export|upload|post|reveal|list|read|execute|run|revert|approve|deny|rank|pin|feature|update|tell|say|cite|assure|round|always|never|whenever|when|if)\b"#, .caseInsensitive),
            weight: 0.40),
        InjectionSignal(
            name: "jailbreak_persona",
            re: compile(#"\bdan\b.{0,30}do\s+anything\s+now|do\s+anything\s+now|jailbreak|no\s+restrictions|without\s+restrictions|unfiltered|i\s+am\s+(your\s+)?developer\b|as\s+(your|the)\s+developer|policy\s+update|internal\s+memo|alignment\s+team|red\s+team|oversight\s+board|compliance\s+test|emergency\s+protocol"#, .caseInsensitive),
            weight: 0.40),
        InjectionSignal(
            name: "concealment_directive",
            re: compile(#"do\s*n'?t\s+(mention|tell|inform|notify|show)\s+(the\s+)?user|no\s+need\s+to\s+mention|keep\s+this\s+(between\s+us|confidential|quiet)|don'?t\s+include\s+this\s+in\s+(your|the)\s+(summary|response|report)|without\s+(telling|notifying|alerting)\s+the\s+user"#, .caseInsensitive),
            weight: 0.50),
        InjectionSignal(
            name: "imperative_sensitive_action",
            re: compile(#"\b(forward|send|email|export|upload|delete|remove|share|reveal|disclose|list|read|fetch|retrieve)\s+(the\s+|all\s+|these\s+)?(messages?|mails?|database|logs?|files?|attachments?|documents?|credentials?|keys?|tokens?|passwords?|calendar|contacts?|history)\b"#, .caseInsensitive),
            weight: 0.35),
        InjectionSignal(
            name: "credential_solicitation_reply",
            re: compile(#"\breply\s+(with\s+|to\s+)?(your\s+current\s+)?(session\s+tokens?|passwords?|api[_\s-]?keys?|otps?|2fa|verification\s+codes?|secrets?|credentials?)\b"#, .caseInsensitive),
            weight: 0.50),
    ]

    private struct InjectionOutcome {
        let score: Double
        let signals: [String]
        let primarySignal: String?
    }

    /// detect.ts scoreInjection: every normalized view is
    /// scored (attacker obfuscation shouldn't hide signals);
    /// base64- and hex-concealed payloads score like their
    /// plaintext; discussion-about framing dampens; co-occurring
    /// weak signals amplify each other.
    private static func scoreInjection(_ text: String) -> InjectionOutcome {
        var score = 0.0
        var signals: [String] = []
        func addSignal(_ name: String, _ weight: Double, _ tag: String) {
            let key = tag == "raw" ? name : "\(tag):\(name)"
            if !signals.contains(key) {
                score += weight
                signals.append(key)
            }
        }
        func scanViews(of base: String, rawTag: String, normTag: String) {
            for (idx, view) in Canonicalizer.textViews(base).enumerated() {
                let tag = idx == 0 ? rawTag : normTag
                let factor = idx == 0 ? 1.0 : 0.9
                for signal in injectionSignals {
                    if firstMatch(signal.re, in: view) != nil {
                        addSignal(signal.name, signal.weight * factor, tag)
                    }
                }
            }
        }
        scanViews(of: text, rawTag: "raw", normTag: "norm")

        let cleaned = Canonicalizer.stripZeroWidth(text)
        // Decode base64 blobs and re-scan the plaintext with
        // the same multi-view treatment (a concealed payload
        // must score like its plaintext).
        for blob in blobMatches(in: cleaned) {
            if let decoded = Canonicalizer.tryBase64Decode(blob) {
                scanViews(of: decoded, rawTag: "b64", normTag: "b64norm")
            }
        }
        // Decode hex blobs and re-scan, same treatment.
        for match in allMatches(Patterns.hexBlob, in: cleaned) {
            if let rawHex = matchedString(match, group: 0, in: cleaned),
               let decoded = Canonicalizer.tryHexDecode(rawHex) {
                scanViews(of: decoded, rawTag: "hex", normTag: "hexnorm")
            }
        }

        // Phrases marking discussion-about-attacks rather than
        // attacks themselves halve the injection score (never
        // applied to secrets / PII / SSRF).
        if firstMatch(Patterns.educational, in: cleaned) != nil {
            score *= 0.5
            signals.append("educational_context_dampened")
        }
        // Attribution framing: a suspicious signal inside
        // attributed / quoted speech is discussion, not
        // execution.
        if firstMatch(Patterns.attribution, in: cleaned) != nil {
            score *= 0.6
            signals.append("attribution_framing_dampened")
        }
        // Signal combination: weak signals that co-occur
        // become strong.
        let (bonus, combos) = combinationBonus(cleaned, signals)
        if bonus > 0 {
            score += bonus
            for combo in combos { signals.append("combo:\(combo)") }
        }
        let primary = injectionSignals.first(where: { sig in
            signals.contains(where: { $0 == sig.name || $0.hasSuffix(":" + sig.name) })
        })?.name
        return InjectionOutcome(score: min(1, score), signals: signals, primarySignal: primary)
    }

    /// detect.ts combinationBonus, verbatim.
    private static func combinationBonus(
        _ text: String, _ signals: [String]
    ) -> (bonus: Double, combos: [String]) {
        func has(_ names: String...) -> Bool {
            names.contains(where: { n in signals.contains(where: { $0.contains(n) }) })
        }
        var bonus = 0.0
        var combos: [String] = []
        let imperative = has("imperative_sensitive_action", "embedded_assistant_directive")
        let conceal = has("concealment_directive")
        let exfil = has("exfiltration_directive")
        let external = firstMatch(Patterns.externalContact, in: text) != nil
        if imperative && conceal {
            bonus += 0.3
            combos.append("imperative+concealment")
        }
        if (imperative || exfil) && external {
            bonus += 0.25
            combos.append("directive+external_contact")
        }
        if conceal && external {
            bonus += 0.2
            combos.append("concealment+external_contact")
        }
        return (bonus, combos)
    }
}
