import AVFoundation
import SwiftUI
import UIKit

/// Pair with a QR code (v0.12.0 — pivot Phase 1 / iPhone Step 1).
///
/// The easy way to connect, replacing the token-by-hand ritual:
/// the Mac shows a QR code (Settings → Devices → Pair a device)
/// carrying a single-use, ten-minute pairing grant and the
/// panel's address candidates. This view scans it, trades the
/// grant for THIS phone's own credential, stores the credential
/// in the Keychain (the same slot the manual token uses), and
/// verifies the connection before it calls itself done.
///
/// The honest shape of it: pairing is the easy way; the token
/// in Settings is the manual way. A paired phone's credential
/// reaches status, jobs, approvals, the kill switch, and the
/// Governor mode — and the Mac can revoke it at any time from
/// its Devices list, which the operator token never allowed.
struct PairingView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .scanning
    @State private var scannerSeed = 0

    private enum Phase {
        case scanning
        case exchanging
        case connected(String)
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .scanning:
                    scanningBody
                case .exchanging:
                    VStack(spacing: 14) {
                        ProgressView()
                        Text("Pairing with your Mac…")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .connected(let detail):
                    resultBody(symbol: "checkmark.circle.fill", color: .green, title: "Paired", detail: detail, primary: "Done") {
                        dismiss()
                    }
                case .failed(let detail):
                    resultBody(symbol: "exclamationmark.triangle.fill", color: .orange, title: "Pairing didn't finish", detail: detail, primary: "Scan again") {
                        scannerSeed += 1
                        phase = .scanning
                    }
                }
            }
            .navigationTitle("Pair with a QR code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private var scanningBody: some View {
        VStack(spacing: 14) {
            QRScannerView(
                onScan: { raw in handleScan(raw) },
                onUnavailable: { why in phase = .failed(why) }
            )
            .id(scannerSeed)
            .frame(height: 340)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .padding(.horizontal)
            Text("Point at the QR code in GUS Settings → Devices on the Mac. The code pairs this phone only, works once, and expires in ten minutes — the operator token is never in it.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Spacer()
        }
        .padding(.top)
    }

    private func resultBody(symbol: String, color: Color, title: String, detail: String, primary: String, action: @escaping () -> Void) -> some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 44))
                .foregroundStyle(color)
            Text(title)
                .font(.headline)
            Text(detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
            Button(primary, action: action)
                .buttonStyle(.borderedProminent)
            if case .failed = phase {
                Button("Use the manual token instead") { dismiss() }
                    .font(.callout)
            }
            Spacer()
        }
        .padding(.top, 40)
        .frame(maxWidth: .infinity)
    }

    // MARK: The exchange

    private func handleScan(_ raw: String) {
        guard case .scanning = phase else { return }
        guard let payload = PairingPayload.parse(raw) else {
            phase = .failed("That code isn't a GUS pairing code. Pairing codes come from GUS Settings → Devices on the Mac — nothing was changed.")
            return
        }
        phase = .exchanging
        Task { await exchange(payload) }
    }

    /// Try the payload's addresses in order. A refusal IN the
    /// exchange shape (expired / already-used grant) is the real
    /// panel answering — stop there and say what it said; a
    /// transport or decode failure just means that address
    /// wasn't the panel, so try the next one.
    private func exchange(_ payload: PairingPayload) async {
        var lastFailure = "The Mac didn't answer at any address in the code."
        for address in payload.addresses {
            do {
                let result = try await GUSClient.exchangePairing(
                    baseURLString: address,
                    grant: payload.grant,
                    name: UIDevice.current.name,
                    platform: "ios"
                )
                guard result.ok, let credential = result.credential else {
                    phase = .failed(result.detail)
                    return
                }
                GUSSettings.baseURLString = address
                GUSSettings.token = credential
                // Verify before celebrating: the credential the
                // Keychain now holds must actually open the panel.
                let status = try await GUSClient.shared.status()
                phase = .connected("Connected — GUS v\(status.version), \(status.killed ? "stopped" : "live"), mode \(status.governorMode). This phone now holds its own credential, stored in the Keychain; the Mac can revoke it any time from Settings → Devices.")
                return
            } catch {
                lastFailure = "Couldn't pair via \(address): \(error.localizedDescription)"
            }
        }
        phase = .failed("\(lastFailure) Check that the Mac is awake, GUS is running, and this phone can reach it (the same network, or your tailnet) — then scan a fresh code.")
    }
}

// MARK: - Camera scanner

/// The camera half: an AVCaptureSession watching for one QR
/// code. Permission states are reported, never papered over —
/// a denied camera lands on the view's failure state with the
/// way out (the system Settings pane, or the manual token).
private struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onUnavailable: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let controller = QRScannerViewController()
        controller.onScan = onScan
        controller.onUnavailable = onUnavailable
        return controller
    }

    func updateUIViewController(_ controller: QRScannerViewController, context: Context) {}
}

private final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    var onUnavailable: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var scanned = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            setup()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.setup()
                    } else {
                        self?.onUnavailable?("Camera access is off for GUS, so the code can't be scanned. You can turn it on in the Settings app under Privacy & Security → Camera — or pair the manual way, with the token, back in Settings.")
                    }
                }
            }
        default:
            onUnavailable?("Camera access is off for GUS, so the code can't be scanned. You can turn it on in the Settings app under Privacy & Security → Camera — or pair the manual way, with the token, back in Settings.")
        }
    }

    private func setup() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            onUnavailable?("This device has no camera the pairing scan can use. Pair the manual way instead, with the token, back in Settings.")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            onUnavailable?("The camera can't scan codes here. Pair the manual way instead, with the token, back in Settings.")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview
        let runningSession = session
        DispatchQueue.global(qos: .userInitiated).async {
            runningSession.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            let runningSession = session
            DispatchQueue.global(qos: .userInitiated).async {
                runningSession.stopRunning()
            }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !scanned,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue else { return }
        scanned = true
        let runningSession = session
        DispatchQueue.global(qos: .userInitiated).async {
            runningSession.stopRunning()
        }
        onScan?(value)
    }
}
