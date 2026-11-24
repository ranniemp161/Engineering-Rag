// Static single-page interface served by the local index viewer.
export const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Engineering Index</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--accent:#2f6f5e;--hl:#fff3c4;--code:#f1f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--text:#ecebe6;--muted:#9a9993;--line:#2e2d2a;--accent:#7cc2a8;--hl:#4a3f12;--code:#232320}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;gap:16px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
h1{font-size:16px;margin:0;font-weight:600}h1 span{color:var(--muted);font-weight:400}
.stats{display:flex;gap:18px;color:var(--muted);font-size:13px;flex-wrap:wrap}.stats b{color:var(--text)}
form{display:flex;gap:8px;flex:1;min-width:280px;justify-content:flex-end}
input,select,button{font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text)}
input{flex:1;max-width:420px}button{background:var(--accent);color:var(--panel);border:0;cursor:pointer;font-weight:600}
main{display:grid;grid-template-columns:minmax(260px,380px) 1fr;height:calc(100vh - 62px)}
aside{border-right:1px solid var(--line);overflow:auto;background:var(--panel)}
.tabs{display:flex;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel)}
.tabs button{flex:1;background:none;color:var(--muted);border-radius:0;padding:10px;font-weight:500}
.tabs button.on{color:var(--text);box-shadow:inset 0 -2px var(--accent)}
.item{padding:10px 14px;border-bottom:1px solid var(--line);cursor:pointer}.item:hover,.item.on{background:var(--bg)}
.item .t{font-weight:600}.item .p{color:var(--muted);font-size:12px;font-family:ui-monospace,Consolas,monospace;word-break:break-all}
.item .s{font-size:12.5px;color:var(--muted);margin-top:4px;white-space:pre-wrap;max-height:4.5em;overflow:hidden}
.badge{display:inline-block;font-size:11px;padding:0 6px;border-radius:4px;background:var(--code);color:var(--muted);margin-right:6px}
.group{padding:8px 14px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:var(--bg);border-bottom:1px solid var(--line)}
section{overflow:auto;padding:20px 28px}.empty{color:var(--muted);margin-top:40px;text-align:center}
.meta{color:var(--muted);font-size:13px;margin-bottom:14px}.meta code{font-family:ui-monospace,Consolas,monospace}
pre{background:var(--code);border-radius:8px;padding:12px 0;margin:0;font:13px/1.55 ui-monospace,Consolas,monospace;overflow:auto}
.ln{display:flex}.ln i{flex:0 0 52px;text-align:right;padding-right:14px;color:var(--muted);font-style:normal;user-select:none}
.ln span{white-space:pre-wrap;padding-right:16px;flex:1}.ln.hl{background:var(--hl)}
.more{margin-top:12px}.err{color:#c0392b;padding:14px}
button.ghost{background:none;color:var(--accent);border:1px solid var(--line)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:14px 0 18px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.tile span{color:var(--muted);font-size:12px}
.tile em{font-style:normal;font-size:12px;margin-left:6px}.up{color:#2e8b57}.down{color:#c0392b}
table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr.case{cursor:pointer}tr.case:hover{background:var(--panel)}
.rank{display:inline-block;min-width:28px;text-align:center;border-radius:4px;padding:0 6px;font-weight:600}
.r1{background:#2e8b5733;color:#2e8b57}.r5{background:#d4a01733;color:#b8860b}.rx{background:#c0392b26;color:#c0392b}
h3{font-size:14px;margin:18px 0 6px}
.links a{color:var(--accent);text-decoration:none}.links a:hover{text-decoration:underline}.links b{color:var(--text);font-weight:600}
@media (max-width:760px){main{grid-template-columns:1fr;height:auto}aside{max-height:45vh}}
</style></head><body>
<header><h1>Engineering Index <span>local viewer</span></h1><div class="stats" id="stats"></div>
<form id="f"><select id="proj"><option value="">Shared only</option></select><input id="q" placeholder="Search notes…" autocomplete="off"><button>Search</button><button id="evalBtn" class="ghost" type="button">Evaluate</button></form></header>
<main><aside><div class="tabs"><button id="tDocs" class="on" type="button">Documents</button><button id="tRes" type="button">Results</button></div><div id="list"></div></aside>
<section id="view"><div class="empty">Pick a document or search.</div></section></main>
<script>
const $=s=>document.querySelector(s),el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
let data,results=null,tab='docs',active=null;
async function get(u){const r=await fetch(u),j=await r.json();if(j.error)throw new Error(j.error);return j}
function stats(){const s=$('#stats');s.replaceChildren();for(const x of data.status.scopes){const d=el('div');d.append(el('b',null,x.id),' '+x.documents+' docs · '+x.chunks+' chunks'+(x.errors.length?' · '+x.errors.length+' errors':''));s.append(d)}
 const last=data.status.scopes.map(x=>x.lastSuccess).sort().pop();if(last)s.append(el('div',null,'indexed '+new Date(last).toLocaleString()))}
function render(){$('#tDocs').className=tab==='docs'?'on':'';$('#tRes').className=tab==='res'?'on':'';const L=$('#list');L.replaceChildren();
 if(tab==='docs'){let g;for(const d of data.documents){if(d.scope!==g){g=d.scope;L.append(el('div','group',g))}const it=el('div','item'+(active===d.id?' on':''));it.append(el('div','t',d.title),el('div','p',d.path+' · '+d.chunks+' chunks'));it.onclick=()=>openDoc(d.id,d.scope==='shared'?'':d.scope,1);L.append(it)}}
 else if(!results)L.append(el('div','empty','No search yet.'));
 else if(!results.length)L.append(el('div','empty','No matches.'));
 else for(const r of results){const it=el('div','item');const t=el('div','t');t.append(el('span','badge',r.score.toFixed(2)),r.title);it.append(t,el('div','p',r.relativePath+' : '+r.startLine+'–'+r.endLine+' · '+r.scope),el('div','s',r.snippet));it.onclick=()=>openDoc(r.documentId,$('#proj').value,1,[r.startLine,r.endLine]);L.append(it)}}
async function openDoc(id,project,start,hl){active=id;render();const v=$('#view');
 try{const p=new URLSearchParams({id,start});if(project)p.set('project',project);const d=await get('/api/doc?'+p);v.replaceChildren();
  v.append(el('h2',null,d.title));const m=el('div','meta');m.append(el('span','badge',d.scope),el('code',null,d.relativePath),' · lines '+d.startLine+'–'+d.endLine);v.append(m);
  const links=el('div','links');v.append(links);related(id,project,links);
  const pre=el('pre');d.text.replace(/\\n$/,'').split('\\n').forEach((line,i)=>{const n=d.startLine+i,row=el('div','ln'+(hl&&n>=hl[0]&&n<=hl[1]?' hl':''));row.append(el('i',null,n),el('span',null,line||' '));pre.append(row)});v.append(pre);
  if(d.nextStartLine){const b=el('button','more','Next 200 lines');b.onclick=()=>openDoc(id,project,d.nextStartLine,hl);v.append(b)}
  const h=v.querySelector('.hl');if(h)h.scrollIntoView({block:'center'});else v.scrollTop=0}
 catch(e){v.replaceChildren(el('div','err',e.message))}}
$('#f').onsubmit=async e=>{e.preventDefault();const q=$('#q').value.trim();if(!q)return;const p=new URLSearchParams({q});if($('#proj').value)p.set('project',$('#proj').value);
 try{results=(await get('/api/search?'+p)).results;tab='res';render()}catch(err){$('#list').replaceChildren(el('div','err',err.message))}};
async function related(id,project,box){try{const p=new URLSearchParams({id});if(project)p.set('project',project);const r=await get('/api/related?'+p);
 for(const [label,list,total] of [['Links to',r.outgoing,r.outgoingTotal],['Linked from',r.incoming,r.incomingTotal]]){if(!list.length)continue;const row=el('div','meta');row.append(el('b',null,label+' ('+total+'): '));
  list.forEach((x,i)=>{const a=el('a',null,x.title);a.href='#';a.title=x.relativePath+'\\n'+x.references.map(c=>'line '+c.line+': '+c.context).join('\\n');a.onclick=e=>{e.preventDefault();openDoc(x.documentId,project,1)};if(i)row.append(' · ');row.append(a)});box.append(row)}}
 catch(e){box.append(el('div','meta',e.message))}}
const pct=x=>(x*100).toFixed(0)+'%';
function cell(row,text,cls){const td=el('td',cls,text);row.append(td);return td}
function summaryTable(title,groups){if(!Object.keys(groups).length)return[];const t=el('table'),h=el('tr');
 for(const [x,c] of [['Group'],['Cases','num'],['hit@1','num'],['hit@5','num'],['hit@'+evalDepth,'num'],['MRR','num'],['p95 ms','num']])h.append(el('th',c,x));t.append(h);
 for(const [k,s] of Object.entries(groups)){const r=el('tr');cell(r,k);cell(r,s.cases,'num');cell(r,pct(s.hitAt1),'num');cell(r,pct(s.hitAt5),'num');cell(r,pct(s.hitAtDepth),'num');cell(r,s.mrr.toFixed(3),'num');cell(r,s.latencyP95Ms.toFixed(1),'num');t.append(r)}
 return[el('h3',null,title),t]}
let evalDepth=20;
async function evaluate(){const v=$('#view');v.replaceChildren(el('div','empty','Running evaluation…'));
 try{const r=await get('/api/eval');evalDepth=r.depth;const c=r.comparison;v.replaceChildren(el('h2',null,'Retrieval evaluation'));
  const m=el('div','meta');m.append(el('code',null,r.file),' · '+r.summary.cases+' cases · depth '+r.depth+' · '+new Date(r.generatedAt).toLocaleString()+(c?' · compared with baseline from '+new Date(c.baselineGeneratedAt).toLocaleString():''));v.append(m);
  const tiles=el('div','tiles');for(const [k,label,fmt,lowerBetter] of [['hitAt1','hit@1',pct],['hitAt5','hit@5',pct],['hitAtDepth','hit@'+r.depth,pct],['mrr','MRR',x=>x.toFixed(3)],['recallAt5','recall@5',pct],['latencyP95Ms','p95 latency (ms)',x=>x.toFixed(1),true]]){
   const t=el('div','tile'),b=el('b',null,fmt(r.summary[k]));if(c&&c.delta[k]){const d=c.delta[k],good=lowerBetter?d<0:d>0;b.append(el('em',good?'up':'down',(d>0?'+':'')+(k==='mrr'||k==='latencyP95Ms'?d.toFixed(3):(d*100).toFixed(1)+' pts')))}t.append(b,el('span',null,label));tiles.append(t)}v.append(tiles);
  if(c&&(c.regressions.length||c.improvements.length)){const p=el('div','meta');p.append(c.regressions.length?el('span','down',c.regressions.length+' regressed: '+c.regressions.map(x=>x.id).join(', ')+'. '):'',c.improvements.length?el('span','up',c.improvements.length+' improved: '+c.improvements.map(x=>x.id).join(', ')):'');v.append(p)}
  v.append(...summaryTable('By tag',r.byTag),...summaryTable('By project',r.byProject));
  v.append(el('h3',null,'Cases (click to run the search)'));const t=el('table'),h=el('tr');for(const [x,cl] of [['Rank'],['Case'],['Query'],['Top result'],['ms','num']])h.append(el('th',cl,x));t.append(h);
  for(const x of [...r.cases].sort((a,b)=>(b.rank??99)-(a.rank??99))){const row=el('tr','case');const rk=cell(row,'');rk.append(el('span','rank '+(x.rank===1?'r1':x.rank&&x.rank<=5?'r5':'rx'),x.rank??'miss'));
   cell(row,x.id+(x.tags.length?' ('+x.tags.join(', ')+')':''));cell(row,x.query);cell(row,x.error?'Error: '+x.error:x.top[0]?x.top[0].path+' : '+x.top[0].lines.join('–'):'no results');cell(row,x.latencyMs.toFixed(1),'num');
   row.onclick=()=>{$('#q').value=x.query;$('#proj').value=x.projectId??'';$('#f').requestSubmit()};t.append(row)}
  v.append(t)}
 catch(e){v.replaceChildren(el('div','err',e.message))}}
$('#evalBtn').onclick=evaluate;
$('#tDocs').onclick=()=>{tab='docs';render()};$('#tRes').onclick=()=>{tab='res';render()};
get('/api/overview').then(d=>{data=d;for(const s of d.scopes)if(s.type==='project')$('#proj').append(new Option(s.name+' + shared',s.id));if(d.scopes.some(s=>s.type==='project'))$('#proj').selectedIndex=1;stats();render()}).catch(e=>$('#list').replaceChildren(el('div','err',e.message)));
</script></body></html>`;
