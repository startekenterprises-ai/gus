/**
 * v0.38.0: the custom brain search pins.
 *
 * What is pinned here:
 *  - The fit logic is pure and conservative: a brain file
 *    may be at most 40% of the phone's physical RAM
 *    (BrainFit.ramFraction), computed from (fileBytes,
 *    physicalMemory), with the refusal reasoned in a
 *    person's words. The live UI reads the device's real
 *    physicalMemory — never a hard-coded phone model.
 *  - The catalog is Hugging Face's public API, no auth:
 *    the models list (filter=gguf, sorted by downloads),
 *    the repo tree for files, and resolve URLs for
 *    downloads. GGUF sizes and checksums come from the
 *    tree entries' LFS object (the entry's own size is
 *    the pointer file, not the model).
 *  - mmproj files are never brain files: they drive the
 *    Vision badge only, with its honest caption (the
 *    file exists; on-device vision is not wired yet).
 *    Split-GGUF shards are listed but never offered.
 *  - Custom brains persist in the library's own store
 *    (UserDefaults key gus.brains.custom — NOT the
 *    download records), carry the "custom-" id prefix
 *    the rows mark from, and resolve through the same
 *    GUSModelManifest.entry(id:) door as curated brains.
 *  - Verification degrades honestly: size always, sha256
 *    when the repo publishes one; the checksum-less path
 *    is an explicit branch, and the entry says "Checksum
 *    not published by the repo" instead of pretending.
 *  - Downloads ride the v0.28.0 background machinery:
 *    BrainSearch.swift creates no download session of
 *    its own; the search screen's Download button
 *    registers the entry and calls ModelLibrary.download.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const brainSearch = read("apps/ios/Shared/BrainSearch.swift");
const brainSearchView = read("apps/ios/App/BrainSearchView.swift");
const modelManifest = read("apps/ios/Shared/ModelManifest.swift");
const modelDownloader = read("apps/ios/Shared/ModelDownloader.swift");
const brainViews = read("apps/ios/App/BrainViews.swift");
const settingsView = read("apps/ios/App/SettingsView.swift");

test("fit: the cap is 40% of physical RAM, computed purely", () => {
  assert.ok(brainSearch.includes("static let ramFraction = 0.40"));
  assert.ok(
    brainSearch.includes(
      "Int64(Double(physicalMemory) * ramFraction)",
    ),
    "capBytes derives from the passed-in physical memory",
  );
  assert.ok(
    brainSearch.includes(
      "fileBytes > 0 && fileBytes <= capBytes(physicalMemory: physicalMemory)",
    ),
  );
  assert.ok(
    brainSearch.includes(
      "ProcessInfo.processInfo.physicalMemory",
    ),
    "the live path reads THIS device's memory",
  );
  assert.ok(
    brainSearch.includes("more than this iPhone can give a brain"),
    "the refusal is reasoned in plain words",
  );
});

test("catalog: Hugging Face public API shapes, no auth", () => {
  assert.ok(brainSearch.includes('"https://huggingface.co/api/models"'));
  assert.ok(brainSearch.includes('URLQueryItem(name: "filter", value: "gguf")'));
  assert.ok(brainSearch.includes('URLQueryItem(name: "sort", value: sort.hfValue)'));
  assert.ok(brainSearch.includes("/tree/main"));
  assert.ok(brainSearch.includes("/resolve/main/"));
  assert.ok(
    !brainSearch.includes("Authorization"),
    "the public catalog needs no credential and none is sent",
  );
});

test("filters: the Sort menu maps one-to-one onto the API's sort values (v0.47.0)", () => {
  // The three orderings, in menu order, spelled the
  // API's way — downloads / trending / lastModified —
  // and the plain searchURL keeps the downloads default.
  const sortEnum = brainSearch.slice(
    brainSearch.indexOf("enum BrainSort"),
    brainSearch.indexOf("/// The Type menu"),
  );
  const cases = [...sortEnum.matchAll(/case (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(cases, ["downloads", "trending", "lastModified"]);
  assert.ok(sortEnum.includes("var hfValue: String { rawValue }"));
  assert.ok(sortEnum.includes('"Most downloaded"'));
  assert.ok(sortEnum.includes('"Trending"'));
  assert.ok(sortEnum.includes('"Recently updated"'));
  assert.ok(
    brainSearch.includes("searchURL(query: query, sort: .downloads)"),
    "the one-argument searchURL still defaults to downloads",
  );
  // An empty query omits the search term — that query
  // IS the Popular list.
  assert.ok(brainSearch.includes("if !trimmed.isEmpty"));
  assert.ok(
    brainSearch.includes('items.append(URLQueryItem(name: "search", value: trimmed))'),
  );
});

test("filters: Type reads the siblings signal; Size reuses BrainFit purely (v0.47.0)", () => {
  assert.ok(brainSearch.includes("static func repoMatchesType(_ repo: HFRepoResult, type: BrainTypeFilter) -> Bool"));
  assert.ok(brainSearch.includes("case .vision: return repo.hasVisionFiles"));
  assert.ok(brainSearch.includes("case .textOnly: return !repo.hasVisionFiles"));
  assert.ok(
    brainSearch.includes(
      "static func visibleFiles(\n        _ files: [HFBrainFile], fitsOnly: Bool, physicalMemory: UInt64\n    ) -> [HFBrainFile]",
    ),
    "visibleFiles is pure in (files, fitsOnly, physicalMemory)",
  );
  assert.ok(
    brainSearch.includes(
      "!$0.isSplitShard && BrainFit.fits(fileBytes: $0.bytes, physicalMemory: physicalMemory)",
    ),
    "the Fits view drops shards and non-fitting files by the one fit rule",
  );
  assert.ok(brainSearch.includes("guard fitsOnly else { return files }"));
});

test("popular: the screen opens onto content, headed Popular (v0.47.0)", () => {
  assert.ok(brainSearch.includes("func loadPopularIfNeeded() async"));
  assert.ok(brainSearch.includes("guard state == .idle else { return }"));
  assert.ok(brainSearch.includes("await load(query: \"\", popular: true)"));
  assert.ok(brainSearch.includes("func applySort() async"));
  assert.ok(brainSearchView.includes(".task { await search.loadPopularIfNeeded() }"));
  assert.ok(brainSearchView.includes('Text(search.isPopular ? "Popular" : "Results")'));
  assert.ok(brainSearchView.includes("Loading popular brains…"));
  assert.ok(
    brainSearchView.includes("results.filter { BrainCatalog.repoMatchesType($0, type: typeFilter) }") ||
      brainSearch.includes("results.filter { BrainCatalog.repoMatchesType($0, type: typeFilter) }"),
    "the Type menu filters the displayed list",
  );
  assert.ok(brainSearchView.includes('Picker("Sort", selection: $search.sort)'));
  assert.ok(brainSearchView.includes('Picker("Type", selection: $search.typeFilter)'));
  assert.ok(brainSearchView.includes('Picker("Size", selection: $search.sizeFilter)'));
  assert.ok(
    brainSearchView.includes("BrainCatalog.visibleFiles("),
    "an opened repo's files pass through the Size filter",
  );
});

test("catalog: sizes and checksums come from the LFS object", () => {
  assert.ok(
    brainSearch.includes("entry.lfs?.size ?? entry.size ?? 0"),
    "an LFS file's true size is lfs.size, not the pointer size",
  );
  assert.ok(brainSearch.includes("sha256: entry.lfs?.oid"));
});

test("catalog: mmproj is a badge, never a brain; shards are listed, never offered", () => {
  assert.ok(brainSearch.includes('name.hasPrefix("mmproj")'));
  assert.ok(
    brainSearch.includes(".filter { !isVisionProjector(path: $0.path) }"),
    "brainFiles excludes projectors",
  );
  assert.ok(
    brainSearchView.includes(
      "GUS's on-device vision isn't wired yet — the brain works as a text brain.",
    ),
    "the Vision badge carries its honest caption",
  );
  assert.ok(brainSearch.includes("isSplitShard"));
  assert.ok(
    brainSearchView.includes("Split into parts — GUS can't load split brains yet."),
  );
});

test("vision honesty: no dead on-device vision path is shipped (v0.47.0)", () => {
  // v0.47.0 investigated wiring mmproj into LocalBrain:
  // the pinned LLM.swift (exact 3.0.3) exposes a
  // text-only API — Chat is (role, content: String) and
  // its C++ bridge carries no mtmd at all — so there is
  // nothing honest to wire. Until that changes, the app
  // must not grow a fake path: LocalBrain never mentions
  // a projector, and the badge caption stays the true
  // one (pinned above).
  const localBrain = read("apps/ios/Shared/LocalBrain.swift");
  assert.ok(!localBrain.includes("mmproj"), "LocalBrain ships no dead projector path");
  assert.ok(
    brainSearch.includes("vision is not wired yet"),
    "the catalog header still tells the truth about vision",
  );
});

test("custom store: library persistence, custom- ids, repo-prefixed disk names", () => {
  assert.ok(brainSearch.includes('static let defaultsKey = "gus.brains.custom"'));
  assert.ok(brainSearch.includes('static let idPrefix = "custom-"'));
  assert.ok(
    brainSearch.includes(
      'repoID.replacingOccurrences(of: "/", with: "-") + "-"',
    ),
    "on-disk names are repo-prefixed so repos can't overwrite each other",
  );
  assert.ok(
    brainSearch.includes("Checksum not published by the repo"),
    "a checksum-less entry says so in its own description",
  );
  assert.ok(brainSearch.includes("not vetted by GUS"));
});

test("integration: one entry door, presence-aware fallback includes custom brains", () => {
  assert.ok(
    modelManifest.includes("?? CustomBrainStore.shared.entry(id: id)"),
    "GUSModelManifest.entry(id:) falls through to the custom store",
  );
  assert.ok(
    modelManifest.includes(
      "CustomBrainStore.shared.entries.first(where: { ModelStore.isPresent($0) })",
    ),
    "ActiveBrain's last-resort fallback can resolve a custom brain",
  );
  assert.ok(
    modelManifest.includes("let sha256: String?"),
    "the entry's checksum is optional (curated always, custom when published)",
  );
});

test("verification: size always, hash when published — an explicit degradation", () => {
  assert.ok(
    modelDownloader.includes("var sha256: String?"),
    "download records carry the optional checksum",
  );
  assert.ok(
    modelDownloader.includes("guard let expected = entry.sha256 else"),
    "the operator re-check branches honestly when there is no hash",
  );
  assert.ok(
    modelDownloader.includes("} ?? true"),
    "verifyPartial passes on size alone only when no hash was published",
  );
});

test("downloads: the search rides the library's background machinery, no second session", () => {
  assert.ok(
    !brainSearch.includes("URLSessionConfiguration.background"),
    "BrainSearch.swift creates no download session",
  );
  assert.ok(
    brainSearchView.includes("customBrains.add(repoID: repoID, file: file)"),
  );
  assert.ok(brainSearchView.includes("library.download(entry)"));
  assert.ok(
    modelDownloader.includes(
      'static let backgroundSessionIdentifier = "com.startekenterprises.gus.modeldownloads"',
    ),
    "the one background session is still ModelLibrary's",
  );
});

test("ui: the Advanced door, the custom rows, and the search screen's honesty", () => {
  assert.ok(settingsView.includes('NavigationLink("Find a brain (advanced)")'));
  assert.ok(
    settingsView.includes("ForEach(customBrains.entries, id: \\.id)"),
    "custom brains render as library rows in Settings",
  );
  assert.ok(
    brainViews.includes("entry.id.hasPrefix(CustomBrainStore.idPrefix)"),
    "the Custom marker derives from the entry id",
  );
  assert.ok(brainViews.includes("this repo publishes no checksum"));
  assert.ok(
    brainSearchView.includes(
      "These brains come straight from Hugging Face and aren't vetted by GUS. Shield still scans your conversations as always.",
    ),
    "the search screen states its honesty once, up front",
  );
  assert.ok(brainSearchView.includes("No runnable brain files in this repo."));
  assert.ok(brainSearchView.includes("Type to search Hugging Face for a brain."));
  assert.ok(brainSearchView.includes("Fits this iPhone."));
});
