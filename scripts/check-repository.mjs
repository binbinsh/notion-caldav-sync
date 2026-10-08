import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))];
const violations=[];
for(const file of files){
 const text=await readFile(file,'utf8');
 if(/\p{Script=Han}/u.test(text))violations.push(file+': non-English source text');
 if(/\bagent[-_\s]*mq\b|\bplanner[.]li\b/i.test(text))violations.push(file+': private platform reference');
 if(/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(text)&&!file.startsWith('tests/'))violations.push(file+': private key material');
}
if(violations.length)throw Error(violations.join('\n'));
console.log(JSON.stringify({passed:true,files:files.length,checks:['English repository text','Independent public configuration']}));
