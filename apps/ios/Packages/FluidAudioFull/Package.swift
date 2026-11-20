// swift-tools-version: 6.2
import PackageDescription

// FluidAudioFull — trait enabler for FluidAudio.
//
// FluidAudio 0.18.4's swift-6.2 variant manifest gates its TTS subsystem
// (Kokoro) behind the `TTS` package trait; `NemoTextProcessing` and
// `Diarizer` complete its declared default set. Xcode 26's xcodebuild does
// NOT apply the `traits` list stored on the app project's
// XCRemoteSwiftPackageReference (verified 2026-11-20 across two archives,
// one after a full DerivedData wipe: FluidAudio compiled with no -DTTS,
// so KokoroAneManager compiled out and the app target failed with
// "cannot find type 'KokoroAneManager' in scope"). Declaring the traits
// here, on a manifest dependency, applies them graph-wide — the documented
// workaround — and the single target below re-exports FluidAudio so the
// app can link this one product for the full API.
let package = Package(
    name: "FluidAudioFull",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "FluidAudioFull", targets: ["FluidAudioFull"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio",
            exact: "0.18.4",
            traits: ["NemoTextProcessing", "TTS", "Diarizer"]
        ),
    ],
    targets: [
        .target(
            name: "FluidAudioFull",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ]
        ),
    ]
)
