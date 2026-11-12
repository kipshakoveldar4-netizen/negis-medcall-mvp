import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { digest, readReviewedChain } from './migration-chain-review.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const protectedFiles=['059_site_blog_drafts.sql','065_operator_arrival_attribution.sql'];
const sourceSnapshot=async()=>Promise.all(protectedFiles.map(async file=>{
  const target=path.join(root,'migrations',file),metadata=await stat(target);
  return {file,sha256:digest(await readFile(target)),size:metadata.size,mtime:metadata.mtimeMs};
}));

test('actual Git checkouts preserve every reviewed SQL byte without normalization or hash repinning',{timeout:120000},async t=>{
  const chain=await readReviewedChain(path.join(root,'migrations'));
  const protectedBefore=await sourceSnapshot();
  const attributes=await readFile(path.join(root,'.gitattributes'),'utf8');
  const rows=chain.map(({file,source})=>{
    const crlf=source.includes('\r\n'),rest=source.replaceAll('\r\n','');
    assert.ok(!rest.includes('\r')&&(!crlf||!rest.includes('\n')),'Mixed SQL endings require review, not normalization');
    return {file,eol:crlf?'crlf':'lf'};
  });
  let selfRules=0;
  const declared=attributes.split(/\r?\n/).filter(line=>line.trim()&&!line.startsWith('#')).flatMap(line=>{
    if(line==='/.gitattributes text eol=lf'){selfRules++;return [];}
    const match=/^\/migrations\/(\d{3}_[a-z0-9_]+\.sql) text eol=(lf|crlf)$/.exec(line);
    assert.ok(match,'Only exact reviewed migration paths and text/eol settings are in scope');
    return [{file:match[1],eol:match[2]}];
  });
  assert.equal(selfRules,1,'The format contract itself must survive checkout byte-for-byte');
  assert.deepEqual(declared,rows,'Each original receipt gets its existing byte format, not a newly normalized digest');

  await mkdir(path.join(root,'node_modules/.cache'),{recursive:true});
  const cache=await realpath(path.join(root,'node_modules/.cache'));
  const folder=await mkdtemp(path.join(cache,'migration-checkout-owned-'));
  t.after(async()=>{
    assert.equal(path.dirname(path.resolve(folder)),cache);
    assert.equal(await realpath(folder),folder);
    assert.ok(path.basename(folder).startsWith('migration-checkout-owned-'));
    await rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    assert.deepEqual(await sourceSnapshot(),protectedBefore,'Protected sources keep both bytes and file timestamps');
    assert.deepEqual((await readReviewedChain(path.join(root,'migrations'))).map(row=>[row.file,row.sha256]),chain.map(row=>[row.file,row.sha256]));
  });
  const repo=path.join(folder,'repository'),empty=path.join(folder,'empty-config'),templates=path.join(folder,'empty-template');
  await mkdir(repo);await mkdir(templates);await writeFile(empty,'');
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>
    /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE)$/i.test(key)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:empty,GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  const git=(args,input)=>{
    const result=spawnSync('git',['-C',repo,'-c','core.attributesFile='+empty,'-c','core.hooksPath='+templates,
      '-c','credential.helper=','-c','protocol.allow=never',...args],
    {env,input,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:2*1024*1024});
    assert.equal(result.error,undefined,'Only installed local Git is used; no installation or network fallback');
    assert.equal(result.status,0,'Owned Git fixture failed: '+args.join(' ')+'\n'+result.stderr);
    return result.stdout;
  };
  git(['init','--quiet','--template='+templates]);
  assert.equal(git(['remote']).trim(),'');
  const index=[];
  for(const entry of chain){
    // Use Git's clean filter itself, not a test-side normalized SQL baseline.
    const oid=git(['-c','core.autocrlf=true','hash-object','-w','--path=migrations/'+entry.file,'--stdin'],entry.source).trim();
    assert.match(oid,/^[a-f0-9]{40}$/);
    index.push('100644 '+oid+'\tmigrations/'+entry.file+'\0');
  }
  git(['update-index','-z','--index-info'],index.join(''));
  const checkout=async(label,auto,eol)=>{
    const output=path.join(folder,label);await mkdir(output);
    git(['-c','core.autocrlf='+auto,'-c','core.eol='+eol,'checkout-index','--all','--prefix='+output.replaceAll('\\','/')+'/']);
    return output;
  };
  for(const [auto,eol,expectedEol] of [['false','lf','lf'],['true','lf','crlf']])await t.test('without rules, actual core.autocrlf='+auto+' cannot reproduce the existing mixed receipt set',async()=>{
    const output=await checkout('before-'+auto,auto,eol);
    const mismatch=[];
    for(const entry of chain)if(digest(await readFile(path.join(output,'migrations',entry.file)))!==entry.sha256)mismatch.push(entry.file);
    assert.equal(mismatch.length,rows.filter(row=>row.eol!==expectedEol).length);
    assert.ok(mismatch.length>0,'The fixture must reproduce the portability defect before accepting a rule');
    await assert.rejects(()=>readReviewedChain(path.join(output,'migrations')),/source changed after outward-effect review/);
    t.diagnostic(mismatch.length+' original receipts differ; no SQL is applied from this refused checkout');
  });

  await writeFile(path.join(repo,'.gitattributes'),attributes);
  const oid=git(['hash-object','-w','--stdin'],attributes).trim();assert.match(oid,/^[a-f0-9]{40}$/);
  git(['update-index','-z','--index-info'],'100644 '+oid+'\t.gitattributes\0');
  const probe=[{path:'.gitattributes',eol:'lf'},...rows.map(row=>({path:'migrations/'+row.file,eol:row.eol})),
    ...['migrations/001_unreviewed.sql','migrations/119_unreviewed.sql','lib/crm/server.ts','README.md'].map(path=>({path,eol:'unspecified'}))];
  const parts=git(['check-attr','--cached','-z','--stdin','text','eol'],probe.map(row=>row.path).join('\0')+'\0').split('\0');
  assert.equal(parts.pop(),'');assert.equal(parts.length,probe.length*6);
  for(let i=0;i<probe.length;i++){
    const {path,eol}=probe[i];
    assert.deepEqual(parts.slice(i*6,i*6+6),[path,'text',eol==='unspecified'?'unspecified':'set',path,'eol',eol]);
  }
  let firstCheckout;
  for(const [label,auto,eol] of [['false-lf','false','lf'],['false-crlf','false','crlf'],['true','true','lf'],['input','input','lf']])
    await t.test('reviewed rules reproduce exact source bytes with autocrlf='+auto+' and core.eol='+eol,async()=>{
      const output=await checkout('after-'+label,auto,eol);firstCheckout??=output;
      const actual=await readReviewedChain(path.join(output,'migrations'));
      assert.deepEqual(actual.map(row=>[row.file,row.source,row.sha256]),chain.map(row=>[row.file,row.source,row.sha256]));
      assert.equal(await readFile(path.join(output,'.gitattributes'),'utf8'),attributes);
    });
  await t.test('raw review still refuses an ending-only change and an SQL edit after a correct checkout',async()=>{
    const target=path.join(firstCheckout,'migrations','118_appointment_version_entry.sql');
    const original=await readFile(target,'utf8');assert.ok(!original.includes('\r\n'));
    for(const mutant of [original.replaceAll('\n','\r\n'),original+'\n-- owned unreviewed SQL mutation\n']){
      await writeFile(target,mutant);
      await assert.rejects(()=>readReviewedChain(path.join(firstCheckout,'migrations')),/source changed after outward-effect review/);
    }
    await writeFile(target,original);
  });
  t.diagnostic(chain.length+' exact sources; '+rows.filter(row=>row.eol==='crlf').length+' CRLF and '+rows.filter(row=>row.eol==='lf').length+' LF. No source, receipt, main index/config, database or cloud operation changed.');
});
