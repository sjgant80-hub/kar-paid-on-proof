// build-evm.mjs — bundle app/browser-run.mjs (lib/flow.mjs + lib/chain-local.mjs + sdk + viem + ethereumjs)
// into app/evm.js for the page's in-browser run. Pinned esbuild, deterministic output, committed.
import { build } from 'esbuild';

await build({
  entryPoints: ['app/browser-run.mjs'],
  outfile: 'app/evm.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  define: { 'process.env.NODE_DEBUG': 'false', global: 'globalThis' },
  inject: ['app/shim.mjs'],
  logLevel: 'info',
});
