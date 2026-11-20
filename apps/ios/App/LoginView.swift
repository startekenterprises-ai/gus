import SwiftUI

/// The sign-in screen: the same R1 identity as the Mac app,
/// the same offers, no more — "Continue" for the no-login
/// local provider, username + password when the install's
/// active provider is local-password, and the hosted providers
/// (Google / Apple / enterprise SSO) listed DISABLED with the
/// seam's own reason, exactly as the Mac's login screen does.
///
/// First run also carries the connection: the core's address
/// (the Mac's Tailscale name) and its panel token — transport,
/// not identity (see GUSClient's header). Those fields live in
/// Settings afterwards; they lead here only because nothing
/// can sign in until the phone can reach the core.
struct LoginView: View {
    @ObservedObject var model: SessionModel
    @State private var username = ""
    @State private var password = ""
    @State private var coreAddress = GUSSettings.baseURLString
    @State private var coreToken = GUSSettings.token

    private var provider: String {
        if case .needsLogin(let provider) = model.state { return provider }
        return "local"
    }

    private var needsConnection: Bool {
        if case .needsConnection = model.state { return true }
        return false
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                ZStack {
                    Circle().fill(Color.accentColor.opacity(0.15))
                    Text("G")
                        .font(.system(size: 44, weight: .bold, design: .rounded))
                        .foregroundColor(.accentColor)
                }
                .frame(width: 96, height: 96)
                .padding(.top, 24)

                Text("Welcome to GUS")
                    .font(.title2)
                    .fontWeight(.semibold)
                Text("Sign in with the same GUS identity as your Mac. Signed in, GUS opens straight in — until you sign out in Settings.")
                    .font(.callout)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 340)

                if needsConnection {
                    connectionSection
                }
                if provider == "local-password" {
                    signInForm
                } else if !needsConnection {
                    continueSection
                }
                hostedProviders

                if let error = model.errorText {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.orange)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 340)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity)
        }
    }

    /// Reach the core: its address + the panel token. Saved to
    /// defaults/Keychain on tap, then the session readout
    /// decides what this screen shows next.
    private var connectionSection: some View {
        VStack(spacing: 8) {
            TextField("Core address — e.g. https://your-mac.<tailnet>:8731", text: $coreAddress)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .frame(maxWidth: 340)
            SecureField("Panel token (from ~/.gus/state/panel-token on the Mac)", text: $coreToken)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .frame(maxWidth: 340)
            Button {
                GUSSettings.baseURLString = coreAddress
                GUSSettings.token = coreToken
                Task { await model.refresh() }
            } label: {
                Text(model.busy ? "One moment…" : "Connect")
                    .frame(maxWidth: 280)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(coreAddress.isEmpty || coreToken.isEmpty)
            Text("Reach your core the way you'd reach anything on your own machine — Tailscale is the reliable route. Never expose the panel to the open internet: the token is a bearer credential, and it lives in this iPhone's Keychain.")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 340)
        }
    }

    private var continueSection: some View {
        Button {
            Task { await model.continueLocal() }
        } label: {
            Text(model.busy ? "One moment…" : "Continue")
                .frame(maxWidth: 280)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(model.busy)
    }

    private var signInForm: some View {
        VStack(spacing: 8) {
            TextField("Username", text: $username)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .frame(maxWidth: 340)
            SecureField("Password", text: $password)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 340)
                .onSubmit { Task { await model.login(username: username, password: password) } }
            Button {
                Task { await model.login(username: username, password: password) }
            } label: {
                Text(model.busy ? "Signing in…" : "Sign in")
                    .frame(maxWidth: 280)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.busy
                || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || password.isEmpty)
        }
    }

    /// The hosted seam, shown honestly — present so the shape
    /// is visible, disabled because this build configures none
    /// of it (the Mac login screen's words, kept).
    private var hostedProviders: some View {
        VStack(spacing: 6) {
            Divider()
                .frame(maxWidth: 320)
                .padding(.vertical, 4)
            ForEach(["Google", "Apple", "Enterprise SSO"], id: \.self) { name in
                Button { } label: {
                    Text("Continue with \(name)")
                        .frame(maxWidth: 280)
                }
                .buttonStyle(.bordered)
                .disabled(true)
            }
            Text("Google, Apple, and SSO sign-in aren't configured in this build.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}
