import CryptoKit
import Foundation
import Security

// Shield receipts: every scan appends one record to a
// per-device, append-only log in the app sandbox. Each receipt
// chains to the previous receipt's hash (per-device stream
// only — Gemini sharpening 3: devices never merge chains), and
// each receipt's hash is signed with this device's own P256
// key. The key is generated on first use and held in the
// Keychain — plainly: a Keychain-held key, NOT a Secure Enclave
// key. Moving it into the enclave is a later hardening chunk.
//
// A receipt binds: when, which direction, the verdict the app
// acted on, the verdict the rules alone produced, the posture
// in effect, the rule that drove it, the bundled rules version,
// and a short hash of the scanned content. The content itself
// is never stored.

public struct ShieldReceipt: Codable, Identifiable, Sendable {
    public let seq: Int
    /// ISO-8601 timestamp.
    public let timestamp: String
    public let direction: ShieldDirection
    /// The verdict the app acted on (posture applied).
    public let verdict: ShieldVerdict
    /// What the rules concluded before posture — in Permissive
    /// this is the would-be verdict the receipt must keep.
    public let rulesVerdict: ShieldRawVerdict
    public let posture: ShieldPosture
    public let ruleID: String
    public let rulesVersion: String
    /// Short content hash (16 hex chars) — never the content.
    public let contentHash: String
    /// Hash of the previous receipt on THIS device (64 zeros
    /// for the first receipt — the genesis link).
    public let prevHash: String
    /// SHA-256 of this receipt's canonical form.
    public let hash: String
    /// Base64 P256 signature over the canonical form.
    public let signature: String

    public var id: Int { seq }

    public var date: Date {
        ShieldReceiptLog.isoFormatter.date(from: timestamp) ?? .distantPast
    }

    /// A receipt counts as "caught" when the RULES flagged the
    /// turn — in Permissive the app let it through, but the log
    /// must still show it was caught (the Caught filter).
    public var isCaught: Bool { rulesVerdict != .allow }

    /// The canonical string the hash and signature bind.
    /// Deterministic field order; pipes cannot appear in any
    /// field value (rule ids and hashes are pipe-free by
    /// construction).
    func canonicalForm() -> String {
        [String(seq), timestamp, direction.rawValue, verdict.rawValue,
         rulesVerdict.rawValue, posture.rawValue, ruleID, rulesVersion,
         contentHash, prevHash].joined(separator: "|")
    }
}

public final class ShieldReceiptLog: @unchecked Sendable {
    public static let shared = ShieldReceiptLog()

    // A fresh formatter per access: ISO8601DateFormatter is
    // not Sendable, so a shared static instance is a Swift 6
    // concurrency error (first iMac archive of 0.15.7 failed
    // on exactly this). Receipts are written at turn
    // boundaries only — the allocation cost is irrelevant.
    static var isoFormatter: ISO8601DateFormatter {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }

    private let lock = NSLock()
    private var loaded = false
    private var receipts: [ShieldReceipt] = []
    private var lastHash = String(repeating: "0", count: 64)
    private var signingKey: P256.Signing.PrivateKey?

    private init() {}

    // MARK: - Recording

    /// Append a receipt for one completed scan. Called at turn
    /// boundaries only — never on any audio path.
    @discardableResult
    public func record(_ result: ShieldScanResult, direction: ShieldDirection) -> ShieldReceipt {
        lock.lock()
        defer { lock.unlock() }
        loadIfNeeded()
        let draft = ShieldReceipt(
            seq: receipts.count,
            timestamp: Self.isoFormatter.string(from: Date()),
            direction: direction,
            verdict: result.verdict,
            rulesVerdict: result.rulesVerdict,
            posture: result.posture,
            ruleID: result.primaryRuleID,
            rulesVersion: result.rulesVersion,
            contentHash: result.contentHash,
            prevHash: lastHash,
            hash: "",
            signature: "")
        let canonical = draft.canonicalForm()
        let hash = SHA256.hash(data: Data(canonical.utf8))
            .map { String(format: "%02x", $0) }.joined()
        let signature = sign(canonical)
        let receipt = ShieldReceipt(
            seq: draft.seq,
            timestamp: draft.timestamp,
            direction: draft.direction,
            verdict: draft.verdict,
            rulesVerdict: draft.rulesVerdict,
            posture: draft.posture,
            ruleID: draft.ruleID,
            rulesVersion: draft.rulesVersion,
            contentHash: draft.contentHash,
            prevHash: draft.prevHash,
            hash: hash,
            signature: signature)
        receipts.append(receipt)
        lastHash = hash
        appendLine(receipt)
        return receipt
    }

    /// All receipts on this device, oldest first.
    public func allReceipts() -> [ShieldReceipt] {
        lock.lock()
        defer { lock.unlock() }
        loadIfNeeded()
        return receipts
    }

    // MARK: - Storage (JSONL in the app sandbox)

    private var logFileURL: URL? {
        guard let base = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        let dir = base.appendingPathComponent("ShieldKit", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("receipts.jsonl")
    }

    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        guard let url = logFileURL,
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8)
        else { return }
        let decoder = JSONDecoder()
        for line in text.split(separator: "\n") {
            if let receipt = try? decoder.decode(
                ShieldReceipt.self, from: Data(line.utf8)) {
                receipts.append(receipt)
            }
        }
        receipts.sort { $0.seq < $1.seq }
        if let last = receipts.last { lastHash = last.hash }
    }

    private func appendLine(_ receipt: ShieldReceipt) {
        guard let url = logFileURL else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard var data = try? encoder.encode(receipt) else { return }
        data.append(contentsOf: [0x0A])
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url, options: .atomic)
        }
    }

    // MARK: - Signing (per-device P256 key, Keychain-held)

    private func sign(_ canonical: String) -> String {
        guard let key = deviceKey(),
              let signature = try? key.signature(for: Data(canonical.utf8))
        else { return "" }
        return signature.rawRepresentation.base64EncodedString()
    }

    /// This device's receipt-signing key: loaded from the
    /// Keychain, generated and stored on first use. Keychain —
    /// NOT the Secure Enclave (see the header note).
    private func deviceKey() -> P256.Signing.PrivateKey? {
        if let signingKey { return signingKey }
        let service = "com.startekenterprises.gus.shieldkit"
        let account = "receipt-signing-key"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
           let data = item as? Data,
           let key = try? P256.Signing.PrivateKey(rawRepresentation: data) {
            signingKey = key
            return key
        }
        let key = P256.Signing.PrivateKey()
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: key.rawRepresentation,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemAdd(add as CFDictionary, nil) == errSecSuccess {
            signingKey = key
            return key
        }
        // Keychain refused the store: still sign with an
        // in-memory key for this process rather than failing
        // the scan — the receipt chain stays intact, and the
        // next launch retries the store.
        signingKey = key
        return key
    }
}
