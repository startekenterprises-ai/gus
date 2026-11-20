// swift-tools-version: 6.2
import PackageDescription

// ShieldKit — Agent Shield on the phone (v0.15.7).
//
// A faithful Swift port of the production deterministic pattern
// engine (agent-shield-connector/worker/src/detect.ts, analyzer
// "heuristic_v5"): the same leak patterns, the same SSRF taxonomy,
// the same injection signals, weights, dampening, combination
// bonuses, and medium-sensitivity thresholds. The frontier-model
// semantic stage (semantic.ts) is deliberately NOT ported — it
// stays server-side. No dependencies: Foundation + CryptoKit only.
let package = Package(
    name: "ShieldKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "ShieldKit", targets: ["ShieldKit"]),
    ],
    targets: [
        .target(name: "ShieldKit"),
    ]
)
