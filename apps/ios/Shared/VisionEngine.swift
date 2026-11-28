import Foundation
import UIKit

// On-device vision, baby step 1 (v0.48.0).
//
// The isolation contract, in one paragraph: the text path
// (LocalBrain over LLM.swift) never imports this file's
// engine, and this file never imports the text path. Chat
// reaches vision ONLY through the VisionDescribing protocol
// below, and the engine reaches llama.cpp's mtmd C API ONLY
// through the two C functions in GUSVisionShim.h. Delete
// this file, the shim, and the chat routing that consults
// VisionRouting, and on-device vision is gone with the text
// path untouched.
//
// The engine itself is deliberately unambitious, per the
// build's governing rule — stability over speed and
// quality:
//   - one photo, one short prompt, one short answer;
//   - the model + projector LOAD for the call and UNLOAD
//     when it returns (no resident second model — the
//     phone's memory goes back to the text brain);
//   - all work happens on ONE serial background queue, so
//     two vision calls can never overlap, and chat chains
//     vision turns onto the same localChain as text turns,
//     so a vision call and a text generation never run at
//     the same time either;
//   - a watchdog abandons a turn that runs too long with
//     an honest line instead of hanging the conversation
//     (the abandoned C call is internally bounded — token
//     and context caps — and drains on the serial queue,
//     freeing everything as it returns; the next vision
//     turn simply waits behind it);
//   - every failure is a typed VisionError carrying plain
//     words. Nothing on this path force-unwraps or traps.

/// The narrow door chat talks through. Implementations may
/// come and go (this build: the on-device mtmd engine; the
/// track's later steps add home-server and Core backends
/// behind this same shape) — chat's routing decision never
/// learns which one answered.
protocol VisionDescribing {
    /// Look at ONE image and answer the prompt. The image
    /// is processed entirely on this device.
    func describe(image: Data, prompt: String,
                  modelURL: URL, projectorURL: URL) async -> Result<String, VisionError>
}

/// A vision failure, in plain words. The chat shows
/// honestLine as the turn's answer — a failure is a
/// sentence in the conversation, never a silent drop.
enum VisionError: Error {
    /// The watchdog fired: looking took too long, so the
    /// turn was abandoned rather than left hanging.
    case timedOut
    /// The engine (or the photo itself) said no, in its
    /// own plain words.
    case engine(String)

    var honestLine: String {
        switch self {
        case .timedOut:
            return "I tried to look at that photo, but it was taking too long, so I stopped rather than keep you waiting. The photo never left this iPhone."
        case .engine(let reason):
            return "I couldn't look at that photo — \(reason). The photo never left this iPhone."
        }
    }
}

/// The Settings kill switch (v0.48.0): "On-device vision",
/// default ON. Off means photo turns take the honest
/// can't-see path even with the vision brain active — the
/// feature can be retired from Settings without deleting
/// anything.
enum VisionSettings {
    static let defaultsKey = "gus.vision.onDevice"

    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: defaultsKey) }
    }
}

/// The routing decision, kept pure so the pin tests can
/// hold it to its factors: a chat photo turn goes to the
/// vision engine EXACTLY when the kill switch is on, the
/// active brain is the curated vision brain, and its pair
/// is fully on disk (ActiveBrain.resolved() is already
/// presence-aware — the explicit isPresent states the
/// pair requirement at the decision point, where a reader
/// looks for it). Every other case keeps the honest
/// can't-see behavior, byte-identical.
enum VisionRouting {
    static func useVisionEngine() -> Bool {
        guard VisionSettings.enabled else { return false }
        guard let active = ActiveBrain.resolved() else { return false }
        return active.id == GUSModelManifest.brainVision.id
            && ModelStore.isPresent(active)
    }
}

/// The on-device engine: LlamaVisionEngine is the only
/// VisionDescribing in this build, and GUSVisionDescribe
/// (GUSVisionShim) is the only door it knocks on.
final class LlamaVisionEngine: VisionDescribing {
    /// The one serial queue every vision call runs on.
    private static let queue = DispatchQueue(label: "gus.vision.serial")

    /// The watchdog. Generous on purpose — a CPU-bound 3B
    /// look at a photo is slow, and a finished answer beats
    /// a timeout line — but bounded: a turn never hangs
    /// the conversation forever.
    static let timeoutSeconds: UInt64 = 240

    /// The engine's input cap: photos are downscaled to
    /// this long edge before the C call (the chat's
    /// transport size is larger; vision wants small —
    /// fewer image tokens, less memory, same gist).
    static let maxLongEdge: CGFloat = 768

    func describe(image: Data, prompt: String,
                  modelURL: URL, projectorURL: URL) async -> Result<String, VisionError> {
        await withCheckedContinuation { continuation in
            let resumeOnce = ResumeOnce(continuation)
            Self.queue.async {
                resumeOnce.resume(Self.perform(
                    image: image, prompt: prompt,
                    modelURL: modelURL, projectorURL: projectorURL))
            }
            Task.detached {
                try? await Task.sleep(nanoseconds: Self.timeoutSeconds * 1_000_000_000)
                resumeOnce.resume(.failure(.timedOut))
            }
        }
    }

    /// The blocking work, on the serial queue: downscale,
    /// then the one C call, then translate its outcome.
    private static func perform(image: Data, prompt: String,
                                modelURL: URL, projectorURL: URL) -> Result<String, VisionError> {
        guard let jpeg = downscaledJPEG(image) else {
            return .failure(.engine("that photo couldn't be read"))
        }
        var errorBuffer = [CChar](repeating: 0, count: 512)
        let resultPointer: UnsafeMutablePointer<CChar>? = jpeg.withUnsafeBytes { raw in
            guard let baseAddress = raw.baseAddress else { return nil }
            return GUSVisionDescribe(
                modelURL.path,
                projectorURL.path,
                baseAddress.assumingMemoryBound(to: UInt8.self),
                jpeg.count,
                prompt,
                &errorBuffer,
                errorBuffer.count)
        }
        guard let resultPointer else {
            let reason = errorBuffer.prefix(while: { $0 != 0 })
            let message = String(decoding: reason.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            return .failure(.engine(message.isEmpty ? "the vision engine couldn't start" : message))
        }
        let text = String(cString: resultPointer)
        GUSVisionFree(resultPointer)
        return .success(text)
    }

    /// Downscale to the engine's cap and re-encode as JPEG.
    /// A photo already under the cap still re-encodes, so
    /// the C side always receives the one format the
    /// pipeline is exercised against. Nil when the bytes
    /// aren't an image this phone can decode.
    private static func downscaledJPEG(_ data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let longEdge = max(image.size.width, image.size.height)
        guard longEdge > maxLongEdge else {
            return image.jpegData(compressionQuality: 0.8)
        }
        let scale = maxLongEdge / longEdge
        let size = CGSize(width: image.size.width * scale,
                          height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let resized = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return resized.jpegData(compressionQuality: 0.8)
    }

    /// First resume wins; the loser (a late engine result
    /// after the watchdog, or the watchdog after a result)
    /// is dropped on the floor. This is what makes the
    /// timeout honest: the continuation — the chat's turn —
    /// completes exactly once, on whichever came first.
    private final class ResumeOnce: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Result<String, VisionError>, Never>?

        init(_ continuation: CheckedContinuation<Result<String, VisionError>, Never>) {
            self.continuation = continuation
        }

        func resume(_ result: Result<String, VisionError>) {
            lock.lock()
            let pending = continuation
            continuation = nil
            lock.unlock()
            pending?.resume(returning: result)
        }
    }
}
