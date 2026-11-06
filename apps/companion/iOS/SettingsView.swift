import SwiftUI

/// Connection settings. The token goes to the Keychain; the base URL
/// is a plain default. Saving confirms visibly — the operator should
/// never have to wonder whether a setting exists.
struct SettingsView: View {
    @State private var baseURL: String = GUSSettings.baseURLString
    @State private var token: String = GUSSettings.token
    @State private var savedNote: String?
    @State private var testNote: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Panel") {
                    TextField("Panel address", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Operator token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("The token is the one in ~/.gus/state/panel-token on the Mac. Point the address at the Mac itself — its Tailscale name works well (e.g. http://imac.tailnet:8731). The panel is operator-grade: never expose it to the open internet.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button("Save settings") {
                        GUSSettings.baseURLString = baseURL
                        GUSSettings.token = token
                        savedNote = "Saved — address and token are on file (token in the Keychain)."
                    }
                    Button("Test the connection") {
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
        }
    }
}
