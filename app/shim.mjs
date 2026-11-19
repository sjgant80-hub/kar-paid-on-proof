// esbuild inject: any bare `Buffer` in a dependency resolves to the browser polyfill.
export { Buffer } from 'buffer';
