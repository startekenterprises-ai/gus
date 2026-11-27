import CryptoKit
import Foundation
import Security

// Shield receipts: every scan appends one record to a
// per-device, append-only log in the app sandbox. Each receipt
// chains to the previous receipt's hash (per-device stream
// only — Gemini sharpening 3: devices never merge chains), and
// each receipt's hash is signed with this device's own P256
// key.
//
// v0.24.0 (the enclave hardening): the signing key lives in
// the Secure Enclave wherever the device has one — the
// private material never leaves the enclave, and all the
// Keychain holds is the key's opaque dataRepresentation, a
// reference the enclave resolves. The pre-enclave software
// key (Keychain-held raw key material, generated on first
// use) is RETAINED, never deleted: it still signs on
// platforms without an enclave, and every receipt it signed
// before the move stays verifiable against it — each receipt
// names the key that signed it (see `signingKey`), and
// `verify` checks a receipt against the named key.
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
    /// v0.24.0: which of this device's keys produced the
    /// signature — "enclave" or "software". Absent (nil) on
    /// every receipt written before the field existed, and
    /// nil means the legacy software key: it signed
    /// everything back then. Verification keys off this
    /// field, defaulting nil to the legacy key, so history
    /// stays verifiable across the enclave move.
    public let signingKey: String?

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
    /// The key new receipts sign with — resolved once, lazily.
    private var activeKey: ReceiptSigningKey?
    /// Cached key material/references, per key home.
    private var enclaveKey: SecureEnclave.P256.Signing.PrivateKey?
    private var legacyKey: P256.Signing.PrivateKey?

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
            signature: "",
            signingKey: nil)
        let canonical = draft.canonicalForm()
        let hash = SHA256.hash(data: Data(canonical.utf8))
            .map { String(format: "%02x", $0) }.joined()
        let signed = sign(canonical)
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
            signature: signed.signature,
            signingKey: signed.keyTag)
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

    // MARK: - Verification

    /// Verify one receipt end to end: its hash recomputes from
    /// the canonical form, and its signature verifies under the
    /// public key of the key the receipt names — "enclave"
    /// names the Secure Enclave key; nil (every receipt from
    /// before v0.24.0) and "software" name the legacy key,
    /// which is retained on the device precisely so history
    /// stays verifiable after the move. A receipt whose named
    /// key is not on this device (a log carried across
    /// devices) does not verify — chains are per-device by
    /// design, and keys never leave their device.
    public func verify(_ receipt: ShieldReceipt) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let canonical = receipt.canonicalForm()
        let hash = SHA256.hash(data: Data(canonical.utf8))
            .map { String(format: "%02x", $0) }.joined()
        guard hash == receipt.hash,
              let sigData = Data(base64Encoded: receipt.signature),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: sigData),
              let publicKey = publicKey(forTag: receipt.signingKey)
        else { return false }
        return publicKey.isValidSignature(signature, for: Data(canonical.utf8))
    }

    private func publicKey(forTag tag: String?) -> P256.Signing.PublicKey? {
        switch tag {
        case "enclave":
            return storedEnclaveKey()?.publicKey
        default:
            // nil (pre-v0.24.0) and "software" both name the
            // legacy Keychain-held key.
            return storedLegacyKey()?.publicKey
        }
    }

    // MARK: - Signing (Secure Enclave first, legacy key retained)

    private func sign(_ canonical: String) -> (signature: String, keyTag: String?) {
        guard let key = activeSigningKey(),
              let signature = key.sign(canonical)
        else { return ("", nil) }
        return (signature, key.tag)
    }

    /// The key new receipts sign with: the Secure Enclave key
    /// when this device has an enclave, the legacy software key
    /// when it doesn't (or when enclave key creation fails).
    /// Resolved once per process; the choice is stamped on
    /// every receipt it signs.
    private func activeSigningKey() -> ReceiptSigningKey? {
        if let activeKey { return activeKey }
        if let enclave = loadOrCreateEnclaveKey() {
            activeKey = .enclave(enclave)
            return activeKey
        }
        if let legacy = loadOrCreateLegacyKey() {
            activeKey = .software(legacy)
            return activeKey
        }
        return nil
    }

    // MARK: Enclave key

    /// The stored enclave key, if one has been minted on this
    /// device. Lookup only — verification uses this, so merely
    /// checking old receipts never creates a key.
    private func storedEnclaveKey() -> SecureEnclave.P256.Signing.PrivateKey? {
        if let enclaveKey { return enclaveKey }
        guard let data = keychainData(account: Self.enclaveKeyAccount),
              let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)
        else { return nil }
        enclaveKey = key
        return key
    }

    private func loadOrCreateEnclaveKey() -> SecureEnclave.P256.Signing.PrivateKey? {
        if let key = storedEnclaveKey() { return key }
        guard SecureEnclave.isAvailable else { return nil }
        // First use on this device: mint the enclave key. The
        // access control is private-key-usage only, available
        // after first unlock — receipts sign at turn boundaries
        // with nobody present, so no user-presence requirement
        // can ride the key. Only the key's dataRepresentation
        // (an opaque reference the enclave resolves — not key
        // material) is stored, in the Keychain, so the same key
        // is found again next launch.
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                .privateKeyUsage,
                &accessError),
              let key = try? SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        else { return nil }
        storeKeychainData(key.dataRepresentation, account: Self.enclaveKeyAccount)
        enclaveKey = key
        return key
    }

    // MARK: Legacy software key (pre-v0.24.0)

    /// The stored legacy key, if this install has one. Lookup
    /// only — it is never deleted, so receipts signed before
    /// the enclave move remain verifiable (see `verify`).
    private func storedLegacyKey() -> P256.Signing.PrivateKey? {
        if let legacyKey { return legacyKey }
        guard let data = keychainData(account: Self.legacyKeyAccount),
              let key = try? P256.Signing.PrivateKey(rawRepresentation: data)
        else { return nil }
        legacyKey = key
        return key
    }

    /// The legacy path, exactly as it behaved before v0.24.0:
    /// loaded from the Keychain, generated and stored on first
    /// use. It is the signing key only where no enclave is
    /// available — and the verification key for old receipts
    /// everywhere.
    private func loadOrCreateLegacyKey() -> P256.Signing.PrivateKey? {
        if let key = storedLegacyKey() { return key }
        let key = P256.Signing.PrivateKey()
        storeKeychainData(key.rawRepresentation, account: Self.legacyKeyAccount)
        // Whether or not the Keychain took the store, sign with
        // the key for this process rather than failing the
        // scan — the receipt chain stays intact, and the next
        // launch retries the store. (Pre-v0.24.0 behavior,
        // unchanged.)
        legacyKey = key
        return key
    }

    // MARK: Keychain plumbing

    private static let keychainService = "com.startekenterprises.gus.shieldkit"
    private static let legacyKeyAccount = "receipt-signing-key"
    private static let enclaveKeyAccount = "receipt-signing-key-enclave"

    private func keychainData(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return data
    }

    @discardableResult
    private func storeKeychainData(_ data: Data, account: String) -> Bool {
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.keychainService,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
}

/// The two homes a receipt-signing key can have (v0.24.0).
/// The enclave form's private material never leaves the Secure
/// Enclave — signing happens inside it, and the app holds only
/// the key object. The software form is the pre-v0.24.0
/// Keychain-held key, retained for enclave-less platforms and
/// for verifying the receipts it already signed. Both produce
/// the same P256 signature type over the same canonical form,
/// so a receipt's verification needs only the key's public half
/// and the receipt's own `signingKey` tag.
private enum ReceiptSigningKey {
    case enclave(SecureEnclave.P256.Signing.PrivateKey)
    case software(P256.Signing.PrivateKey)

    /// The tag stamped on receipts this key signs.
    var tag: String {
        switch self {
        case .enclave: return "enclave"
        case .software: return "software"
        }
    }

    /// Base64 signature over the canonical form, or nil if the
    /// key refused (enclave unavailable mid-flight, device
    /// locked before first unlock).
    func sign(_ canonical: String) -> String? {
        let signature: P256.Signing.ECDSASignature?
        switch self {
        case .enclave(let key):
            signature = try? key.signature(for: Data(canonical.utf8))
        case .software(let key):
            signature = try? key.signature(for: Data(canonical.utf8))
        }
        return signature?.rawRepresentation.base64EncodedString()
    }
}
