import {build} from 'esbuild';
await build({entryPoints:['src/main.ts'],outfile:'dist/main.mjs',bundle:true,platform:'node',format:'esm',target:'node24',external:['pg'],sourcemap:true});
