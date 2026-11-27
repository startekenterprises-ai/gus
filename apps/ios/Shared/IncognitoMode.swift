import Combine
import Foundation

/// Incognito mode (v0.34.0) — a conversation that is never
/// saved: held in memory only, never born into the sync
/// store, never sent through either sync door, and gone
/// when the operator leaves incognito or the app closes.
///
/// The state itself is as ephemeral as the conversations
/// it governs: this flag lives ONLY in this process's
/// memory. It is never written to UserDefaults, never to a
/// file, never synced — so the app launches in normal mode
/// on every launch by construction, not by a cleanup pass.
/// One shared instance, because three surfaces must agree
/// on the mode at all times: Chat (the toggle, the banner,
/// the send path), the call session (a call started while
/// incognito keeps its transcripts and receipts out of
/// every persistent log), and the Shield receipt log's
/// callers (incognito scans produce ephemeral receipts —
/// see ShieldReceiptLog.recordEphemeral).
final class IncognitoMode: ObservableObject {
    static let shared = IncognitoMode()

    @Published var isOn = false

    private init() {}
}
