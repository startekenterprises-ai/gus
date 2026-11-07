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
    var settings: Settings

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
