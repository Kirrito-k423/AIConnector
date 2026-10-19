import {need} from './common.mjs';

// Await every admitted operation before returning a failure. Confirmed siblings
// keep their checkpoints; an uncertain POST is never cancelled or blindly replayed.
export async function mapTransfers(items,concurrency,work){
  let cursor=0,error;
  const workers=Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(!error&&cursor<items.length){const item=items[cursor++];try{await work(item);}catch(e){error??=e;}}
  });
  await Promise.all(workers);if(error)throw error;
}

export class TransferPool {
  constructor(concurrency=8){need(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=8,'INVALID_TRANSFER_CONCURRENCY');this.limit=concurrency;this.active=0;this.queue=[];this.pending=new Map();}
  run(key,work){
    if(this.pending.has(key))return this.pending.get(key);
    let resolve,reject;const result=new Promise((a,b)=>{resolve=a;reject=b;});
    this.pending.set(key,result);this.queue.push({key,work,resolve,reject});this.drain();return result;
  }
  drain(){while(this.active<this.limit&&this.queue.length){
    const item=this.queue.shift();this.active++;
    Promise.resolve().then(item.work).then(item.resolve,item.reject).finally(()=>{this.active--;this.pending.delete(item.key);this.drain();});
  }}
  async idle(){while(this.pending.size)await Promise.allSettled([...this.pending.values()]);}
}
