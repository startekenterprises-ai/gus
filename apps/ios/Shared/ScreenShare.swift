import Foundation

/// Screen viewing in calls (v0.45.0): the bridge between
/// the app and its ReplayKit Broadcast Upload Extension,
/// across the shared app group.
///
/// The shape of the problem: the operator starts screen
/// sharing from the SYSTEM's broadcast UI (Apple's rule —
/// per-session consent, every time), and the broadcast
/// runs in the EXTENSION's process, not the app's. The two
/// processes share exactly one piece of ground: the app
/// group container. Everything about the feature's
/// coordination lives there:
///
///   - The APP writes the live call's session info (core
///     base URL, panel token, voice session id) when a
///     Core call goes live, and clears it when the call
///     ends. That is the extension's only way to know
///     where frames go and whose call they belong to. The
///     token transits ONLY through this container — it is
///     never logged on either side, never shown, and it is
///     the same token the app itself already holds in its
///     Keychain for the same core.
///   - The EXTENSION maintains the broadcast's state in
///     the group: an active flag, a heartbeat it refreshes
///     with every frame it posts, and one rolling preview
///     JPEG (overwritten, never accumulated) the app shows
///     in the call's "Your screen" tile.
///   - The APP polls that state while a Core call is live
///     (CallSession's screen-share watch): the flag saying
///     sharing stopped — or a heartbeat gone stale, which
///     is the same fact when the extension died without
///     saying goodbye — is how the app learns the
///     broadcast ended and tells the core to drop the
///     screen frame it holds.
///
/// The extension carries its own copy of these literals
/// (Broadcast/SampleHandler.swift) — an extension target
/// shares no source with the app here, and the pin test
/// (ios-screen-share) holds the two copies to the same
/// strings.
enum ScreenShareGroup {
    /// The app group both processes are entitled to.
    static let groupID = "group.com.startekenterprises.gus"

    /// Group-defaults keys.
    static let sessionInfoKey = "screenShare.sessionInfo"
    static let activeKey = "screenShare.active"
    static let heartbeatKey = "screenShare.heartbeat"

    /// The one rolling preview frame in the container.
    static let previewFileName = "screen-preview.jpg"

    /// A heartbeat older than this (seconds) reads as
    /// "the broadcast is over": the extension refreshes it
    /// with every frame it posts (one per ~5 s while the
    /// screen is up), so two missed beats is a stop, not a
    /// pause. A paused broadcast (the system's pause) also
    /// stops the frames — and reads as stopped here, which
    /// is the truth the call should act on: no new screen
    /// is arriving.
    static let heartbeatStaleSeconds: TimeInterval = 12

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: groupID)
    }

    static var containerURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: groupID)
    }

    static var previewURL: URL? {
        containerURL?.appendingPathComponent(previewFileName)
    }

    /// The broadcast's live state, as the extension last
    /// wrote it: sharing only while the flag stands AND
    /// the heartbeat is fresh.
    static var broadcastActive: Bool {
        guard let defaults, defaults.bool(forKey: activeKey) else { return false }
        let beat = defaults.double(forKey: heartbeatKey)
        return Date().timeIntervalSince1970 - beat <= heartbeatStaleSeconds
    }
}

/// What the app hands the extension for a live Core call —
/// everything a frame post needs, nothing else. Written
/// when the call goes live, cleared when it ends; a stale
/// copy (a call that died without clearing) is refused by
/// the extension when the core answers that the session
/// is over, and overwritten by the next call regardless.
struct ScreenShareSessionInfo: Codable {
    let baseURL: String
    let token: String
    let sessionId: String
    /// When the app wrote this (epoch seconds) — the
    /// extension's staleness read: session info from a
    /// call that ended hours ago is not a door to post
    /// through, even before the core refuses it.
    let writtenAt: Double

    /// Session info older than this is stale on its face:
    /// a voice session's own ceiling is one hour (the
    /// core's max session length), so nothing older can
    /// name a live call.
    static let maxAgeSeconds: Double = 3_600

    var isStale: Bool {
        Date().timeIntervalSince1970 - writtenAt > Self.maxAgeSeconds
    }

    static func write(baseURL: String, token: String, sessionId: String) {
        let info = ScreenShareSessionInfo(
            baseURL: baseURL, token: token, sessionId: sessionId,
            writtenAt: Date().timeIntervalSince1970)
        guard let defaults = ScreenShareGroup.defaults,
              let data = try? JSONEncoder().encode(info) else { return }
        defaults.set(data, forKey: ScreenShareGroup.sessionInfoKey)
    }

    static func clear() {
        ScreenShareGroup.defaults?.removeObject(
            forKey: ScreenShareGroup.sessionInfoKey)
    }

    static func read() -> ScreenShareSessionInfo? {
        guard let data = ScreenShareGroup.defaults?.data(
            forKey: ScreenShareGroup.sessionInfoKey) else { return nil }
        return try? JSONDecoder().decode(ScreenShareSessionInfo.self, from: data)
    }
}
