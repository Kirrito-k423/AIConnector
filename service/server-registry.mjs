// A separate, locally granted registry lets maintenance add server experiments
// without granting writes to model credentials, transport or local commands.
const need=(ok,code)=>{if(!ok)throw new Error(code);};
const name=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
export function validateRegistry(value) {
  need(value?.schema==='aiconnector.server-registry.v1','INVALID_SERVER_REGISTRY');
  need(Array.isArray(value.machineIds)&&value.machineIds.length>0&&value.machineIds.length<=12&&value.machineIds.every(x=>typeof x==='string'&&x.length>0&&x.length<=256)&&new Set(value.machineIds).size===value.machineIds.length,'INVALID_SERVER_MACHINES');
  need(value.profiles&&typeof value.profiles==='object'&&!Array.isArray(value.profiles)&&Object.keys(value.profiles).length<=24,'INVALID_SERVER_PROFILES');
  for(const [id,p]of Object.entries(value.profiles)){
    need(name.test(id)&&!['constructor','prototype','__proto__','server-maintenance'].includes(id),'INVALID_SERVER_PROFILE_ID');
    need(p.kind==='simplehtmlwatch'&&value.machineIds.includes(p.machineId)&&!p.group&&!p.allowAnyMachine&&!p.allowTaskArguments,'SERVER_PROFILE_SCOPE');
    need(['probe','experiment'].includes(p.mode)&&name.test(p.entry)&&typeof p.repository==='string'&&p.repository.length>0&&p.repository.length<=128&&/^[\w.-]{1,128}$/.test(p.revision),'INVALID_SERVER_PROFILE');
    need(typeof p.shell==='string'&&p.shell.length>0&&typeof p.revisionCommand==='string'&&p.revisionCommand.length>0&&Buffer.byteLength(p.shell+p.revisionCommand)+p.revision.length<3800,'WATCH_COMMAND_TOO_LARGE');
    need(Array.isArray(p.outputs)&&p.outputs.length>0&&p.outputs.length<=16&&p.outputs.every(x=>name.test(x)),'INVALID_SERVER_OUTPUTS');
    need(Array.isArray(p.verification)&&p.verification.length>0&&p.verification.length<=16,'ACCEPTANCE_CHECKS_NOT_CONFIGURED');
    const ids=new Set();
    for(const c of p.verification){
      need(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(c.id)&&!ids.has(c.id),'INVALID_CHECK_ID');ids.add(c.id);
      need(['execution','output-json'].includes(c.kind)&&(Object.hasOwn(c,'equals')||c.exists===true),'INVALID_SERVER_CHECK');
      if(c.kind==='output-json')need(p.outputs.includes(c.file)&&typeof c.pointer==='string'&&(c.pointer===''||c.pointer.startsWith('/')),'INVALID_SERVER_CHECK');
    }
  }
  need(Buffer.byteLength(JSON.stringify(value))<=65536,'SERVER_REGISTRY_TOO_LARGE');
  return value;
}
