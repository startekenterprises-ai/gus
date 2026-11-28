// GUSVisionShim — implementation. See the header for why
// this file exists and the containment rules it lives by.
// Everything below is the mtmd reference flow (llama.cpp's
// own mtmd-cli at the pinned b10068) reduced to one call:
// template the prompt with the media marker first, tokenize
// text + image into chunks, evaluate the chunks, then a
// greedy decode loop. Greedy on purpose: baby step 1 buys
// determinism and stability, not flair.
//
// Pinned surface: every symbol used here is exported by the
// llama.framework inside the xcframework LLM.swift 3.0.3
// already pins (official ggml-org llama.cpp b10068) — its
// Headers carry mtmd.h / mtmd-helper.h and its binary
// exports the mtmd_* entry points below (verified against
// the artifact itself, 2026-11-28). If a future LLM.swift
// bump changes that pin, this file is the only place that
// has to move.

#import "GUSVisionShim.h"

#include <llama/llama.h>
#include <llama/mtmd.h>
#include <llama/mtmd-helper.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {

// Hard caps — the stability budget of baby step 1. A 768px
// photo costs well under 1,000 image tokens on the curated
// brain; 4,096 of context leaves the whole answer's room
// several times over, and 256 answer tokens is a short
// spoken-style reply, not an essay.
constexpr int32_t kContextSize = 4096;
constexpr int32_t kBatchSize = 512;
constexpr int kMaxAnswerTokens = 256;
constexpr int kThreads = 4;

void setError(char *buffer, size_t length, const char *message) {
    if (buffer == nullptr || length == 0) { return; }
    std::snprintf(buffer, length, "%s", message);
}

struct ModelDeleter   { void operator()(llama_model *p)     const { if (p) { llama_model_free(p); } } };
struct ContextDeleter { void operator()(llama_context *p)   const { if (p) { llama_free(p); } } };
struct MtmdDeleter    { void operator()(mtmd_context *p)    const { if (p) { mtmd_free(p); } } };
struct BitmapDeleter  { void operator()(mtmd_bitmap *p)     const { if (p) { mtmd_bitmap_free(p); } } };
struct ChunksDeleter  { void operator()(mtmd_input_chunks *p) const { if (p) { mtmd_input_chunks_free(p); } } };
struct SamplerDeleter { void operator()(llama_sampler *p)   const { if (p) { llama_sampler_free(p); } } };

void ensureBackend() {
    static std::once_flag once;
    std::call_once(once, [] { llama_backend_init(); });
}

char *describeImpl(const char *modelPath,
                   const char *mmprojPath,
                   const unsigned char *jpegData,
                   size_t jpegLength,
                   const char *prompt,
                   char *errorBuffer,
                   size_t errorBufferLength) {
    try {
        ensureBackend();

        // Load the language model — CPU only for the LLM
        // half (n_gpu_layers = 0, stated rather than left to
        // a default): baby step 1 buys stability, and a CPU
        // context can never fight the text engine's runtime
        // over the GPU. The vision encoder keeps mtmd's own
        // default device choice, the standard iOS path.
        llama_model_params modelParams = llama_model_default_params();
        modelParams.n_gpu_layers = 0;
        std::unique_ptr<llama_model, ModelDeleter> model(
            llama_model_load_from_file(modelPath, modelParams));
        if (!model) {
            setError(errorBuffer, errorBufferLength, "the vision brain wouldn't load");
            return nullptr;
        }

        llama_context_params contextParams = llama_context_default_params();
        contextParams.n_ctx = kContextSize;
        contextParams.n_batch = kBatchSize;
        contextParams.n_threads = kThreads;
        contextParams.n_threads_batch = kThreads;
        std::unique_ptr<llama_context, ContextDeleter> context(
            llama_init_from_model(model.get(), contextParams));
        if (!context) {
            setError(errorBuffer, errorBufferLength, "the vision brain wouldn't start");
            return nullptr;
        }

        // Load the projector against the model. No warmup
        // pass: the engine loads per use and unloads after,
        // so a warmup encode would be pure overhead on
        // every photo.
        mtmd_context_params visionParams = mtmd_context_params_default();
        visionParams.n_threads = kThreads;
        visionParams.print_timings = false;
        visionParams.warmup = false;
        std::unique_ptr<mtmd_context, MtmdDeleter> vision(
            mtmd_init_from_file(mmprojPath, model.get(), visionParams));
        if (!vision) {
            setError(errorBuffer, errorBufferLength, "the vision part of the brain wouldn't load");
            return nullptr;
        }
        if (!mtmd_support_vision(vision.get())) {
            setError(errorBuffer, errorBufferLength, "this brain's projector can't actually see");
            return nullptr;
        }

        // Format the turn with the model's own chat
        // template, the media marker first in the person's
        // message — the placement mtmd's own CLI uses
        // ("most models require the marker before each
        // image").
        const char *tmpl = llama_model_chat_template(model.get(), nullptr);
        if (tmpl == nullptr) {
            setError(errorBuffer, errorBufferLength, "the vision brain has no chat template GUS can use yet");
            return nullptr;
        }
        const std::string userContent =
            std::string(mtmd_default_marker()) + "\n" + (prompt != nullptr ? prompt : "");
        llama_chat_message message{"user", userContent.c_str()};
        const int32_t needed = llama_chat_apply_template(tmpl, &message, 1, true, nullptr, 0);
        if (needed < 0 || needed > 1024 * 1024) {
            setError(errorBuffer, errorBufferLength, "the vision brain's chat template isn't supported yet");
            return nullptr;
        }
        std::vector<char> formatted((size_t)needed + 1, 0);
        const int32_t written = llama_chat_apply_template(
            tmpl, &message, 1, true, formatted.data(), (int32_t)formatted.size());
        if (written < 0) {
            setError(errorBuffer, errorBufferLength, "the vision brain's chat template isn't supported yet");
            return nullptr;
        }
        const std::string promptText(formatted.data(), (size_t)written);

        // Decode the image into a bitmap (stb_image inside
        // mtmd reads the caller's downscaled JPEG).
        mtmd_helper_bitmap_wrapper wrapper =
            mtmd_helper_bitmap_init_from_buf(vision.get(), jpegData, jpegLength, false);
        std::unique_ptr<mtmd_bitmap, BitmapDeleter> bitmap(wrapper.bitmap);
        if (!bitmap) {
            setError(errorBuffer, errorBufferLength, "that photo couldn't be read");
            return nullptr;
        }

        // Tokenize text + image into chunks. parse_special
        // so the template's own special tokens land as
        // themselves; add_special for the model's BOS, as
        // the first (and only) turn of this fresh context.
        std::unique_ptr<mtmd_input_chunks, ChunksDeleter> chunks(mtmd_input_chunks_init());
        if (!chunks) {
            setError(errorBuffer, errorBufferLength, "the photo and question couldn't be prepared");
            return nullptr;
        }
        mtmd_input_text inputText;
        inputText.text = promptText.data();
        inputText.text_len = promptText.size();
        inputText.add_special = true;
        inputText.parse_special = true;
        const mtmd_bitmap *bitmaps[1] = {bitmap.get()};
        if (mtmd_tokenize(vision.get(), chunks.get(), &inputText, bitmaps, 1) != 0) {
            setError(errorBuffer, errorBufferLength, "the photo and question couldn't be prepared");
            return nullptr;
        }
        const size_t nPromptTokens = mtmd_helper_get_n_tokens(chunks.get());
        if (nPromptTokens == 0 ||
            nPromptTokens > (size_t)(kContextSize - kMaxAnswerTokens)) {
            setError(errorBuffer, errorBufferLength, "that photo is too detailed to take in at once");
            return nullptr;
        }

        // Evaluate the whole prompt — text and image chunks
        // in order — with logits on the final position.
        llama_pos nPast = 0;
        if (mtmd_helper_eval_chunks(vision.get(), context.get(), chunks.get(),
                                    0, 0, kBatchSize, true, &nPast) != 0) {
            setError(errorBuffer, errorBufferLength, "looking at the photo failed partway");
            return nullptr;
        }

        // The answer: greedy sampling, one token at a time,
        // positions continuing from where the helper left
        // nPast (its count is already M-RoPE-aware for the
        // prompt; generated text tokens advance it by one).
        const llama_vocab *vocab = llama_model_get_vocab(model.get());
        std::unique_ptr<llama_sampler, SamplerDeleter> sampler(llama_sampler_init_greedy());
        if (!sampler) {
            setError(errorBuffer, errorBufferLength, "answering failed partway");
            return nullptr;
        }
        std::string answer;
        for (int generated = 0; generated < kMaxAnswerTokens; generated++) {
            const llama_token token = llama_sampler_sample(sampler.get(), context.get(), -1);
            if (llama_vocab_is_eog(vocab, token)) { break; }
            char piece[256];
            int32_t n = llama_token_to_piece(vocab, token, piece, (int32_t)sizeof(piece), 0, false);
            if (n < 0) {
                std::vector<char> big((size_t)(-n), 0);
                n = llama_token_to_piece(vocab, token, big.data(), (int32_t)big.size(), 0, false);
                if (n > 0) { answer.append(big.data(), (size_t)n); }
            } else if (n > 0) {
                answer.append(piece, (size_t)n);
            }
            llama_batch batch = llama_batch_init(1, 0, 1);
            batch.token[0] = token;
            batch.pos[0] = nPast;
            batch.n_seq_id[0] = 1;
            batch.seq_id[0][0] = 0;
            batch.logits[0] = 1;
            const int32_t rc = llama_decode(context.get(), batch);
            llama_batch_free(batch);
            if (rc != 0) {
                setError(errorBuffer, errorBufferLength, "answering failed partway");
                return nullptr;
            }
            nPast++;
        }
        if (answer.empty()) {
            setError(errorBuffer, errorBufferLength, "the vision brain looked but didn't answer");
            return nullptr;
        }
        return strdup(answer.c_str());
    } catch (const std::exception &) {
        setError(errorBuffer, errorBufferLength, "the vision engine hit an internal error");
        return nullptr;
    } catch (...) {
        setError(errorBuffer, errorBufferLength, "the vision engine hit an internal error");
        return nullptr;
    }
}

} // namespace

char *GUSVisionDescribe(const char *modelPath,
                        const char *mmprojPath,
                        const unsigned char *jpegData,
                        size_t jpegLength,
                        const char *prompt,
                        char *errorBuffer,
                        size_t errorBufferLength) {
    @try {
        return describeImpl(modelPath, mmprojPath, jpegData, jpegLength,
                            prompt, errorBuffer, errorBufferLength);
    } @catch (NSException *exception) {
        setError(errorBuffer, errorBufferLength, "the vision engine hit an internal error");
        return nullptr;
    }
}

void GUSVisionFree(char *text) {
    std::free(text);
}
