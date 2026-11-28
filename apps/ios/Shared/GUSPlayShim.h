// GUSPlayShim — the one Objective-C function the app needs
// (v0.27.2). This header is ALSO the GUS target's bridging
// header (SWIFT_OBJC_BRIDGING_HEADER in the project), which
// is how Swift sees the function; the .m rides the Shared
// file-system-synchronized group into the same target.
//
// Why this exists: -[AVAudioPlayerNode play] can raise an
// NSException inside AVAudioPlayerNodeImpl::StartImpl when
// the node is not in a playable state at that instant. An
// NSException is not a Swift error — no do/catch in Swift
// can see it, and an uncaught one aborts the process. That
// is the field crash, twice: GUS-2026-11-27-025146.ips on
// app 0.25.0 and GUS-2026-11-27-100032.ips on app 0.27.1 —
// the second time AFTER v0.27.0's Swift-side playable-state
// proof (attached → connected → engine running, read back
// from the engine itself) had passed immediately before the
// call. The engine's reported state can pass every check
// while StartImpl still raises, so no Swift-side guard can
// ever make the bare call safe. This shim is the
// containment: play is called in exactly one place, inside
// @try/@catch, and a raise comes back as data — the
// exception's own name and reason — instead of a crash.

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

// v0.48.0: the vision engine's C door rides this same
// bridging header (GUSVisionShim.h) — one bridging header
// per target, and the vision shim is the second contained
// C surface behind it. Swift reaches the engine only
// through VisionEngine.swift's VisionDescribing protocol.
#import "GUSVisionShim.h"

NS_ASSUME_NONNULL_BEGIN

/// Start `player` playing, containing any NSException the
/// call raises (see the file note above).
///
/// Returns nil when play completed without raising. On a
/// caught exception, returns "<exception name>: <exception
/// reason>" — Apple's own words, verbatim, for the caller's
/// failure log.
NSString *_Nullable GUSAudioPlayerPlayCatching(AVAudioPlayerNode *player);

NS_ASSUME_NONNULL_END
