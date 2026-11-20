import Foundation
import Security

// GUS panel API client — shared by the iOS companion and the Watch app.
//
// The client speaks to the operator's own GUS control-plane panel
// (packages/panel in the GUS repo). Every request carries the
// credential in the Keychain — never in UserDefaults, source, or
// logs. Since v0.12.0 that credential is normally this device's
// OWN pairing credential (Settings → Pair with a QR code): the
// panel confines it to this client's surface (status, jobs,
// approvals, kill switch, Governor mode). The operator token
// still works here as the manual fallback and reaches everything,
// exactly as before. The panel resolves approvals through the
// same hash-bound engine as the Telegram buttons and this panel —
// approving here approves exactly the action GUS parked, nothing else.
//
// Transport note: the panel binds to the Mac by default. Reach it the
// way you'd reach anything on your own machine — Tailscale (point the
// base URL at the Mac's tailnet address) or an SSH tunnel. Do not
// expose the panel to the open internet; the token is a bearer
// credential for approvals and the kill switch.

// MARK: - Models (mirror packages/panel/src/types.ts)

struct PanelStatus: Decodable {
    struct Shield: Decodable {
        let provisioned: Bool
        let required: Bool
        let onUnavailable: String
        let baseUrl: String
    }
    struct Provider: Decodable { let id: String; let model: String }
    struct PermissiveToday: Decodable {
        struct Entry: Decodable { let ts: Double; let kind: String; let detail: String }
        let count: Int
        let recent: [Entry]
    }
    struct Settings: Decodable {
        let providerKey: String
        let telegramConfigured: Bool
        let delegates: Int
        let macWorkDirs: Int
    }
    let version: String
    let killed: Bool
    let shield: Shield
    let provider: Provider
    let pendingApprovals: Int
    let spendTodayUsd: Double
    let spendMonthUsd: Double
    let governorMode: String
    let permissiveToday: PermissiveToday
    let settings: Settings
}

struct PanelApproval: Decodable, Identifiable {
    let id: String
    let jobId: String
    let summary: String
    let reason: String
    let createdAt: Double
    let expiresAt: Double
}

struct PanelJob: Decodable, Identifiable {
    let id: String
    let kind: String
    let state: String
    let updatedAt: Double
}

struct ActionResult: Decodable { let ok: Bool; let detail: String }

// MARK: - Pairing (v0.12.0 — pivot Phase 1 / iPhone Step 1)

/// The QR payload the Mac's pairing sheet encodes:
///   gus://pair?v=1&g=<grant>&addrs=<base URL>,<base URL>,…
/// The grant is a single-use, short-lived pairing ticket minted
/// by the Mac — never the operator token. `addrs` are the panel
/// address candidates the Mac knows (its chosen address first,
/// then its LAN addresses); the phone tries them in order. The
/// composer lives in the Mac app (Settings → Devices) and this
/// parser is its mirror — the two must agree, so both name this
/// format in their headers.
struct PairingPayload {
    let grant: String
    let addresses: [String]

    static func parse(_ raw: String) -> PairingPayload? {
        guard let comps = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              comps.scheme == "gus", comps.host == "pair" else { return nil }
        let items = comps.queryItems ?? []
        func value(_ name: String) -> String? { items.first(where: { $0.name == name })?.value }
        guard value("v") == "1",
              let grant = value("g"), !grant.isEmpty,
              let joined = value("addrs") else { return nil }
        let addresses = joined.split(separator: ",").map(String.init).filter { !$0.isEmpty }
        guard !addresses.isEmpty else { return nil }
        return PairingPayload(grant: grant, addresses: addresses)
    }
}

/// The exchange's answer: ok + the device credential, shown
/// exactly once (it goes straight into the Keychain). Mirrors
/// PanelPairingExchangeData in packages/panel/src/types.ts.
struct PairingExchangeResult: Decodable {
    let ok: Bool
    let detail: String
    let deviceId: String?
    let credential: String?
}

// MARK: - Settings (base URL in defaults, token in Keychain)

enum GUSSettings {
    private static let urlKey = "gus.panel.baseURL"

    static var baseURLString: String {
        get { UserDefaults.standard.string(forKey: urlKey) ?? "http://127.0.0.1:8731" }
        set { UserDefaults.standard.set(newValue, forKey: urlKey) }
    }

    static var baseURL: URL? { URL(string: baseURLString) }

    static var token: String {
        get { Keychain.read("gus.panel.token") ?? "" }
        set { Keychain.write("gus.panel.token", newValue) }
    }
}

enum Keychain {
    static func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ key: String, _ value: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var attrs = base
        attrs[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(attrs as CFDictionary, nil)
    }
}

// MARK: - Client

actor GUSClient {
    static let shared = GUSClient()

    enum ClientError: Error, LocalizedError {
        case notConfigured
        case http(Int, String)
        var errorDescription: String? {
            switch self {
            case .notConfigured: return "Set the panel address and token in Settings first."
            case .http(let code, let body): return "Panel answered HTTP \(code): \(body)"
            }
        }
    }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        guard let base = GUSSettings.baseURL, !GUSSettings.token.isEmpty else {
            throw ClientError.notConfigured
        }
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = method
        // The panel's documented auth: Authorization: Bearer <token>
        // (it also accepts ?t= and its own session cookie; Bearer is
        // the clean API path).
        req.setValue("Bearer \(GUSSettings.token)", forHTTPHeaderField: "authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw ClientError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data)
    }

    func status() async throws -> PanelStatus {
        try decode(PanelStatus.self, await request("/api/status"))
    }

    func approvals() async throws -> [PanelApproval] {
        try decode([PanelApproval].self, await request("/api/approvals"))
    }

    func jobs() async throws -> [PanelJob] {
        try decode([PanelJob].self, await request("/api/jobs"))
    }

    @discardableResult
    func resolveApproval(id: String, approve: Bool) async throws -> ActionResult {
        try decode(ActionResult.self, await request("/api/approvals/\(id)/\(approve ? "approve" : "deny")", method: "POST"))
    }

    @discardableResult
    func setKilled(_ on: Bool) async throws -> ActionResult {
        try decode(ActionResult.self, await request("/api/kill", method: "POST", body: ["on": on]))
    }

    @discardableResult
    func setGovernorMode(_ mode: String) async throws -> ActionResult {
        try decode(ActionResult.self, await request("/api/governor-mode", method: "POST", body: ["mode": mode]))
    }

    /// v0.12.0: the pairing exchange — trade a scanned grant for
    /// this device's own credential at one candidate address.
    /// Unlike every other call here it needs NO stored token
    /// (the grant is the authorization) and it does not read
    /// GUSSettings: the address comes from the QR code, because
    /// pairing is how the settings get set in the first place.
    /// The caller passes this device's name + platform; the Mac
    /// binds the credential to a device record under that name.
    static func exchangePairing(baseURLString: String, grant: String, name: String, platform: String) async throws -> PairingExchangeResult {
        guard let base = URL(string: baseURLString) else { throw ClientError.notConfigured }
        var req = URLRequest(url: base.appendingPathComponent("/api/pairing/exchange"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "grant": grant, "name": name, "platform": platform,
        ])
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode == 401 {
            throw ClientError.http(401, "the panel refused the pairing exchange")
        }
        // Every other answer — success or a refusal with a reason
        // (expired/consumed grant) — is the exchange shape.
        return try JSONDecoder().decode(PairingExchangeResult.self, from: data)
    }
}
