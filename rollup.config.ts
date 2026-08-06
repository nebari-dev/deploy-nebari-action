// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

// The action has two entry points: the main step (deploy) and the post step
// (destroy), each bundled separately.
const bundle = (input, file) => ({
  input,
  output: {
    esModule: true,
    file,
    format: 'es',
    sourcemap: true
  },
  plugins: [typescript(), nodeResolve({ preferBuiltins: true }), commonjs()]
})

export default [
  bundle('src/index.ts', 'dist/index.js'),
  bundle('src/post-entry.ts', 'dist/post.js')
]
