import SwiftUI

/// Connection settings. The credential goes to the Keychain; the
/// base URL is a plain default. Two ways in, honestly labeled:
/// pairing (the easy way — scan the Mac's QR code and this phone
/// gets its OWN credential, revocable from the Mac) and the
/// manual operator token (the original way, kept as a fallback).
struct SettingsView: View {
    @State private var baseURL: String = GUSSettings.baseURLString
    @State private var token: String = GUSSettings.token
    @State private var savedNote: String?
    @State private var testNote: String?
    @State private var pairingPresented = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Pairing") {
                    Button {
                        pairingPresented = true
                    } label: {
                        Label("Pair with a QR code", systemImage: "qrcode.viewfinder")
                    }
                    Text("The easy way: on the Mac, open GUS Settings → Devices and choose Pair a device, then scan the code it shows. This phone receives its own credential — the operator token never leaves the Mac — and the Mac can revoke this phone at any time from its Devices list.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Panel (manual)") {
                    TextField("Panel address", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Operator token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("The manual way: the token is the one in ~/.gus/state/panel-token on the Mac. Point the address at the Mac itself — its Tailscale name works well (e.g. https://imac.tailnet:8731). The panel is operator-grade: never expose it to the open internet. If you paired by QR code, this phone's own device credential is what sits in the Keychain — the address above is the one pairing set.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button("Save settings") {
                        save()
                        savedNote = "Saved — address and credential are on file (credential in the Keychain)."
                    }
                    Button("Test the connection") {
                        // v0.12.0: test what you typed — the test
                        // saves the form's values first, then
                        // tests, so it can never report on stale
                        // settings while the form shows new ones
                        // (the old trap: Test read the Keychain,
                        // not the form, so an unsaved fix tested
                        // as a failure).
                        save()
                        savedNote = "Saved — now testing what you typed."
                        Task {
                            do {
                                let s = try await GUSClient.shared.status()
                                testNote = "Connected — GUS v\(s.version), \(s.killed ? "stopped" : "live"), mode \(s.governorMode)."
                            } catch {
                                testNote = "Couldn't connect: \(error.localizedDescription)"
                            }
                        }
                    }
                    if let savedNote { Text(savedNote).font(.footnote).foregroundStyle(.green) }
                    if let testNote { Text(testNote).font(.footnote) }
                }
            }
            .navigationTitle("Settings")
            .sheet(isPresented: $pairingPresented, onDismiss: reloadFromSettings) {
                PairingView()
            }
        }
    }

    private func save() {
        GUSSettings.baseURLString = baseURL
        GUSSettings.token = token
    }

    /// After a pairing, the form must show what pairing set —
    /// the address it landed on and the credential now on file —
    /// not the values the form happened to open with.
    private func reloadFromSettings() {
        baseURL = GUSSettings.baseURLString
        token = GUSSettings.token
        if !GUSSettings.token.isEmpty {
            savedNote = "Paired — the address and this phone's credential are on file (credential in the Keychain)."
        }
    }
}
