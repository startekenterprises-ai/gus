import AVFoundation
import CoreImage
import UIKit

// Watch mode capture (v0.37.0) — the call's camera, owned by
// this controller and nothing else.
//
// The shape is deliberately SerenAI's, not a video stream's
// (Glenn's SerenAI app, whose realtime vision worked well):
// the persona doesn't need a movie, it needs current stills.
// An AVCaptureSession runs the chosen camera(s); the video
// data output's delegate keeps only the LATEST frame per
// camera, converted at most twice a second and downscaled on
// conversion (long edge ≤768 px), so the sampler in
// CallSession encodes a small JPEG whenever it fires — the
// capture itself never encodes, never uploads, never writes
// a file. Frames live in this controller's memory and are
// dropped whole when it stops.
//
// Modes: front, back, or both. Both is an
// AVCaptureMultiCamSession when the device supports it
// (checked before the operator is ever offered it); if a
// both-build still fails on the day, the controller falls
// back to the back camera alone and says so through
// onEffectiveModeChange — a silent downgrade is not an
// option. The preview is a plain container view the call
// screen embeds: one preview layer filling it, or two side
// by side. The torch belongs to the back camera only.

/// One of the call's cameras — the frame slots the core
/// holds eyes for, by these names.
enum WatchCameraSlot: String, CaseIterable {
    case front
    case back
}

/// The operator's camera choice while watching. `both`
/// exists only where the device can run two cameras at
/// once; the call screen asks the controller before
/// offering it.
enum WatchCameraMode: String, CaseIterable, Identifiable {
    case front
    case back
    case both

    var id: String { rawValue }

    var slots: [WatchCameraSlot] {
        switch self {
        case .front: return [.front]
        case .back: return [.back]
        case .both: return [.front, .back]
        }
    }

    /// The camera names as the core's watch post carries
    /// them.
    var cameraNames: [String] { slots.map(\.rawValue) }

    var label: String {
        switch self {
        case .front: return "front camera"
        case .back: return "back camera"
        case .both: return "front and back cameras"
        }
    }
}

final class WatchCaptureController: NSObject {
    /// Whether this device can run both cameras at once —
    /// the gate on the Both control existing at all.
    static var isMultiCamSupported: Bool {
        AVCaptureMultiCamSession.isMultiCamSupported
    }

    /// The preview surface the call screen embeds. The
    /// controller lays its preview layer(s) out inside it;
    /// the screen just gives it a frame.
    let previewView = WatchPreviewContainerView()

    /// A both-mode build fell back to a single camera: the
    /// effective mode changed under the operator, and the
    /// call session wants to say so (and tell the core).
    var onEffectiveModeChange: ((WatchCameraMode) -> Void)?
    /// The camera couldn't start at all.
    var onFailure: ((String) -> Void)?

    private let sessionQueue = DispatchQueue(label: "gus.watch.capture")
    private var session: AVCaptureSession?
    private var outputs: [WatchCameraSlot: AVCaptureVideoDataOutput] = [:]
    private var mode: WatchCameraMode = .back
    private var built = false
    private var running = false

    // The latest frame per camera, converted on the session
    // queue and read from the main actor — the lock is the
    // whole synchronization story.
    private let frameLock = NSLock()
    private var latestFrames: [WatchCameraSlot: CGImage] = [:]
    private var lastConvertedAt: [WatchCameraSlot: Date] = [:]
    private let ciContext = CIContext()

    // MARK: - Lifecycle (called from the call session)

    func start(mode: WatchCameraMode) {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.mode = mode
            self.buildAndRun()
        }
    }

    func setMode(_ newMode: WatchCameraMode) {
        sessionQueue.async { [weak self] in
            guard let self, newMode != self.mode else { return }
            self.mode = newMode
            if self.built { self.buildAndRun() }
        }
    }

    /// Stop everything and drop every held frame. The
    /// preview layers go too — a stopped watch shows no
    /// last frame frozen on screen.
    func stop() {
        sessionQueue.async { [weak self] in self?.teardown() }
        DispatchQueue.main.async { [previewView] in
            previewView.setPreviewLayers([])
        }
    }

    /// Backgrounding (v0.37.0): the session stops, so the
    /// camera is genuinely off while the app is away — the
    /// call's background-audio mode keeps the CALL alive,
    /// never the camera. The build stays, so resume is a
    /// restart, not a rebuild.
    func suspend() {
        sessionQueue.async { [weak self] in
            guard let self, self.running else { return }
            self.session?.stopRunning()
            self.running = false
        }
    }

    func resume() {
        sessionQueue.async { [weak self] in
            guard let self, self.built, !self.running else { return }
            self.session?.startRunning()
            self.running = true
        }
    }

    /// The newest frame for a camera, if one has been
    /// converted yet. Already downscaled (see the delegate).
    func latestFrame(for slot: WatchCameraSlot) -> CGImage? {
        frameLock.lock()
        defer { frameLock.unlock() }
        return latestFrames[slot]
    }

    // MARK: - Torch (back camera only)

    var backTorchAvailable: Bool {
        guard let device = Self.device(for: .back) else { return false }
        return device.hasTorch && device.isTorchAvailable
    }

    @discardableResult
    func setTorch(_ on: Bool) -> Bool {
        guard let device = Self.device(for: .back),
              device.hasTorch, device.isTorchAvailable
        else { return false }
        do {
            try device.lockForConfiguration()
            device.torchMode = on ? .on : .off
            device.unlockForConfiguration()
            return true
        } catch {
            return false
        }
    }

    // MARK: - Building (session queue only)

    private static func device(for slot: WatchCameraSlot) -> AVCaptureDevice? {
        AVCaptureDevice.default(
            .builtInWideAngleCamera, for: .video,
            position: slot == .front ? .front : .back)
    }

    private func teardown() {
        if let session, session.isRunning { session.stopRunning() }
        session = nil
        outputs = [:]
        built = false
        running = false
        frameLock.lock()
        latestFrames = [:]
        lastConvertedAt = [:]
        frameLock.unlock()
    }

    private func buildAndRun() {
        teardown()
        let wantBoth = mode == .both && Self.isMultiCamSupported
        let newSession: AVCaptureSession =
            wantBoth ? AVCaptureMultiCamSession() : AVCaptureSession()
        if !wantBoth {
            // Frames are downscaled to 768 px before they
            // travel; capturing beyond 720p buys nothing but
            // heat. (Multi-cam sessions take no preset — the
            // system budgets the cameras itself.)
            newSession.sessionPreset = .hd1280x720
        }
        newSession.beginConfiguration()
        var layers: [WatchCameraSlot: AVCaptureVideoPreviewLayer] = [:]
        var complete = true
        for slot in mode.slots {
            guard let device = Self.device(for: slot),
                  let input = try? AVCaptureDeviceInput(device: device),
                  newSession.canAddInput(input)
            else { complete = false; break }
            newSession.addInput(input)

            let output = AVCaptureVideoDataOutput()
            output.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ]
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: sessionQueue)
            guard newSession.canAddOutput(output) else { complete = false; break }
            newSession.addOutput(output)
            outputs[slot] = output
            // Portrait calls: the frames the core receives
            // are upright stills, not sensor-landscape.
            if let connection = output.connection(with: .video),
               connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90
            }

            let layer: AVCaptureVideoPreviewLayer
            if wantBoth {
                // A multi-cam preview layer needs its own
                // connection to its camera's video port.
                layer = AVCaptureVideoPreviewLayer(sessionWithNoConnection: newSession)
                if let port = input.ports(
                    for: .video,
                    sourceDeviceType: device.deviceType,
                    sourceDevicePosition: device.position
                ).first {
                    let connection = AVCaptureConnection(
                        inputPort: port, videoPreviewLayer: layer)
                    if newSession.canAddConnection(connection) {
                        newSession.addConnection(connection)
                    }
                    if connection.isVideoRotationAngleSupported(90) {
                        connection.videoRotationAngle = 90
                    }
                }
            } else {
                layer = AVCaptureVideoPreviewLayer(session: newSession)
                if let connection = layer.connection,
                   connection.isVideoRotationAngleSupported(90) {
                    connection.videoRotationAngle = 90
                }
            }
            layer.videoGravity = .resizeAspectFill
            layers[slot] = layer
        }
        newSession.commitConfiguration()

        guard complete, !outputs.isEmpty else {
            // A both-build that couldn't stand up falls back
            // to the back camera alone, out loud. A single
            // build that fails is just a failure, also out
            // loud (through onFailure, to the call screen).
            outputs = [:]
            if mode == .both {
                mode = .back
                let fallback = mode
                DispatchQueue.main.async { [weak self] in
                    self?.onEffectiveModeChange?(fallback)
                }
                buildAndRun()
            } else {
                DispatchQueue.main.async { [weak self] in
                    self?.onFailure?("The camera couldn't start.")
                }
            }
            return
        }

        session = newSession
        built = true
        let ordered = mode.slots.compactMap { layers[$0] }
        DispatchQueue.main.async { [previewView] in
            previewView.setPreviewLayers(ordered)
        }
        newSession.startRunning()
        running = true
    }
}

// MARK: - Frame conversion

extension WatchCaptureController: AVCaptureVideoDataOutputSampleBufferDelegate {
    /// Keep the latest frame per camera — converted at most
    /// twice a second, downscaled as it converts, so what's
    /// stored (and later encoded) is already small. The
    /// delegate runs on the session queue; nothing here
    /// encodes, uploads, or touches the UI.
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let slot = outputs.first(where: { $0.value === output })?.key
        else { return }
        let now = Date()
        if let last = lastConvertedAt[slot],
           now.timeIntervalSince(last) < 0.4 { return }
        lastConvertedAt[slot] = now
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return }
        var scaled = image
        let longest = max(extent.width, extent.height)
        if longest > WatchFrameEncoder.maxLongEdge {
            let factor = WatchFrameEncoder.maxLongEdge / longest
            scaled = image.transformed(
                by: CGAffineTransform(scaleX: factor, y: factor))
        }
        guard let cg = ciContext.createCGImage(scaled, from: scaled.extent)
        else { return }
        frameLock.lock()
        latestFrames[slot] = cg
        frameLock.unlock()
    }
}

/// The preview surface: a black container that lays its
/// preview layers out — one filling it, two side by side.
/// The controller owns the layers; this view only frames
/// them.
final class WatchPreviewContainerView: UIView {
    private var previewLayers: [AVCaptureVideoPreviewLayer] = []

    func setPreviewLayers(_ layers: [AVCaptureVideoPreviewLayer]) {
        previewLayers.forEach { $0.removeFromSuperlayer() }
        previewLayers = layers
        backgroundColor = .black
        layers.forEach { layer.addSublayer($0) }
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard !previewLayers.isEmpty else { return }
        if previewLayers.count == 1 {
            previewLayers[0].frame = bounds
        } else {
            let half = bounds.width / 2
            previewLayers[0].frame = CGRect(
                x: 0, y: 0, width: half - 1, height: bounds.height)
            previewLayers[1].frame = CGRect(
                x: half + 1, y: 0,
                width: bounds.width - half - 1, height: bounds.height)
        }
    }
}

/// One frame's wire shape (v0.37.0): the small JPEG the core
/// holds as the session's eyes, and its perceptual hash —
/// the 64-bit average hash (8×8 luminance cells over the
/// frame's own average) the core's change detection compares.
/// SerenAI's lesson, kept: the frame is small on purpose
/// (long edge ≤768 px — enforced at conversion — JPEG q0.4),
/// because a watching persona needs the view current, not
/// archival.
enum WatchFrameEncoder {
    static let maxLongEdge: CGFloat = 768
    static let jpegQuality: CGFloat = 0.4

    static func encode(_ image: CGImage) -> (data: Data, hash: String)? {
        guard let data = UIImage(cgImage: image)
            .jpegData(compressionQuality: jpegQuality)
        else { return nil }
        return (data, averageHash(of: image))
    }

    /// The aHash: draw the frame into an 8×8 grayscale
    /// context, average the 64 cells, and set each cell's
    /// bit when it beats the average. Two hashes of the
    /// same view differ in a few bits; a new subject flips
    /// many. The hex string is the whole contract — the
    /// core only ever compares hashes to hashes.
    static func averageHash(of image: CGImage) -> String {
        let side = 8
        var pixels = [UInt8](repeating: 0, count: side * side)
        let drawn = pixels.withUnsafeMutableBytes { raw -> Bool in
            guard let base = raw.baseAddress,
                  let context = CGContext(
                    data: base, width: side, height: side,
                    bitsPerComponent: 8, bytesPerRow: side,
                    space: CGColorSpaceCreateDeviceGray(),
                    bitmapInfo: CGImageAlphaInfo.none.rawValue)
            else { return false }
            context.interpolationQuality = .low
            context.draw(
                image, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        guard drawn else { return "" }
        let average = Double(pixels.reduce(0) { $0 + Int($1) })
            / Double(side * side)
        var bits: UInt64 = 0
        for i in 0..<(side * side) where Double(pixels[i]) > average {
            bits |= UInt64(1) << UInt64(i)
        }
        return String(format: "%016llx", bits)
    }
}
