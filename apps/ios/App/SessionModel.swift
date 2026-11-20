import Foundation

/// The sign-in state of this install, read from the core's
/// identity session (R1). The launch flow mirrors the Mac
/// app's gate (v0.14.5): at launch, ask the core whether a
/// session is live; if it is, open straight in — log in once,
/// stay logged in — and only show LoginView when there is no
/// session, no connection, or the operator signs out.
@MainActor
final class SessionModel: ObservableObject {
    enum State: Equatable {
        case checking
        /// No core address/token yet — the login screen leads
        /// with the connection fields.
        case needsConnection
        /// Connected, no live session — show the sign-in form
        /// for the identity's active provider.
        case needsLogin(provider: String)
        case signedIn(provider: String)
        /// The core is unreachable (airplane mode, Mac asleep)
        /// but this install HAS signed in before: open the app
        /// on the strength of that. On-device calls work fully;
        /// core-backed tabs surface their own errors until the
        /// core answers again. Without a prior sign-in there is
        /// nothing to open on — the gate holds (chunk 2).
        case signedInOffline(provider: String)
    }

    @Published private(set) var state: State = .checking
    @Published private(set) var busy = false
    @Published var errorText: String?

    private let client = GUSClient.shared

    /// The provider of the last live session this install saw,
    /// persisted across launches — the only thing the offline
    /// state stands on.
    private static let lastProviderKey = "gus.identity.lastProvider"

    private var lastProvider: String? {
        get { UserDefaults.standard.string(forKey: Self.lastProviderKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.lastProviderKey) }
    }

    func refresh() async {
        guard GUSSettings.isConfigured else {
            state = .needsConnection
            return
        }
        do {
            let status = try await client.identitySession()
            if let session = status.session {
                lastProvider = session.provider
                state = .signedIn(provider: session.provider)
            } else {
                state = .needsLogin(provider: status.provider)
            }
        } catch {
            // A core we cannot reach: if this install has a
            // sign-in behind it, open offline (on-device calls
            // don't need the core); otherwise the login screen
            // shows the fields and the error, as before.
            errorText = error.localizedDescription
            if let provider = lastProvider {
                state = .signedInOffline(provider: provider)
            } else {
                state = .needsConnection
            }
        }
    }

    /// The no-login local provider: being able to reach your
    /// own core at all is the sign-in (the Mac's "Continue on
    /// this Mac", worded for a phone: "Continue").
    func continueLocal() async {
        await signIn(username: "", password: "")
    }

    func login(username: String, password: String) async {
        await signIn(username: username, password: password)
    }

    private func signIn(username: String, password: String) async {
        busy = true
        errorText = nil
        defer { busy = false }
        do {
            let result = try await client.login(username: username, password: password)
            if result.ok {
                await refresh()
            } else {
                errorText = result.detail
            }
        } catch {
            errorText = error.localizedDescription
        }
    }

    func signOut() async {
        busy = true
        defer { busy = false }
        _ = try? await client.logout()
        // Signing out forgets the offline credential too — the
        // next launch gates at the login screen, core or no core.
        lastProvider = nil
        await refresh()
    }
}
