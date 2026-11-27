import Foundation
import Security

// GUS panel API client for the unified iOS app (v0.15.0, R4).
//
// Two layers, named honestly — the mistake the retired companion
// made was letting them blur together:
//
//   1. TRANSPORT: the panel's bearer credential. Every panel
//      route sits behind `Authorization: Bearer …`; the phone
//      carries the operator's panel token (from the Mac's
//      ~/.gus/state/panel-token) in the Keychain and reaches the
//      core at its address (the Mac's Tailscale name today; a
//      hosted core later). This credential says "this request
//      may reach the core" — it is not who you are.
//
//   2. IDENTITY: the ONE GUS identity (v0.13.0, R1). The login
//      screen signs in through /api/identity/login; the core
//      keeps the session in its own state dir (the token never
//      leaves the core), and GET /api/identity/session is how
//      this app learns, at launch, that it is still signed in —
//      log in once, stay logged in, exactly like the Mac app.
//
// The client holds none of GUS's vault secrets. Losing the phone
// loses a bearer credential: rotate panel-token on the Mac and
// restart the control plane.

// MARK: - Models (mirror packages/panel/src/types.ts)

struct ActionResult: Decodable { let ok: Bool; let detail: String }

/// GET /api/identity/session — the launch-gate readout. A live
/// `session` means this install is signed in; `provider` is the
/// identity's ACTIVE provider ("local", "local-password", or a
/// hosted seam kind this build cannot use yet).
struct IdentitySessionStatus: Decodable {
    struct Session: Decodable {
        let provider: String
        let createdAt: Double
    }
    let welcomedAt: Double?
    let provider: String
    let session: Session?
    let launchGateEnabled: Bool
}

/// POST /api/identity/login — ok + plain detail; a session rides
/// along on success. A refusal answers 401 with this same shape.
struct IdentityLoginResult: Decodable {
    let ok: Bool
    let detail: String
    let session: IdentitySessionStatus.Session?
}

struct PanelStatus: Decodable {
    let version: String
    let killed: Bool
}

struct PanelJob: Decodable, Identifiable {
    let id: String
    let kind: String
    let state: String
    let updatedAt: Double
}

/// The live-call session state (v0.9.1 protocol, unchanged):
/// phase is "listening" | "thinking" | "speaking" | "ended".
/// sttMode/ttsMode are the call's RESOLVED engines ("local" |
/// "endpoint") after the call-start probe — the app runs its own
/// recognizer when sttMode is "local" and speaks text segments
/// itself when ttsMode is "local".
struct VoiceSessionState: Decodable {
    struct Turn: Decodable, Identifiable {
        let index: Int
        let kind: String
        let detail: String
        let transcript: String?
        let replyText: String?
        let interrupted: Bool
        var id: Int { index }
    }
    let ok: Bool
    let detail: String
    let active: Bool
    let sessionId: String?
    let phase: String?
    let sttMode: String?
    let ttsMode: String?
    let speechNotice: String?
    let turns: [Turn]
}

/// GET /api/chat/history — the core's chat transcript (v0.6):
/// "in" is the operator's submitted text, "out" is what the
/// host delivered back (egress-screened before it was
/// recorded). Oldest first; the durable source is chat.jsonl
/// in the core's state. The jobs array rides along in the
/// response and is not decoded here — the Activity tab reads
/// jobs from /api/jobs.
struct PanelChatHistory: Decodable {
    struct Message: Decodable {
        let ts: Double
        let direction: String
        let text: String
    }
    let conversationId: String
    let messages: [Message]
}

/// One synced chat record (v0.26.0) — the wire shape of
/// chat-history sync, mirroring @gus/shared's
/// SyncedChatMessage: born with a UUID, the creating device's
/// ID, a per-device sequence, and a causal pointer (prevId);
/// ts is display-only. Photos ride as a count, never data.
struct ChatSyncMessage: Decodable {
    let id: String
    let deviceId: String
    let seq: Int
    let prevId: String?
    let ts: Double
    let direction: String
    let text: String
    let photos: Int?

    /// The JSON body shape for a push — prevId written
    /// explicitly (null at genesis), as the wire contract
    /// names it on every record.
    var wireDictionary: [String: Any] {
        var d: [String: Any] = [
            "id": id, "deviceId": deviceId, "seq": seq, "ts": ts,
            "direction": direction, "text": text,
        ]
        if let prevId {
            d["prevId"] = prevId
        } else {
            d["prevId"] = NSNull()
        }
        if let photos {
            d["photos"] = photos
        }
        return d
    }
}

/// POST /api/chat/sync — one exchange's answer: the records
/// the caller lacks, and the caller's IDs the core still
/// wants (sent in a follow-up exchange).
struct ChatSyncResponse: Decodable {
    let deviceId: String
    let missing: [ChatSyncMessage]
    let wantIds: [String]
    let conflicts: Int
}

/// The sync identity a live chat submission carries (v0.26.0)
/// — minted by the creating device (this phone, in
/// ChatHistoryStore) so the core records the message under
/// its birth identity instead of minting its own.
struct ChatSubmitSync {
    let id: String
    let deviceId: String
    let seq: Int
    let prevId: String?
    let ts: Double

    var wireDictionary: [String: Any] {
        var d: [String: Any] = [
            "id": id, "deviceId": deviceId, "seq": seq, "ts": ts,
        ]
        if let prevId {
            d["prevId"] = prevId
        } else {
            d["prevId"] = NSNull()
        }
        return d
    }
}

/// One spoken segment of a reply, in seq order: either audio
/// (audioBase64 + its content type) or — in built-in TTS mode —
/// a `text` the app speaks with its own synthesizer. ok with no
/// seq means nothing is ready yet.
struct VoiceAudioSegment: Decodable {
    let ok: Bool
    let detail: String
    let seq: Int?
    let audioBase64: String?
    let audioContentType: String?
    let text: String?
}

// MARK: - Settings (core address in defaults, token in Keychain)

enum GUSSettings {
    private static let urlKey = "gus.core.baseURL"

    /// Empty until the operator connects the phone to their core
    /// — there is no meaningful default address on a phone.
    static var baseURLString: String {
        get { UserDefaults.standard.string(forKey: urlKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: urlKey) }
    }

    static var baseURL: URL? {
        let s = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : URL(string: s)
    }

    static var isConfigured: Bool { baseURL != nil && !token.isEmpty }

    static var token: String {
        get { Keychain.read("gus.core.token") ?? "" }
        set { Keychain.write("gus.core.token", newValue) }
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
            case .notConfigured: return "Connect this iPhone to your GUS core first (Settings tab)."
            case .http(let code, let body): return "Core answered HTTP \(code): \(body)"
            }
        }
    }

    private func url(_ path: String, query: [String: String] = [:]) throws -> URL {
        guard let base = GUSSettings.baseURL, !GUSSettings.token.isEmpty else {
            throw ClientError.notConfigured
        }
        guard var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw ClientError.notConfigured
        }
        let basePath = comps.path.hasSuffix("/") ? String(comps.path.dropLast()) : comps.path
        comps.path = basePath + path
        if !query.isEmpty {
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = comps.url else { throw ClientError.notConfigured }
        return url
    }

    /// One request; returns the body + status without throwing
    /// on HTTP errors, for the routes whose refusal IS the
    /// answer's shape (login). Everything else uses request().
    private func requestRaw(
        _ path: String,
        method: String = "GET",
        query: [String: String] = [:],
        jsonBody: [String: Any]? = nil,
        rawBody: Data? = nil,
        contentType: String? = nil
    ) async throws -> (Data, Int) {
        var req = URLRequest(url: try url(path, query: query))
        req.httpMethod = method
        // The panel's documented auth: Authorization: Bearer <token>.
        req.setValue("Bearer \(GUSSettings.token)", forHTTPHeaderField: "authorization")
        if let jsonBody {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: jsonBody)
        } else if let rawBody {
            if let contentType { req.setValue(contentType, forHTTPHeaderField: "content-type") }
            req.httpBody = rawBody
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        return (data, (resp as? HTTPURLResponse)?.statusCode ?? 0)
    }

    private func request(
        _ path: String,
        method: String = "GET",
        query: [String: String] = [:],
        jsonBody: [String: Any]? = nil,
        rawBody: Data? = nil,
        contentType: String? = nil
    ) async throws -> Data {
        let (data, status) = try await requestRaw(
            path, method: method, query: query,
            jsonBody: jsonBody, rawBody: rawBody, contentType: contentType)
        guard (200..<300).contains(status) else {
            throw ClientError.http(status, String(data: data, encoding: .utf8) ?? "")
        }
        return data
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data)
    }

    // MARK: Identity (R1 — the same account as the Mac app)

    func identitySession() async throws -> IdentitySessionStatus {
        try decode(IdentitySessionStatus.self, await request("/api/identity/session"))
    }

    /// Sign-in answers 200 (signed in) or 401 (refused, with the
    /// reason in the same shape) — decode either way; a transport
    /// or HTTP failure above those is still an error.
    func login(username: String, password: String) async throws -> IdentityLoginResult {
        let (data, status) = try await requestRaw(
            "/api/identity/login", method: "POST",
            jsonBody: ["username": username, "password": password])
        guard status == 200 || status == 401 else {
            throw ClientError.http(status, String(data: data, encoding: .utf8) ?? "")
        }
        return try decode(IdentityLoginResult.self, data)
    }

    @discardableResult
    func logout() async throws -> ActionResult {
        try decode(ActionResult.self, await request("/api/identity/logout", method: "POST"))
    }

    // MARK: Status + jobs (the Activity tab's scaffold feed)

    func status() async throws -> PanelStatus {
        try decode(PanelStatus.self, await request("/api/status"))
    }

    func jobs() async throws -> [PanelJob] {
        try decode([PanelJob].self, await request("/api/jobs"))
    }

    // MARK: Chat (the panel's Chat channel, v0.6)

    /// Submit one typed chat message to the core. The reply
    /// is NOT in this response: the core's chat channel is
    /// asynchronous — the message goes through the same scan,
    /// job pipeline, and receipts as any channel message, and
    /// the answer lands in chatHistory() as an "out" message.
    /// A refusal (empty, or over the 8,000-character limit)
    /// answers 400 with this same shape — decode either way.
    ///
    /// v0.24.0: `images` carries the message's photos (JPEG
    /// data, downscaled and re-encoded by the chat view at
    /// attach time). They ride the same POST as base64 and the
    /// core presents them to its brain as image input; the
    /// core's transcript records only the count. A photo-only
    /// message (empty text) is a valid submission.
    func chat(text: String, images: [Data] = [], sync: ChatSubmitSync? = nil) async throws -> ActionResult {
        var body: [String: Any] = ["text": text]
        if !images.isEmpty {
            body["images"] = images.map {
                ["mediaType": "image/jpeg", "data": $0.base64EncodedString()]
            }
        }
        if let sync {
            body["sync"] = sync.wireDictionary
        }
        let (data, status) = try await requestRaw(
            "/api/chat", method: "POST", jsonBody: body)
        guard status == 200 || status == 400 else {
            throw ClientError.http(status, String(data: data, encoding: .utf8) ?? "")
        }
        return try decode(ActionResult.self, data)
    }

    /// One chat-history sync exchange (v0.26.0): name the
    /// record IDs this phone holds, optionally push records
    /// the core wants; the answer carries the records this
    /// phone lacks plus the IDs the core still wants. Pushed
    /// records are HISTORY on the core — recorded verbatim,
    /// never emitted as channel events (they were answered,
    /// or deliberately never dispatched, where they were
    /// born). Live dispatch is chat() above, never this.
    func chatSync(deviceId: String, haveIds: [String], messages: [ChatSyncMessage]) async throws -> ChatSyncResponse {
        var body: [String: Any] = ["deviceId": deviceId, "haveIds": haveIds]
        if !messages.isEmpty {
            body["messages"] = messages.map { $0.wireDictionary }
        }
        return try decode(ChatSyncResponse.self, await request("/api/chat/sync", method: "POST", jsonBody: body))
    }

    func chatHistory() async throws -> PanelChatHistory {
        try decode(PanelChatHistory.self, await request("/api/chat/history"))
    }

    // MARK: The live call (voice session protocol, v0.9.1)

    func voiceSessionStart() async throws -> VoiceSessionState {
        try decode(VoiceSessionState.self, await request("/api/voice/session/start", method: "POST"))
    }

    func voiceSessionState(sessionId: String) async throws -> VoiceSessionState {
        try decode(VoiceSessionState.self, await request("/api/voice/session/state", query: ["session": sessionId]))
    }

    func voiceSessionNextAudio(sessionId: String, afterSeq: Int) async throws -> VoiceAudioSegment {
        try decode(VoiceAudioSegment.self, await request(
            "/api/voice/session/next-audio",
            query: ["session": sessionId, "after": String(afterSeq)]))
    }

    /// A final transcript from this phone's own recognizer, for
    /// calls whose resolved STT mode is "local" — it takes the
    /// identical session turn a transcribed utterance takes.
    @discardableResult
    func voiceSessionTranscript(sessionId: String, text: String) async throws -> ActionResult {
        try decode(ActionResult.self, await request(
            "/api/voice/session/transcript", method: "POST",
            jsonBody: ["sessionId": sessionId, "text": text]))
    }

    /// A raw PCM16 audio chunk, for calls whose resolved STT
    /// mode is "endpoint" — the session id rides the query
    /// string; the body is the breath, not a document.
    @discardableResult
    func voiceSessionAudio(sessionId: String, chunk: Data) async throws -> ActionResult {
        try decode(ActionResult.self, await request(
            "/api/voice/session/audio", method: "POST",
            query: ["session": sessionId], rawBody: chunk, contentType: "audio/pcm"))
    }

    /// Barge-in: cut the reply's speech. Deliberately NOT a
    /// stop — a running job keeps running; only the talking ends.
    @discardableResult
    func voiceSessionInterrupt(sessionId: String) async throws -> ActionResult {
        try decode(ActionResult.self, await request(
            "/api/voice/session/interrupt", method: "POST",
            jsonBody: ["sessionId": sessionId]))
    }

    @discardableResult
    func voiceSessionEnd(sessionId: String) async throws -> ActionResult {
        try decode(ActionResult.self, await request(
            "/api/voice/session/end", method: "POST",
            jsonBody: ["sessionId": sessionId]))
    }
}
