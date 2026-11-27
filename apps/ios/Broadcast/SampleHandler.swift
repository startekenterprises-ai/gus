import ReplayKit
import CoreImage
import ImageIO
import UniformTypeIdentifiers

/// GUS Screen Share (v0.45.0): the Broadcast Upload
/// Extension that lets a live GUS call see the operator's
/// screen.
///
/// How this runs: the operator taps Share screen in a
/// Core-mode call, the SYSTEM shows its own broadcast UI
/// (per-session consent — Apple's rule, every time), and
/// when they start the broadcast, iOS launches THIS
/// process and hands it the screen's sample buffers. The
/// system's red recording indicator is on screen the
/// whole time sharing runs; nothing here can hide it, and
/// nothing here tries.
///
/// What this process does with the screen, in full:
///   - At most one frame per ~5 seconds, one at a time —
///     a frame still posting when the next is due is a
///     reason to DROP the new one, never to queue it (the
///     extension memory ceiling is ~50 MB; a queue is how
///     an extension dies).
///   - Each taken frame is scaled to ≤768 px on its long
///     edge, encoded JPEG q0.4, and POSTed to the caller's
///     own GUS core — the same watch-frame route the call
///     camera uses, flagged source "screen". The core
///     holds it in memory only, as the call's screen view.
///   - The same JPEG overwrites ONE rolling preview file
///     in the shared app group, so the app can show the
///     operator their own shared screen in the call. It
///     is removed when the broadcast finishes. No frame
///     is written anywhere else, ever.
///
/// Where frames go comes from the app, through the app
/// group: when a Core call goes live the app writes the
/// session info (core address, panel token, voice session
/// id) there, and clears it when the call ends. The token
/// is read from that container and used for the posts —
/// never logged, never shown, never sent anywhere but the
/// operator's own core. If no live session info is there
/// (or it is stale), the broadcast finishes at once with
/// the reason in plain words: there is no call to share
/// into.
///
/// This file is deliberately self-contained: the literals
/// below (group id, keys, file name) mirror the app's
/// Shared/ScreenShare.swift, and the pin test
/// (ios-screen-share) holds the two copies to the same
/// strings — an extension target shares no source with
/// the app in this project.
final class SampleHandler: RPBroadcastSampleHandler {

    // MARK: - Shared literals (mirror Shared/ScreenShare.swift)

    private static let groupID = "group.com.startekenterprises.gus"
    private static let sessionInfoKey = "screenShare.sessionInfo"
    private static let activeKey = "screenShare.active"
    private static let heartbeatKey = "screenShare.heartbeat"
    private static let previewFileName = "screen-preview.jpg"
    private static let sessionMaxAgeSeconds: Double = 3_600

    // MARK: - Frame discipline

    /// One frame per this interval, at most.
    private static let frameIntervalSeconds: TimeInterval = 5
    /// Frames are small on purpose — the same envelope the
    /// call camera's frames travel in (Watch mode, v0.37.0).
    private static let maxLongEdge: CGFloat = 768
    private static let jpegQuality = 0.4

    private struct SessionInfo: Decodable {
        let baseURL: String
        let token: String
        let sessionId: String
        let writtenAt: Double
    }

    private var sessionInfo: SessionInfo?
    /// The core said the call is over (a 409 on a frame
    /// post): nothing more is posted, however long the
    /// broadcast itself runs — the operator stops the
    /// broadcast; this process just stops feeding a call
    /// that no longer exists.
    private var callGone = false
    private var lastFrameAt = Date.distantPast
    private var posting = false
    private let postingLock = NSLock()
    private lazy var ciContext = CIContext(options: [.useSoftwareRenderer: false])

    private var groupDefaults: UserDefaults? {
        UserDefaults(suiteName: Self.groupID)
    }

    private var previewURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.groupID)?
            .appendingPathComponent(Self.previewFileName)
    }

    // MARK: - Broadcast lifecycle

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard let info = readSessionInfo(), !isStale(info) else {
            finishBroadcastWithError(NSError(
                domain: "GUSScreenShare", code: 1,
                userInfo: [NSLocalizedDescriptionKey:
                    "Open GUS and start a call in Core mode first — screen sharing only works during a live call."]))
            return
        }
        sessionInfo = info
        markActive(heartbeat: true)
    }

    override func broadcastPaused() {
        // Nothing to do: the frames stop, the heartbeat
        // goes stale, and the app reads the pause as
        // sharing stopped — which, for the call, it is.
    }

    override func broadcastResumed() {
        markActive(heartbeat: true)
    }

    override func broadcastFinished() {
        // The goodbye the app and core rely on: flag down,
        // preview gone. (The app ALSO watches the heartbeat
        // for the case where this process is killed without
        // finishing — the two together are the stop signal.)
        if let defaults = groupDefaults {
            defaults.set(false, forKey: Self.activeKey)
            defaults.set(0.0, forKey: Self.heartbeatKey)
        }
        if let url = previewURL {
            try? FileManager.default.removeItem(at: url)
        }
        sessionInfo = nil
    }

    // MARK: - Frames

    override func processSampleBuffer(
        _ sampleBuffer: CMSampleBuffer,
        with sampleBufferType: RPSampleBufferType
    ) {
        guard sampleBufferType == .video else { return }
        guard let info = sessionInfo, !callGone else { return }
        let now = Date()
        guard now.timeIntervalSince(lastFrameAt) >= Self.frameIntervalSeconds
        else { return }
        postingLock.lock()
        if posting {
            postingLock.unlock()
            return // drop, never queue
        }
        posting = true
        postingLock.unlock()
        lastFrameAt = now

        guard let jpeg = encodeFrame(sampleBuffer) else {
            setPosting(false)
            return
        }
        // The rolling preview rides along with the post:
        // what the app shows is exactly what the core got.
        if let url = previewURL {
            try? jpeg.write(to: url, options: .atomic)
        }
        postFrame(jpeg, info: info)
    }

    /// Scale + JPEG-encode one video sample buffer. Runs on
    /// ReplayKit's delivery queue; the encode is one small
    /// image, in memory, nothing written.
    private func encodeFrame(_ sampleBuffer: CMSampleBuffer) -> Data? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return nil }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return nil }
        let longEdge = max(extent.width, extent.height)
        let scale = min(1, Self.maxLongEdge / longEdge)
        let scaled = scale < 1
            ? image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            : image
        guard let cgImage = ciContext.createCGImage(scaled, from: scaled.extent)
        else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.jpeg.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, cgImage, [
            kCGImageDestinationLossyCompressionQuality: Self.jpegQuality,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    /// POST one frame to the core's watch-frame route, as
    /// source "screen" — the same door the call camera's
    /// frames take, the same wire shape. Fire-and-forget: a
    /// failed post is superseded by the next frame seconds
    /// later; a 409 (the call ended) stops the posting for
    /// the rest of the broadcast.
    private func postFrame(_ jpeg: Data, info: SessionInfo) {
        let base = info.baseURL.trimmingCharacters(
            in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(base)/api/voice/session/watch-frame")
        else {
            setPosting(false)
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(info.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "sessionId": info.sessionId,
            "camera": "screen",
            "image": [
                "mediaType": "image/jpeg",
                "data": jpeg.base64EncodedString(),
            ],
            "turnRefresh": false,
        ])
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self else { return }
            if let http = response as? HTTPURLResponse, http.statusCode == 409 {
                self.callGone = true
            } else if let http = response as? HTTPURLResponse,
                      (200..<300).contains(http.statusCode) {
                self.markActive(heartbeat: true)
            }
            self.setPosting(false)
        }.resume()
    }

    private func setPosting(_ value: Bool) {
        postingLock.lock()
        posting = value
        postingLock.unlock()
    }

    // MARK: - Group state

    private func markActive(heartbeat: Bool) {
        guard let defaults = groupDefaults else { return }
        defaults.set(true, forKey: Self.activeKey)
        if heartbeat {
            defaults.set(
                Date().timeIntervalSince1970, forKey: Self.heartbeatKey)
        }
    }

    private func readSessionInfo() -> SessionInfo? {
        guard let data = groupDefaults?.data(forKey: Self.sessionInfoKey)
        else { return nil }
        return try? JSONDecoder().decode(SessionInfo.self, from: data)
    }

    private func isStale(_ info: SessionInfo) -> Bool {
        Date().timeIntervalSince1970 - info.writtenAt > Self.sessionMaxAgeSeconds
    }
}
