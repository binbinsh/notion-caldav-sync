import {build} from 'esbuild';
await build({entryPoints:['src/main.ts'],outfile:'dist/main.mjs',bundle:true,platform:'node',format:'esm',target:'node24',external:['pg'],sourcemap:true});

await build({entryPoints:['src/worker.ts'],outfile:'dist/worker.mjs',bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*'],sourcemap:true});
