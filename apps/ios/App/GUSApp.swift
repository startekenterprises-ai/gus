import SwiftUI
import UIKit

/// The UIKit delegate, present for exactly one job (v0.28.0):
/// background model downloads. When a brain download finishes
/// while the app is terminated, the system relaunches the app
/// in the background and calls handleEventsForBackgroundURLSession;
/// the completion handler it hands over is parked in
/// GUSBackgroundSessionEvents and run by ModelLibrary once the
/// background session's delegate has seen every pending event
/// (urlSessionDidFinishEvents). Touching ModelLibrary.shared
/// here — and at every ordinary launch — recreates the
/// background session under its identifier, which is what
/// reconnects the app to downloads still in flight.
final class GUSAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        _ = ModelLibrary.shared
        return true
    }

    func application(_ application: UIApplication,
                     handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == ModelLibrary.backgroundSessionIdentifier else {
            completionHandler()
            return
        }
        GUSBackgroundSessionEvents.completionHandler = completionHandler
        _ = ModelLibrary.shared
    }
}

/// GUS — the unified iPhone app (v0.15.0, "the front door",
/// redo R4). One app, one identity: this replaces the retired
/// companion (apps/companion) and its pairing flow. The phone
/// signs in with the same GUS identity as the Mac, and its
/// front door is a live voice call — see CallView.
@main
struct GUSApp: App {
    @UIApplicationDelegateAdaptor(GUSAppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
