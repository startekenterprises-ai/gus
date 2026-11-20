import SwiftUI

/// The launch gate (v0.14.5): the first-run login screen, and
/// the screen a signed-out install opens to. It stands in
/// front of the main window — no chat, jobs, or settings
/// behind it — and lifts the moment the model's gate readout
/// says this launch may pass (see DesktopModel.loginGateActive).
///
/// What it offers is exactly what the identity seam can do in
/// this build, no more: "Continue on this Mac" (no-login
/// local — the machine is the lock, pre-selected by being the
/// primary action), a local username/password (sign in, or —
/// on first run — set one up and continue), and the hosted
/// providers (Google / Apple / enterprise SSO) listed DISABLED
/// with the seam's own plain reason: they aren't configured in
/// this build. The screen says what it is, on its face: a
/// launch screen, not a new security boundary — GUS still
/// lives on this Mac, behind this Mac's own login, and the
/// app→panel channel is untouched by it.
struct LoginView: View {
    @ObservedObject var model: DesktopModel
    @State private var username = ""
    @State private var password = ""
    @State private var showPasswordSetup = false

    private var isFirstRun: Bool { model.identitySession?.welcomedAt == nil }
    private var provider: String { model.identitySession?.provider ?? "local" }

    var body: some View {
        VStack(spacing: 14) {
            Image(nsImage: model.displayAvatarImage)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 96, height: 96)
                .clipShape(Circle())
                .shadow(radius: 6, y: 2)
                .padding(.top, 8)
            Text(isFirstRun ? "Welcome to GUS" : "Welcome back")
                .font(.title2)
                .fontWeight(.semibold)
            Text("This screen shows once on a new install, and again whenever you're signed out. It's a launch screen, not a new lock — GUS lives on this Mac, behind this Mac's own login.")
                .font(.callout)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 430)

            if provider == "local-password" {
                signInForm
            } else {
                continueSection
            }

            hostedProviders
            if let error = model.loginError {
                Text(error)
                    .font(.caption)
                    .foregroundColor(.orange)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 430)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The no-login path, plus the first-run offer to set a
    /// password instead: one tap continues; the password path
    /// unfolds in place (username + password + one button that
    /// sets the credential, activates the provider, and signs
    /// in — the model's chained flow).
    private var continueSection: some View {
        VStack(spacing: 10) {
            Button {
                model.loginContinueOnThisMac()
            } label: {
                Text(model.loginBusy ? "One moment…" : "Continue on this Mac")
                    .frame(maxWidth: 280)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.loginBusy)
            .help("No-login local identity — being able to run GUS on this Mac at all is the sign-in. GUS opens straight in from now on.")

            if showPasswordSetup {
                VStack(spacing: 8) {
                    TextField("Username", text: $username)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 280)
                    SecureField("Password (8+ characters)", text: $password)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 280)
                        .onSubmit { model.loginSetPassword(username: username, password: password) }
                    Button {
                        model.loginSetPassword(username: username, password: password)
                    } label: {
                        Text("Set password & continue")
                            .frame(maxWidth: 280)
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.loginBusy
                        || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || password.isEmpty)
                    Text("Only a scrypt digest of the password is stored — never the password itself. From then on, GUS asks for it whenever you're signed out.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 380)
                }
                .padding(.top, 4)
            } else {
                Button("Use a password instead") { showPasswordSetup = true }
                    .buttonStyle(.plain)
                    .foregroundColor(.accentColor)
                    .font(.callout)
            }
        }
    }

    /// The returning sign-in: the active provider is already
    /// local-password, so the form is the whole offer (plus the
    /// hosted rows below, still disabled).
    private var signInForm: some View {
        VStack(spacing: 8) {
            TextField("Username", text: $username)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 280)
            SecureField("Password", text: $password)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 280)
                .onSubmit { model.login(username: username, password: password) }
            Button {
                model.login(username: username, password: password)
            } label: {
                Text(model.loginBusy ? "Signing in…" : "Sign in")
                    .frame(maxWidth: 280)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.loginBusy
                || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || password.isEmpty)
            Text("Signed in, GUS opens straight in — until you sign out in Settings → Devices & identity.")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
    }

    /// The hosted seam, shown honestly: present so the shape
    /// is visible, disabled because this build configures none
    /// of it — the same words the Settings identity pane uses.
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
                .help("\(name) sign-in isn't configured in this build — the provider seam exists so the hosted edition can add it without another identity redesign.")
            }
            Text("Google, Apple, and SSO sign-in aren't configured in this build.")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}
