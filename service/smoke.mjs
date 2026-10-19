// Built-in real CPU experiment. It never calls SSH or touches an NPU.
import fs from 'node:fs';
import crypto from 'node:crypto';
const samples=10000;let sum=0;
for(let i=1;i<=samples;i++)sum+=i;
if(sum!==samples*(samples+1)/2)process.exit(1);
const evidence={schema:'aiconnector.smoke.v1',samples,sum,sha256:crypto.createHash('sha256').update(String(sum)).digest('hex'),npu:false};
fs.writeFileSync('metrics.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence));
