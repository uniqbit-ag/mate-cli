Implementation Complete

Change: opencode-plugin-package-extraction (schema: mate-v1)
Progress: 30/30 tasks complete ✓ — full suite green: 965 tests pass, 0 fail (CLI 913, plugin 35, core 17), typecheck and format clean, lint warnings-only (matching pre-existing repo style).

What was built

packages/mate-core (new, dependency-free) — the shared CLI↔plugin runtime protocol: MATE_ENV variable names, the normalized CompanionRuntimeContext with readCompanionRuntimeContext(), and the versioned .mate-guidance.json contract with pure parseGuidanceFileContent/validateGuidanceData helpers, all unit-tested.

apps/mate-opencode-plugin (nin sources moved in as private modules, composed by a ./server aggregate entry (add-dir → hooks → coold alphabetical discovery oeserving the TuiPluginModulecontract. It owns @opencode-ai/plugin, @opentui/* ^0.4.5 (resolving tvs >=0.4.5 peer mismatch — vpat test), and@uniqbit/mate-core. The packed-package smoke test packs both tarballsin a temp project outside thies exactly like OpenCode'sloader (package root + export subpath), and confirms ./server loads, without Mate env, and ./tui
                                                                     Release coordination — scrips runs as release-it'safter:bump hook on both channels, propagating the bumped version to apackages and every dependencnifests; publish.sh validatessynchronized versions and publishes core → plugin → CLI. Setup pins  @uniqbit/mate-opencode-pluginCodePluginPackageReference(); mate update pre-fetches the new plugin version into OpenCode's cache (~/.cache/opencode/packages/e's observed on-demandlayout), warning without failing when offline.

Setup provider rewrite — no more file copying or hash-manifest-of-copied-files: sync
merges opencode.json/tui.jsole/legacy Mate plugin entryfor the current pin (preserving user plugins like graphify's), writes guidance, and
keeps a v5 manifest for cheation removes the known copiedplugin filenames and old Mate-injected OpenTUI pins while preserving user deps,
lockfiles, and node_modules. references and deletes config files only when nothing but template defaults remains. Cache warming runs in setup
mode only (launch sync staysMATE_DISABLE_OPENCODE_PLUGIN_PREFETCH=1 escape hatch used by the test suites.

Launch preflight — validates opencode.json/tui.json package references (distinct missing/stale/unreadable err@uniqbit/mate-opencode-plugin@<version>) and guidance via the core validator; the MATE_* launch env contract i

Two things worth knowing: thes you may see locally arepre-existing pollution from running tests inside a Mate session (they pass with     MATE_* env stripped, verifielow still gets its first liveexercise on the next canary release — the plugin loads via the packed-tarball gate, but mate opencode against a (design's migration step 7)can only happen post-release.

All tasks are checked off in tasks.md. Ready to archive this change.