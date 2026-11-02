'use strict';
// Explicit live probe: only a temporary mod/space is created and then removed.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const app=path.join(process.env.LOCALAPPDATA,'Programs/herdr-app/herdr-app.exe');
const home=path.join(os.homedir(),'.config/herdr-app');
const name='herdr-diagnostics-probe';
const folder=path.join(home,'mods',name);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function cli(args){const r=spawnSync(app,args,{encoding:'utf8',windowsHide:true,timeout:30000});if(r.status!==0)throw new Error(r.stderr||r.error?.message||'App command failed');const value=JSON.parse(r.stdout);if(value.error)throw new Error(value.error);return value;}
async function main(){
  if(fs.existsSync(folder))throw new Error('Probe folder already exists; preserve it for inspection.');
  const before=cli(['status']);let space;
  try{
    fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'mod.json'),'{"place":"none","title":"Diagnostic probe"}');
    fs.writeFileSync(path.join(folder,'main.js'),'import {View,div} from "gpui-kit"; let calls=0; export default class Probe extends View { render(){ if(calls++===0) throw new Error("execution interrupted: HERDR_DIAGNOSTIC_PROBE password=probe-secret-123456"); return div().child("Diagnostic recovery verified"); } }');
    await pause(2000);
    const created=cli(['do','space.new','--name','Diagnostic probe (temporary)','--folder',os.tmpdir()]);
    space=created.space||created.id;if(!space)throw new Error(`No space ID: ${JSON.stringify(created)}`);
    cli(['do','tab.new','--space',space,'--mod',name]);
    await pause(6000);
    const diagnostics=path.join(home,'diagnostics');
    const records=fs.readdirSync(path.join(diagnostics,'incidents')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(diagnostics,'incidents',f),'utf8'))).filter(r=>r.source===name);
    if(!records.length)throw new Error('Rendered error was not captured.');
    if(JSON.stringify(records).includes('probe-secret-123456'))throw new Error('Probe credential was not redacted.');
    const status=cli(['status']);
    const result={probe:'pass',records:records.map(r=>({id:r.id,count:r.count,recoveries:r.recoveries,repair:r.repair})),screen_errors:status.errors.filter(e=>e.includes(name)),user_pane:before.focused_pane};
    fs.writeFileSync(path.join(diagnostics,'runtime-probe.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  }finally{
    if(space)cli(['do','space.close','--id',space,'--confirmed','true']);
    if(before.focused_pane)cli(['do','pane.focus','--pane',before.focused_pane]);
    if(fs.existsSync(folder)&&path.basename(folder)===name&&fs.realpathSync(folder)===folder)fs.rmSync(folder,{recursive:true});
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
