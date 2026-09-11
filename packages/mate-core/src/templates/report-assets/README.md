# Report assets

Vendored browser assets inlined into `mate report` HTML output. Nothing here is
imported as a module or linted, formatted, or typechecked — these files are read
as strings at render time.

## `mermaid.min.js`

|          |                                                                          |
| -------- | ------------------------------------------------------------------------ |
| Upstream | [`mermaid`](https://www.npmjs.com/package/mermaid) `dist/mermaid.min.js` |
| Version  | `12.0.0`                                                                 |
| License  | MIT — see `mermaid.LICENSE`                                              |
| Form     | esbuild IIFE, self-contained, zero dynamic `import()` calls              |
| Size     | 5.58 MB raw                                                              |

The IIFE build is vendored rather than installed because `@uniqbit/mate-core`
publishes raw `src/` with no build step, and only mermaid's ESM build lazily
loads per-diagram chunks. It is inlined into a report document only when that
report carries a mermaid payload.

### Bumping

```sh
npm pack mermaid@<version>
tar -xzf mermaid-<version>.tgz package/dist/mermaid.min.js package/LICENSE
cp package/dist/mermaid.min.js packages/mate-core/src/templates/report-assets/mermaid.min.js
cp package/LICENSE packages/mate-core/src/templates/report-assets/mermaid.LICENSE
```

Update the version above, confirm `grep -c 'import('` on the bundle stays `0`,
then re-run the report renderer tests.
