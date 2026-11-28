// GUSVisionShim — the ONE C door into the vision engine
// (v0.48.0). This header is imported from GUSPlayShim.h,
// which is the GUS target's bridging header, so Swift sees
// exactly these two functions and nothing else of the
// engine.
//
// Why this exists, and why it is shaped like this:
//
// On-device TEXT runs on LLM.swift 3.0.3, whose Swift API
// is text-only — but the llama.cpp xcframework LLM.swift
// itself pins (official ggml-org llama.cpp b10068) already
// carries the full mtmd multimodal C API inside
// llama.framework: headers, symbols, everything. So the
// vision engine needs no second framework, no vendored
// binary, and no new package — it needs a narrow, contained
// place to call that C API. This shim is that place, kept
// to exactly one operation on purpose, the same containment
// pattern as GUSPlayShim's single audio call:
//
//   - The engine is ISOLATED. LocalBrain and the whole text
//     path never see it; Swift reaches it only through the
//     VisionDescribing protocol (VisionEngine.swift), which
//     reaches only these two functions. Deleting this file,
//     its .mm, and VisionEngine.swift removes on-device
//     vision without touching the text path.
//   - Every failure comes back as DATA: NULL plus a
//     plain-words reason in the caller's error buffer.
//     llama.cpp/mtmd report failures as NULL returns and
//     non-zero codes (all checked), and any C++ exception
//     is caught inside the .mm — nothing on this path can
//     trap into the app.
//   - One call does the whole job and frees EVERYTHING
//     before returning: load the model + projector, look at
//     one image, generate one short answer, unload. No
//     resident second model, ever.
//
// Threading contract: NOT thread-safe by design — the one
// caller (LlamaVisionEngine) serializes every call on its
// own serial queue.

#ifndef GUSVisionShim_h
#define GUSVisionShim_h

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Look at one JPEG image with a vision GGUF + its mmproj
/// and answer a short prompt, synchronously, on the
/// caller's (background) thread.
///
/// modelPath / mmprojPath: filesystem paths to the pair's
/// two files. jpegData / jpegLength: the image bytes (any
/// size — the caller downscales; stb_image inside mtmd
/// reads JPEG/PNG). prompt: the person's words, or a short
/// default observation ask.
///
/// Returns a malloc'd NUL-terminated UTF-8 answer on
/// success — free it with GUSVisionFree. Returns NULL on
/// any failure, with a plain-words reason written into
/// errorBuffer (errorBufferLength bytes, always
/// NUL-terminated when errorBufferLength > 0).
char *GUSVisionDescribe(const char *modelPath,
                        const char *mmprojPath,
                        const unsigned char *jpegData,
                        size_t jpegLength,
                        const char *prompt,
                        char *errorBuffer,
                        size_t errorBufferLength);

/// Free a string returned by GUSVisionDescribe (NULL-safe).
void GUSVisionFree(char *text);

#ifdef __cplusplus
}
#endif

#endif /* GUSVisionShim_h */
