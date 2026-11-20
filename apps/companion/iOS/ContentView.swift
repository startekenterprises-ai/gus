import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            StatusView()
                .tabItem { Label("Status", systemImage: "gauge.with.dots.needle.33percent") }
            ApprovalsView()
                .tabItem { Label("Approvals", systemImage: "checkmark.shield") }
            JobsView()
                .tabItem { Label("Jobs", systemImage: "list.bullet.rectangle") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}
