const {spawnSync}=require('child_process');
const fs=require('fs');
const P=fs.readFileSync('./probe_common.js','utf8').trim();
const cases=[
 ['/orders',`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('新建订单'));b&&b.click();setTimeout(()=>{${P}},700)})()`],
 ['/orders/133',`(()=>{const bs=[...document.querySelectorAll('button')];const b=bs.find(x=>x.textContent.replace(/\s/g,'').includes('生成PI'));b&&b.click();setTimeout(()=>{${P}},900)})()`],
 ['/quotations',`(()=>{const r=document.querySelector('tbody tr');r&&r.click();setTimeout(()=>{${P}},900)})()`],
 ['/samples',`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='⋯');b&&b.click();setTimeout(()=>{const m=document.querySelector('.menu-item, .menu [role=menuitem], .menu button');m&&m.click();setTimeout(()=>{${P}},900)},400)})()`],
];
for(const [route,js] of cases){
 const r=spawnSync('node_modules/electron/dist/electron.exe',['.'],{env:{...process.env,MSYS_NO_PATHCONV:'1',MSYS2_ARG_CONV_EXCL:'*',IKAN_SHOT:route,IKAN_SHOT_NAME:'probe-tmp',IKAN_SHOT_JS:js},encoding:'utf8',shell:true,timeout:70000});
 const m=(r.stdout+r.stderr).match(/PROBE3 .*/);
 console.log(route, m?m[0].slice(0,2500):'NO MATCH');
}
