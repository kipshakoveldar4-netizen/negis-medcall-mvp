import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContributorFixture } from './contributor-browser.mjs';
export const createPartnerTermsFixture=(port=0)=>createContributorFixture(port,'partner-terms');
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  for(const key of Object.keys(process.env))if(!['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','APPDATA','LOCALAPPDATA'].includes(key))delete process.env[key];
  const fixture=await createPartnerTermsFixture(Number(process.argv.find(v=>v.startsWith('--port='))?.split('=')[1]??5270));
  process.stdout.write(fixture.origin+'/review?demo=1\n');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await fixture.close();process.exit(0);});
}
