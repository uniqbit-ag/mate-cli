# Third-Party Notices

Mate's own code remains under the [MIT license](LICENSE). Third-party code,
assets, data, workflow text, and tools retain their respective licenses. This
document does not relicense them, override restrictions, grant permissions on
their owners' behalf, or establish complete legal clearance.

## Restricted and non-MIT components — review before redistribution

- **React Doctor and oxlint-plugin-react-doctor 0.9.13:** Modified MIT,
  copyright 2026 Million Software, Inc. These are **not standard MIT**.
  Prior written permission is required for the specified AI training,
  fine-tuning, evaluation-data, and automated model-improvement uses, and for
  selling or offering paid/hosted/managed products whose value derives entirely
  or substantially from the software. Do not assume permission for those uses.
  Core installs React Doctor as a runtime dependency. Full observed terms are
  reproduced below; upstream: <https://github.com/millionco/react-doctor>.
- **Context Mode 1.0.169:** Elastic License 2.0, copyright 2026 Mert Koseoglu;
  shipped in the container's prebuilt workspace. You may not provide it as a
  hosted/managed service exposing a substantial set of its features. Preserve
  licensing notices and license-key protections; recipients must receive the
  terms, and modified copies need prominent modification notices. This is not
  MIT or Apache-2.0 permission. Full terms accompany the upstream component:
  <https://github.com/mksglu/context-mode/blob/v1.0.169/LICENSE>.
- **Claude Code 2.1.286:** proprietary Anthropic binary in the container;
  **no MIT/Apache redistribution grant is asserted**. Applicable
  [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) or
  [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) govern use.
  [Product-preinstallation conditions](https://code.claude.com/docs/en/legal-and-compliance)
  require agreement to Commercial Terms unless otherwise agreed: unmodified
  binary, no removal/disabling/restriction of authentication methods, and each
  end user authenticates and pays under their own agreement. Do not pay for,
  resell, or intermediate end-user usage. Preserve trademark restrictions and
  Anthropic's own authentication flows; do not collect/intermediate Claude.ai
  credentials. Acceptance and suitability for the intended distribution remain
  a human/legal decision, not established by this notice.
- **Lightning CSS 1.33.0:** MPL-2.0, upstream
  <https://github.com/parcel-bundler/lightningcss>. The installed package's
  `LICENSE` contains full terms. If covered code/native binaries are distributed,
  preserve notices, make covered Source Code (including covered modifications)
  available under MPL-2.0, and inform recipients how to obtain it. Building CSS
  with the tool does not alone establish that the tool is redistributed. Native
  per-platform package coverage and source delivery remain unverified.
- **Attribution-licensed data:** `caniuse-lite` 1.0.30001806 (CC-BY-4.0;
  <https://github.com/browserslist/caniuse-lite>, based on Can I Use data,
  <https://caniuse.com>), and `spdx-exceptions` 2.5.0 (CC-BY-3.0;
  <https://github.com/kemitchell/spdx-exceptions.json>, SPDX exception-list data).
  When redistributed, retain supplied creator/copyright and license notices,
  identify modifications, and provide applicable license links:
  <https://creativecommons.org/licenses/by/4.0/> and
  <https://creativecommons.org/licenses/by/3.0/>. The installed `caniuse-lite/LICENSE`
  contains full terms; `spdx-exceptions/package.json` declares its license.
  Exact artifact inclusion and complete upstream attribution remain to be checked;
  these labels alone are not a completed attribution record.

## Scope and version sources

This is a maintained inventory of identified components and obligations, not an
exhaustive SBOM or certification. Resolved versions come from `bun.lock`, package
manifests, and `apps/mate-container/locks/`; standalone tool pins come from
`apps/mate-container/image-inputs.yaml`. Recheck license texts when versions change.

| Distribution | Third-party material | Notice coverage |
| --- | --- | --- |
| npm CLI and Core | Separately installed runtime dependencies | Preserve installed packages' copyright, license, and NOTICE files. Development dependencies are not necessarily redistributed. |
| Studio inside Core | Bundled client/server code and assets in `studio-dist/` | Full transitive inventory and embedded-notice completeness require verification against release artifacts. |
| Core skill templates | Adapted OpenSpec workflows | Preserve the [existing full OpenSpec notice](packages/mate-core/src/templates/mate-skills/THIRD-PARTY-NOTICES.md) and source headers. |
| VS Code extension | Bundled extension code and media; VS Code API remains external | Explicit VSIX staging copies root `LICENSE`, not this document. Notice coverage remains unresolved. |
| Appliance container | npm tools, prebuilt workspace, standalone binaries, Python environment, OS and base-image components | Preserve accompanying licenses; binary notices and source obligations require artifact-level verification. |
| Build tooling | Compilers, tests, packaging and other development tools | Review generated or bundled output separately; build-only status is not a license exemption. |

## Maintenance

On additions, upgrades, replacements, removals, copied assets or text, and changes
to bundling or redistribution: inspect actual license terms, update affected
notices and attribution, and check final npm, VSIX, and image contents. Preserve
upstream copyright, license, and NOTICE files; identify modifications where required.
Escalate restrictive, unclear, or incompatible terms for human decision before
introducing or shipping affected material. A generic third-party exception is not
permission. Do not silently change Mate's MIT license or record unapproved
permissions as granted.

## Component inventory

Snapshot reviewed 2026-11-09. Exact observed versions below are not automatic
updates: compare with the authoritative manifests and locks before each release.
Installed-package paths below mean `node_modules/<package>/...` in that package's
installation, not a guarantee that a release artifact contains the same file.

### OpenSpec workflow text

OpenSpec 1.15.0, copyright (c) 2024 OpenSpec Contributors, MIT;
<https://github.com/Fission-AI/OpenSpec>. Adapted workflow references in Core's
skill templates rewrite commands to Mate skills. Full text and affected paths
remain in the existing nested notice linked above; do not replace or remove it.
The separately installed `@fission-ai/openspec` dependency retains its own notices.

### Studio libraries bundled into Core

Source of dependency versions: `packages/mate-studio/package.json` and `bun.lock`.
These are direct library inputs, not a complete emitted-bundle/transitive SBOM.
License and attribution texts from installed packages are reproduced in the
appendix. Retain any additional NOTICE files and mark changes where required.
Apache-2.0 requires license delivery and preservation of applicable attribution;
MIT requires preservation of copyright and permission notices.

| Component | Observed version | License | Upstream | Accompanying file |
| --- | --- | --- | --- | --- |
| `@base-ui/react` | 1.9.0 | MIT | https://github.com/mui/base-ui | `@base-ui/react/LICENSE` |
| `@tanstack/react-query` | 5.105.3 | MIT | https://github.com/TanStack/query | `@tanstack/react-query/LICENSE` |
| `@tanstack/react-router` | 1.170.46 | MIT | https://github.com/TanStack/router | `@tanstack/react-router/LICENSE` |
| `@tanstack/react-router-ssr-query` | 1.167.3 | MIT | https://github.com/TanStack/router | `@tanstack/react-router-ssr-query/LICENSE` |
| `@tanstack/react-start` | 1.169.4 | MIT | https://github.com/TanStack/router | `@tanstack/react-start/LICENSE` |
| `@wterm/dom` | 0.5.7 | Apache-2.0 | https://github.com/vercel-labs/wterm | `@wterm/dom/LICENSE` |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | https://github.com/joe-bell/cva | `class-variance-authority/LICENSE` |
| `clsx` | 2.1.1 | MIT | https://github.com/lukeed/clsx | `clsx/license` |
| `graphology` | 0.26.0 | MIT | https://github.com/graphology/graphology | `graphology/LICENSE.txt` |
| `graphology-layout-forceatlas2` | 0.10.1 | MIT | https://github.com/graphology/graphology | `graphology-layout-forceatlas2/LICENSE.txt` |
| `react` | 19.2.7 | MIT | https://github.com/facebook/react | `react/LICENSE` |
| `react-dom` | 19.2.7 | MIT | https://github.com/facebook/react | `react-dom/LICENSE` |
| `recharts` | 3.10.1 | MIT | https://github.com/recharts/recharts | `recharts/LICENSE` |
| `sigma` | 4.0.4 | MIT | https://github.com/jacomyal/sigma.js | `sigma/LICENSE.txt` |
| `tailwind-merge` | 3.7.0 | MIT | https://github.com/dcastil/tailwind-merge | `tailwind-merge/LICENSE.md` |
| `zustand` | 5.0.16 | MIT | https://github.com/pmndrs/zustand | `zustand/LICENSE` |

### Separately installed runtime libraries

Core's authoritative direct list is `packages/mate-core/package.json`; CLI's is
`apps/mate-cli/package.json`. CLI dependencies remain external rather than being
inlined into the CLI bundle. Identified permissive families include React/Ink,
Xterm and its addons, TanStack, Secretlint, OpenSpec, JSONC Parser, Marked,
Semver, smol-toml, YAML, Zod, and AI SDK packages. Preserve each installed
package's own license and applicable NOTICE files; do not infer a transitive
component's license from its parent. WTerm Core/DOM are Apache-2.0, not MIT.
React Doctor's different terms are highlighted above. `bun.lock` identifies the
resolved graph, including platform-specific packages; it is not legal clearance.

| Core dependency | Observed version | Declared license | Upstream | Installed license location |
| --- | --- | --- | --- | --- |
| `@ai-sdk/harness` | 1.0.167 | Apache-2.0 | https://github.com/vercel/ai | `@ai-sdk/harness/LICENSE` |
| `@ai-sdk/harness-claude-code` | 1.0.171 | Apache-2.0 | https://github.com/vercel/ai | `@ai-sdk/harness-claude-code/LICENSE` |
| `@fission-ai/openspec` | 1.15.0 | MIT | https://github.com/Fission-AI/OpenSpec | `@fission-ai/openspec/LICENSE` |
| `@opencode/plugin` | 2.0.23 | MIT | See package metadata | Unresolved: inspect upstream distribution |
| `@secretlint/core` | 13.0.7 | MIT | https://github.com/secretlint/secretlint | `@secretlint/core/LICENSE` |
| `@secretlint/secretlint-rule-preset-recommend` | 13.0.7 | MIT | https://github.com/secretlint/secretlint | `@secretlint/secretlint-rule-preset-recommend/LICENSE` |
| `@secretlint/types` | 13.0.7 | MIT | https://github.com/secretlint/secretlint | `@secretlint/types/LICENSE` |
| `@tanstack/highlight` | 0.0.10 | MIT | https://github.com/TanStack/highlight | `@tanstack/highlight/LICENSE` |
| `@wterm/core` | 0.5.7 | Apache-2.0 | https://github.com/vercel-labs/wterm | `@wterm/core/LICENSE` |
| `@xterm/addon-clipboard` | 0.2.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-clipboard | `@xterm/addon-clipboard/LICENSE` |
| `@xterm/addon-fit` | 0.11.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit | `@xterm/addon-fit/LICENSE` |
| `@xterm/addon-unicode11` | 0.9.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-unicode11 | `@xterm/addon-unicode11/LICENSE` |
| `@xterm/addon-web-links` | 0.12.0 | MIT | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-web-links | `@xterm/addon-web-links/LICENSE` |
| `@xterm/xterm` | 6.0.0 | MIT | https://github.com/xtermjs/xterm.js | `@xterm/xterm/LICENSE` |
| `ai` | 7.0.156 | Apache-2.0 | https://github.com/vercel/ai | `ai/LICENSE` |
| `ink` | 7.1.1 | MIT | https://github.com/vadimdemedes/ink | `ink/license` |
| `jsonc-parser` | 3.3.1 | MIT | https://github.com/microsoft/node-jsonc-parser | `jsonc-parser/LICENSE.md` |
| `marked` | 18.1.1 | MIT | https://github.com/markedjs/marked | `marked/LICENSE` |
| `react` | 19.2.7 | MIT | https://github.com/facebook/react | `react/LICENSE` |
| `react-doctor` | 0.9.13 | SEE LICENSE IN LICENSE | https://github.com/millionco/react-doctor | `react-doctor/LICENSE` |
| `semver` | 7.8.5 | ISC | https://github.com/npm/node-semver | `semver/LICENSE` |
| `smol-toml` | 1.9.1 | BSD-3-Clause | https://github.com/squirrelchat/smol-toml | `smol-toml/LICENSE` |
| `yaml` | 2.9.0 | ISC | https://github.com/eemeli/yaml | `yaml/LICENSE` |
| `zod` | 4.6.7 | MIT | https://github.com/colinhacks/zod | `zod/LICENSE` |

### Container tools and runtimes

Pins and download provenance: `apps/mate-container/image-inputs.yaml`.
The global npm and local workspace locks live in `apps/mate-container/locks/`;
`graphify.requirements.txt` pins Python dependencies. These are container-only
redistribution paths, not a claim that all tools ship in the npm CLI or VSIX.

| Component | Observed pin | License/provenance and obligations |
| --- | --- | --- |
| TokenSave | 7.15.0 | MIT, copyright (c) 2025 Enzo Lombardi; <https://github.com/aovestdipaperino/tokensave/blob/v7.15.0/LICENSE>. Preserve full license/copyright with binaries. |
| RTK | 1.1.0 | Apache-2.0, copyright 2026 RTK AI Labs; <https://github.com/rtk-ai/rtk/blob/v1.1.0/LICENSE>. Preserve license and applicable NOTICE; identify modifications. |
| Graphify (`graphifyy`) | 0.9.80 | Apache-2.0; <https://pypi.org/project/graphifyy/0.9.80/>. Preserve distribution license/attribution and inspect each pinned Python dependency separately. |
| uv | 0.12.23 | MIT OR Apache-2.0; <https://github.com/astral-sh/uv/tree/0.12.23>. Preserve selected license and all applicable component notices. |
| OpenCode | 2.0.24 | MIT declared by the exact runtime package metadata: <https://registry.npmjs.org/@opencode/cli-linux-x64/2.0.24>; per-platform npm runtime tarballs. Exact binary/transitive notices and redistribution coverage remain unresolved; do not infer terms from the plugin SDK. |
| Context7 MCP | 4.2.0 | `@upstash/context7-mcp`; <https://github.com/upstash/context7>. Preserve installed license/NOTICE files; validate exact locked package and dependency notices. |
| OpenSpec | 1.15.0 | MIT; global lock may retain a separate copy in addition to Core's dependency. Preserve both installations' notices. |
| Context Mode | 1.0.169 | Elastic-2.0; restricted terms above. Preserve its license in the prebuilt workspace and copies. |
| Claude Code | 2.1.286 | Proprietary; preinstallation and use conditions above, not an open-source grant. |
| Bun | 1.4.2 | MIT for Bun's own code, with third-party notices; <https://github.com/oven-sh/bun/tree/bun-v1.4.2>. Preserve compiled-in component notices. |
| Node.js / npm | 24.21.0 / 11.19.0 | <https://github.com/nodejs/node> / <https://github.com/npm/cli>. Node's MIT license includes additional component licenses; npm is Artistic-2.0 with separately licensed dependencies. Check exact image contents, not a single umbrella label. |
| CPython | 3.14.7 | PSF and bundled-component terms; <https://www.python.org/downloads/>. Preserve Python's full license/acknowledgments and inspect the uv-provided runtime distribution. |
| Debian base and OS tools | Pinned digests/versions in image inputs | Debian 13.7; Git, tar, gzip, xz-utils, OpenSSH client, certificates and transitive OS packages have distinct terms, including copyleft. Preserve `/usr/share/doc/*/copyright`; determine corresponding-source and source-offer obligations for the distributed image. |

### Unresolved release-artifact coverage

- A root Markdown notice does **not** ensure notice delivery. CLI/Core npm
  allowlists and explicit VSIX staging do not establish that this root file ships.
  Core bundles Studio and adapted workflows; verify all required license texts,
  attribution and NOTICE files inside the final tarballs and VSIX.
- Installed dependency manifests and preliminary bundle license comments are
  evidence, not an exhaustive license audit. Full Studio transitive code/assets,
  fonts/icons, server dependencies, extension media, and modified material need
  final artifact inventory. No final release artifact was certified here.
- Standalone binary extraction may omit archive license files. Check amd64 and
  arm64 separately, including static/system libraries, native npm packages, and
  Python wheels. Preserve notices and satisfy applicable source requirements.
- Container redistribution needs OS/source compliance and preserved terms in
  installed and prebuilt/copied workspaces. Restricted-component permissions,
  hosted-service suitability, and acceptance of proprietary terms remain open
  unless separately confirmed by the responsible human.
- This documentation-only change does not repair packaging, provide source
  offers, accept terms, obtain permission, or certify a release compliant.

## License and attribution texts for identified library inputs

The following texts are copied from the observed installed packages, including
copyright statements. Identical full texts are grouped; no rights are added.
This appendix does not replace component-specific NOTICE files or the unresolved
artifact review above.

### Library notice 1

- `@base-ui/react` 1.9.0 — `LICENSE`

```text
MIT License

Copyright (c) 2019 Material-UI SAS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Library notice 2

- `@tanstack/react-query` 5.105.3 — `LICENSE`
- `@tanstack/react-router` 1.170.46 — `LICENSE`
- `@tanstack/react-router-ssr-query` 1.167.3 — `LICENSE`
- `@tanstack/react-start` 1.169.4 — `LICENSE`

```text
MIT License

Copyright (c) 2021-present Tanner Linsley

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Library notice 3

- `@wterm/dom` 0.5.7 — `LICENSE`

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to the Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by the Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding any notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Copyright 2025 Vercel, Inc.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### Library notice 4

- `class-variance-authority` 0.7.1 — `LICENSE`

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Copyright 2022 Joe Bell

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

### Library notice 5

- `clsx` 2.1.1 — `license`

```text
MIT License

Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Library notice 6

- `graphology` 0.26.0 — `LICENSE.txt`
- `graphology-layout-forceatlas2` 0.10.1 — `LICENSE.txt`

```text
The MIT License (MIT)

Copyright (c) 2016-2021 Guillaume Plique (Yomguithereal)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### Library notice 7

- `react` 19.2.7 — `LICENSE`
- `react-dom` 19.2.7 — `LICENSE`

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Library notice 8

- `recharts` 3.10.1 — `LICENSE`

```text
The MIT License (MIT)

Copyright (c) 2015-present recharts

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Library notice 9

- `sigma` 4.0.4 — `LICENSE.txt`

```text
Copyright (C) 2012-2026, Alexis Jacomy, Guillaume Plique, Benoît Simard https://www.sigmajs.org

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
```

### Library notice 10

- `tailwind-merge` 3.7.0 — `LICENSE.md`

```text
MIT License

Copyright (c) 2021 Dany Castillo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Library notice 11

- `zustand` 5.0.16 — `LICENSE`

```text
MIT License

Copyright (c) 2019 Paul Henschel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### React Doctor and oxlint-plugin-react-doctor 0.9.13

Both observed packages carry these terms verbatim:

```text
Modified MIT License

Copyright (c) 2026 Million Software, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Our only modification is that the following uses require prior written
permission from the copyright holder. To request permission, contact
founders@million.dev.

1. Using the Software, its source code, or any derivative works thereof, in
   whole or in part, as training, fine-tuning, or evaluation data, or as input
   to any automated pipeline for training or improving any machine learning
   model or AI system.

2. Selling the Software, or offering it to third parties as a paid, hosted, or
   managed product or service (including any commercial API or SaaS offering)
   whose value derives entirely or substantially from the Software.
```
