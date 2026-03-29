'use strict';

const esbuild = require('esbuild');

const base = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  minify: true,
  sourcemap: true,
};

esbuild.buildSync({
  ...base,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main/index.js',
});
esbuild.buildSync({
  ...base,
  entryPoints: ['src/post.ts'],
  outfile: 'dist/post/index.js',
});
