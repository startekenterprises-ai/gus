// GUSPlayShim — implementation. See the header for why this
// file exists: it is the containment for the one audio call
// whose failure mode (an uncaught NSException out of
// AVAudioPlayerNode's StartImpl) Swift cannot catch by
// construction. Kept to exactly one function on purpose.

#import "GUSPlayShim.h"

NSString *_Nullable GUSAudioPlayerPlayCatching(AVAudioPlayerNode *player) {
    @try {
        [player play];
        return nil;
    } @catch (NSException *exception) {
        NSString *name = exception.name ?: @"NSException";
        NSString *reason = exception.reason ?: @"(no reason given)";
        return [NSString stringWithFormat:@"%@: %@", name, reason];
    }
}
