import Foundation

/// The desktop app's one channel to GUS: the local operator panel
/// (127.0.0.1:8731), authenticated with the same Bearer token the
/// web panel uses — read from ~/.gus/state/panel-token, the 0600
/// file the control plane mints at first boot. The app holds no
/// authority of its own: every read and action here is a panel API
/// call, and the panel delegates to the same engines the channels
/// use. No new ports, no second credential.
///
/// The Decodable shapes below mirror packages/panel/src/types.ts
/// field for field. Unknown keys are ignored by the decoder, so a
/// panel that grows fields never breaks this client.

struct PanelStatus: Decodable {
    var version: String
    var killed: Bool
    var shield: Shield
    var provider: Provider
    var pendingApprovals: Int
    var spendTodayUsd: Double
    var spendMonthUsd: Double
    var governorMode: String
    var permissiveToday: PermissiveToday
    var settings: Settings

    struct PermissiveToday: Decodable {
        var count: Int
        var recent: [LetThrough]
        struct LetThrough: Decodable {
            var ts: Double
            var kind: String
            var detail: String
        }
    }

    struct Shield: Decodable {
        var provisioned: Bool
        var required: Bool
        var onUnavailable: String
        var baseUrl: String
    }
    struct Provider: Decodable {
        var id: String
        var model: String
    }
    struct Settings: Decodable {
        var providerKey: String // "stored" | "missing" | "not-required"
        var telegramConfigured: Bool
        var caps: Caps
        var delegates: Int
        var macWorkDirs: Int
        var approverPolicy: ApproverPolicy
        var voice: Voice
    }
    /// v0.9: the voice channel on file — presence only, like the
    /// rest of the readout (the URLs live behind /api/voice/settings).
    struct Voice: Decodable {
        var enabled: Bool
        var configured: Bool
    }
    struct Caps: Decodable {
        var maxUsdPerTask: Double?
        var maxUsdPerDay: Double?
        var maxUsdPerMonth: Double?
    }
    struct ApproverPolicy: Decodable {
        var gusApprovesDelegates: Bool
        var gusApprovesOwn: Bool
        var delegatesMayApprove: Bool
        var scope: String
        var maxApprovalsPerHour: Int
    }
}

struct PanelJob: Decodable, Identifiable {
    var id: String
    var kind: String
    var state: String
    var createdAt: Double // unix ms
    var updatedAt: Double // unix ms
    var costUsd: Double
    var tokensIn: Int
    var tokensOut: Int
    var outcomeNote: String?
    var receiptId: String?
}

struct PanelChatMessage: Decodable {
    var ts: Double // unix ms
    var direction: String // "in" (operator) | "out" (GUS)
    var text: String
}

struct PanelChatHistory: Decodable {
    var conversationId: String
    var messages: [PanelChatMessage]
    var jobs: [PanelJob]
}

struct PanelApproval: Decodable, Identifiable {
    var id: String
    var jobId: String
    var summary: String
    var reason: String
    var createdAt: Double // unix ms
    var expiresAt: Double // unix ms
}

struct PanelApprovalHistoryEntry: Decodable, Identifiable {
    var id: String
    var jobId: String
    var summary: String
    var reason: String
    var status: String // approved | denied | expired | consumed
    var createdAt: Double // unix ms
    var resolvedAt: Double? // unix ms
    var resolvedBy: String?
}

struct PanelActionResult: Decodable {
    var ok: Bool
    var detail: String
}

/// The voice channel's settings (GET /api/voice/settings, v0.9):
/// the operator's local speech services — an OpenAI-compatible
/// transcription endpoint (faster-whisper) and speech endpoint
/// (Kokoro). Plain config; there are no secrets in this shape.
/// v0.9.1 adds bargeIn (optional here: an older panel that
/// doesn't send it decodes as nil, and the call treats nil as
/// the config default, on).
struct PanelVoiceSettings: Decodable {
    var enabled: Bool
    var sttBaseUrl: String
    var sttModel: String
    var ttsBaseUrl: String
    var ttsModel: String
    var ttsVoice: String
    var bargeIn: Bool?
}

/// One push-to-talk exchange (POST /api/voice/call, v0.9). On a
/// speech-synthesis failure ok is false and the detail says why,
/// but the reply text still arrives — the chat shows what GUS
/// said and the notice says why it wasn't spoken.
struct PanelVoiceCallResult: Decodable {
    var ok: Bool
    var kind: String
    var detail: String
    var transcript: String?
    var replyText: String?
    var audioBase64: String?
    var audioContentType: String?
}

/// One live-call turn's stage timings (v0.9.1): utterance end →
/// transcript (sttMs) → reply (jobMs) → first spoken sentence
/// (ttsFirstMs). Milliseconds, measured in the control plane.
struct PanelVoiceTurnLatency: Decodable {
    var utteranceEndAt: Double
    var sttMs: Double
    var jobMs: Double
    var ttsFirstMs: Double?
    var totalMs: Double
}

/// One settled turn of a live call (v0.9.1), as the session
/// state's transcript carries it.
struct PanelVoiceSessionTurn: Decodable, Identifiable {
    var index: Int
    var startedAt: Double // unix ms
    var transcript: String?
    var kind: String
    var detail: String
    var replyText: String?
    var interrupted: Bool
    var latency: PanelVoiceTurnLatency?
    var id: Int { index }
}

/// The live call's state (v0.9.1) — what the app polls while a
/// call runs: phase (listening | thinking | speaking | ended),
/// the transcript so far, the last turn's latency, and after an
/// ending the endedReason (operator | idle-timeout |
/// max-length | kill-phrase | disabled).
struct PanelVoiceSession: Decodable {
    var ok: Bool
    var detail: String
    var active: Bool
    var sessionId: String?
    var phase: String?
    var startedAt: Double?
    var elapsedMs: Double?
    var endedReason: String?
    var bargeIn: Bool?
    var turns: [PanelVoiceSessionTurn]
    var lastLatency: PanelVoiceTurnLatency?
}

/// One spoken segment of a live call's reply (v0.9.1): a single
/// sentence's audio, fetched in seq order. ok with a nil seq
/// means nothing is ready yet.
struct PanelVoiceAudioSegment: Decodable {
    var ok: Bool
    var detail: String
    var seq: Int?
    var turnIndex: Int?
    var sentenceIndex: Int?
    var audioBase64: String?
    var audioContentType: String?
}

/// The onboarding read model (GET /api/onboarding) — the wizard's
/// step state, shared by the web setup panel and (v0.8) the app's
/// first-run setup flow and Settings window. `currentProvider` is
/// optional in the payload until a provider step has been saved.
struct PanelOnboarding: Decodable {
    var steps: Steps
    var suggestedCaps: SuggestedCaps
    var currentProvider: CurrentProvider?

    struct Steps: Decodable {
        var shield: Step
        var telegram: Step
        var provider: Step
        var caps: Step
        var firstJob: Step
    }
    struct Step: Decodable {
        var done: Bool
        var detail: String?
    }
    struct SuggestedCaps: Decodable {
        var maxUsdPerTask: Double
        var maxUsdPerDay: Double
        var maxUsdPerMonth: Double
    }
    struct CurrentProvider: Decodable {
        var provider: String
        var model: String
        var baseUrl: String?
    }
}

/// One entry of the help registry (GET /api/help) — the SAME
/// registry (packages/panel/src/help.ts) the web panel's pop-ups
/// and /help page render from. The app fetches it; no help copy is
/// duplicated in Swift, so the surfaces cannot drift apart.
struct PanelHelpEntry: Decodable, Identifiable {
    var id: String
    var title: String
    var tip: String
    var body: String
}

struct PanelHelpResponse: Decodable {
    var entries: [PanelHelpEntry]
}

/// The settings detail (GET /api/settings-detail, v0.8): what the
/// status summary only counts — the Mac jail's contents and the
/// named delegates. Read-only in this release.
struct PanelSettingsDetail: Decodable {
    var macWorkDirs: [String]
    var macShellAllowlist: [String]
    var delegates: [DelegateConversation]
    var bridge: Bridge?

    struct DelegateConversation: Decodable {
        var conversationId: String
        var operatorId: String
        var delegates: [DelegateEntry]
    }
    struct DelegateEntry: Decodable {
        var name: String
        var senderId: String
    }
    struct Bridge: Decodable {
        var conversationId: String
        var senderId: String
    }
}

final class PanelClient {
    private let baseURL = URL(string: "http://127.0.0.1:8731")!

    /// Read fresh on every call: cheap, and it picks up a re-minted
    /// token without an app restart.
    private var token: String {
        let path = NSHomeDirectory() + "/.gus/state/panel-token"
        let raw = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func request(path: String, method: String, jsonBody: [String: Any]? = nil) -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let jsonBody {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: jsonBody)
        }
        return req
    }

    func get<T: Decodable>(_ path: String, as type: T.Type, completion: @escaping (Result<T, Error>) -> Void) {
        URLSession.shared.dataTask(with: request(path: path, method: "GET")) { data, response, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let data else {
                completion(.failure(NSError(domain: "gus.panel", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "the panel answered with no data"])))
                return
            }
            if let http = response as? HTTPURLResponse, http.statusCode == 401 {
                completion(.failure(NSError(domain: "gus.panel", code: 401,
                    userInfo: [NSLocalizedDescriptionKey: "the panel refused this app's token (401)"])))
                return
            }
            do {
                completion(.success(try JSONDecoder().decode(T.self, from: data)))
            } catch {
                completion(.failure(error))
            }
        }.resume()
    }

    /// An authenticated panel URL for opening in the browser (the
    /// panel plants its cookie from a valid ?t= link, so this is
    /// how in-app "open the web panel / help page" links work).
    func panelURL(_ path: String) -> URL {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "t", value: token)]
        return comps?.url ?? baseURL
    }

    /// POST an action. The panel answers every action — success,
    /// refusal, conflict — with a {ok, detail} body, so the body is
    /// decoded regardless of the HTTP status.
    func post(_ path: String, jsonBody: [String: Any]? = nil, completion: @escaping (Result<PanelActionResult, Error>) -> Void) {
        URLSession.shared.dataTask(with: request(path: path, method: "POST", jsonBody: jsonBody)) { data, _, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let data else {
                completion(.failure(NSError(domain: "gus.panel", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "the panel answered with no data"])))
                return
            }
            do {
                completion(.success(try JSONDecoder().decode(PanelActionResult.self, from: data)))
            } catch {
                completion(.failure(error))
            }
        }.resume()
    }
    /// POST a voice call: the raw recording as the body (its
    /// content type rides the header — that is the panel route's
    /// contract), the exchange as the decoded answer. A spoken
    /// reply can take as long as the job behind it, so this call
    /// gets a long timeout instead of URLSession's 60s default.
    func postVoiceCall(audio: Data, contentType: String, completion: @escaping (Result<PanelVoiceCallResult, Error>) -> Void) {
        var req = request(path: "/api/voice/call", method: "POST")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.httpBody = audio
        req.timeoutInterval = 180
        URLSession.shared.dataTask(with: req) { data, _, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let data else {
                completion(.failure(NSError(domain: "gus.panel", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "the panel answered with no data"])))
                return
            }
            do {
                completion(.success(try JSONDecoder().decode(PanelVoiceCallResult.self, from: data)))
            } catch {
                completion(.failure(error))
            }
        }.resume()
    }

    // MARK: Live voice sessions (v0.9.1)

    /// A panel URL with query items — the session routes carry
    /// the session id on the query string (the audio route's
    /// body is raw PCM; it can't carry anything else).
    private func url(_ path: String, query: [URLQueryItem]) -> URL {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        comps?.queryItems = query
        return comps?.url ?? baseURL
    }

    private func request(url: URL, method: String) -> URLRequest {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return req
    }

    /// One request, one decoded shape, the body decoded
    /// regardless of HTTP status — the session routes answer
    /// refusals with the state shape too, and a refusal is data.
    private func perform<T: Decodable>(_ req: URLRequest, as type: T.Type, completion: @escaping (Result<T, Error>) -> Void) {
        URLSession.shared.dataTask(with: req) { data, _, error in
            if let error {
                completion(.failure(error))
                return
            }
            guard let data else {
                completion(.failure(NSError(domain: "gus.panel", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "the panel answered with no data"])))
                return
            }
            do {
                completion(.success(try JSONDecoder().decode(T.self, from: data)))
            } catch {
                completion(.failure(error))
            }
        }.resume()
    }

    /// Open the live call. The answer is the fresh session's
    /// state — or the refusal, in the same shape.
    func startVoiceSession(completion: @escaping (Result<PanelVoiceSession, Error>) -> Void) {
        perform(request(path: "/api/voice/session/start", method: "POST", jsonBody: [:]),
                as: PanelVoiceSession.self, completion: completion)
    }

    /// The session poll: phase, transcript, latency, endings.
    func voiceSessionState(sessionId: String, completion: @escaping (Result<PanelVoiceSession, Error>) -> Void) {
        perform(request(url: url("/api/voice/session/state", query: [URLQueryItem(name: "session", value: sessionId)]), method: "GET"),
                as: PanelVoiceSession.self, completion: completion)
    }

    /// The next spoken segment after `afterSeq`, if one is ready.
    func voiceSessionNextAudio(sessionId: String, afterSeq: Int, completion: @escaping (Result<PanelVoiceAudioSegment, Error>) -> Void) {
        perform(request(url: url("/api/voice/session/next-audio", query: [
                    URLQueryItem(name: "session", value: sessionId),
                    URLQueryItem(name: "after", value: String(afterSeq)),
                ]), method: "GET"),
                as: PanelVoiceAudioSegment.self, completion: completion)
    }

    /// One streamed mic chunk: raw PCM16 (16 kHz mono) as the
    /// body, the session id on the query string.
    func postVoiceSessionAudio(sessionId: String, pcm: Data, completion: @escaping (Result<PanelActionResult, Error>) -> Void) {
        var req = request(url: url("/api/voice/session/audio", query: [URLQueryItem(name: "session", value: sessionId)]), method: "POST")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.httpBody = pcm
        perform(req, as: PanelActionResult.self, completion: completion)
    }

    /// Barge-in: cut the current reply's speech. Speech only —
    /// the panel route cannot stop a job or move an approval.
    func interruptVoiceSession(sessionId: String, completion: @escaping (Result<PanelActionResult, Error>) -> Void) {
        perform(request(path: "/api/voice/session/interrupt", method: "POST", jsonBody: ["sessionId": sessionId]),
                as: PanelActionResult.self, completion: completion)
    }

    /// Hang up. The answer is the ended session's final state.
    func endVoiceSession(sessionId: String, completion: @escaping (Result<PanelVoiceSession, Error>) -> Void) {
        perform(request(path: "/api/voice/session/end", method: "POST", jsonBody: ["sessionId": sessionId]),
                as: PanelVoiceSession.self, completion: completion)
    }
}

/// Small display helpers shared by the desktop views. Panel
/// timestamps are unix milliseconds; costs are dollars, always
/// shown as dollars (the Governor's unit — never percentages).
enum GusFormat {
    static func time(_ unixMs: Double) -> String {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f.string(from: Date(timeIntervalSince1970: unixMs / 1000))
    }

    static func usd(_ value: Double) -> String {
        String(format: "$%.2f", value)
    }

    static func usdCap(_ value: Double?) -> String {
        guard let value else { return "no cap on file" }
        return usd(value)
    }
}
