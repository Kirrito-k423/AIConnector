// Emit public contract metadata only; never print commands, paths or hosts.
import fs from 'node:fs';
import {parseProfileInput,profileDefinitions} from '../service/profile-data.mjs';
import {cleanError} from '../service/common.mjs';

try{
  if(process.argv.length!==3)throw new Error('PROFILE_FILE_REQUIRED');
  const stat=fs.statSync(process.argv[2]);if(!stat.isFile()||stat.size>65536)throw new Error('PROFILE_INPUT_TOO_LARGE');
  const profiles=parseProfileInput(fs.readFileSync(process.argv[2]));
  if(!Object.values(profiles).every(p=>p&&typeof p==='object'&&typeof p.revision==='string'))throw new Error('INVALID_SERVER_PROFILES');
  const server_profiles=profileDefinitions(profiles).map(({id,revision,definition_sha256})=>({id,revision,definition_sha256}));
  process.stdout.write(JSON.stringify({server_profiles},null,2)+'\n');
}catch(e){process.stderr.write(cleanError(e)+'\n');process.exitCode=1;}
