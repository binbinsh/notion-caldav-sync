import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';

const files = (await readdir('tests/e2e')).filter(f => f.endsWith('.test.mjs')).sort().map(f => 'tests/e2e/' + f);
const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files];
const command = 'TEST_DATABASE_URL="$TEST_DATABASE_URL" ' + [process.execPath, ...args].join(' ');
await mkdir('artifacts/e2e', { recursive: true });
await writeFile('artifacts/e2e/command.txt', command + '\n');
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let transcript = '';
for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  stream.on('data', data => { transcript += data; output.write(data); });
}
const exitCode = await new Promise(resolve => child.on('close', resolve));
await writeFile('artifacts/e2e/transcript.tap', transcript);
await writeFile('artifacts/e2e/result.json', JSON.stringify({ command, startedAt,
  completedAt: new Date().toISOString(), exitCode,
  passed: Number(transcript.match(/# pass (\d+)/)?.[1] || 0), failed: Number(transcript.match(/# fail (\d+)/)?.[1] || 0),
  externalServices: 'deterministic HTTP protocol fixtures', runtime: 'Node.js HTTP with real PostgreSQL', database: (()=>{const u=new URL(process.env.TEST_DATABASE_URL || 'postgres://binbinsh@127.0.0.1:55439/notion_sync_test');u.password='';return u.href;})(),
}, null, 2) + '\n');
process.exitCode = exitCode ?? 1;
