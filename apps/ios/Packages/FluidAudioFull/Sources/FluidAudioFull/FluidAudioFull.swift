// FluidAudioFull — see Package.swift for why this package exists.
// Re-exporting FluidAudio here means linking the FluidAudioFull product
// carries the trait-enabled build of FluidAudio (TTS/Kokoro included)
// into the app.
@_exported import FluidAudio
