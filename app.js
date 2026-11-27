'use strict';
/* Calculadora com cofre cifrado. 100% offline: nenhuma requisição de rede é feita
   pelo app (CSP connect-src 'none'). Conteúdo cifrado com AES-256-GCM; chave derivada
   da frase-senha com PBKDF2-SHA256 (310 mil iterações). A chave nunca é salva. */

const ITER = 310000;
const PAGE = 15000;
const te = new TextEncoder(), td = new TextDecoder();
const $ = id => document.getElementById(id);

/* ---------- utilidades ---------- */
function b64d(s){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}
// Normaliza a frase: ignora maiúsculas, espaços extras e pontuação (o ditado costuma inserir vírgulas e ponto).
function norm(p){return String(p).normalize('NFKC').toLowerCase().replace(/\p{P}+/gu,' ').replace(/\s+/g,' ').trim();}
function esc(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

/* ---------- criptografia ---------- */
async function derive(pass, salt, iter){
  const base = await crypto.subtle.importKey('raw', te.encode(norm(pass)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', salt, iterations:iter, hash:'SHA-256'},
    base, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
}
async function sealWith(key, salt, iter, kind, obj){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    {name:'AES-GCM', iv, additionalData:te.encode(kind)}, key, te.encode(JSON.stringify(obj))));
  return {v:1, salt, iter, iv, ct};
}
async function seal(pass, kind, obj){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(pass, salt, ITER);
  return {key, rec: await sealWith(key, salt, ITER, kind, obj)};
}
async function unseal(rec, pass, kind){
  try{
    const key = await derive(pass, rec.salt, rec.iter);
    const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv:rec.iv, additionalData:te.encode(kind)}, key, rec.ct);
    return {kind, key, rec, data: JSON.parse(td.decode(pt))};
  }catch(e){ return null; }
}

/* ---------- armazenamento local (IndexedDB) ---------- */
let dbp;
function idb(){
  return dbp ||= new Promise((res,rej)=>{
    const r = indexedDB.open('ast', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn){
  const db = await idb();
  return new Promise((res,rej)=>{
    const t = db.transaction('kv', mode), s = t.objectStore('kv'), r = fn(s);
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
  });
}
const dbGet = k => tx('readonly', s => s.get(k));
const dbPut = (k,v) => tx('readwrite', s => s.put(v,k));
const dbDel = k => tx('readwrite', s => s.delete(k));
async function dbWipe(){
  if(dbp){ (await dbp).close(); dbp = null; }
  await new Promise(r=>{const q=indexedDB.deleteDatabase('ast'); q.onsuccess=q.onerror=q.onblocked=()=>r();});
}

/* ---------- sessão ---------- */
let S = null;          // {kind, key, rec, data}
let pages = [], pi = 0, term = '';

function show(id){
  for(const x of ['game','reader','setup','notes']) $(x).hidden = (x !== id);
  window.scrollTo(0,0);
}
function lock(){
  S = null; pages = []; term = ''; pageCache.clear();
  $('text').textContent=''; $('results').textContent=''; $('book').textContent=''; $('ver').textContent='';
  $('noteTx').value=''; $('q').value=''; $('msg').textContent='';
  for(const id of ['s1','s2','s3','np1','np2','dp','paste','nameIn','ref']) $(id).value='';
  $('name').hidden = true; $('cfg').open = false;
  $('player').textContent = '👤 Jogador'; for(const k in keys) keys[k]=false; if(state==='play') paused = true; show('game'); resize();
}

async function unlock(pass){
  if(!norm(pass)) return false;
  const [vault, decoy, cfg] = await Promise.all([dbGet('vault'), dbGet('decoy'), dbGet('cfg')]);
  const tries = [];
  if(vault) tries.push(unseal(vault, pass, 'vault'));
  if(decoy) tries.push(unseal(decoy, pass, 'decoy'));
  if(!(cfg && cfg.sampleOff) && window.SAMPLE){
    const s = window.SAMPLE;
    tries.push(unseal({salt:b64d(s.salt), iter:s.iter, iv:b64d(s.iv), ct:b64d(s.ct)}, pass, 'sample'));
  }
  const hit = (await Promise.all(tries)).find(Boolean);
  if(hit){ enter(hit); return true; }
  if(!vault && norm(pass) === '1234'){ setupBooks = []; show('setup'); return true; }
  return false;   // falha silenciosa: continua sendo só uma calculadora
}

function enter(h){
  S = h;
  if(h.kind === 'decoy'){ $('noteTx').value = h.data.text || ''; show('notes'); return; }
  $('banner').hidden = h.kind !== 'sample';
  $('cfg').hidden = h.kind === 'sample';
  if(h.kind === 'vault' && fixNames(h.data)) saveVault();
  fillBooks(0); show('reader');
}
async function saveVault(){
  S.rec = await sealWith(S.key, S.rec.salt, S.rec.iter, 'vault', S.data);
  await dbPut('vault', S.rec);
}
function say(t){ $('msg').textContent = t; setTimeout(()=>{ if($('msg').textContent===t) $('msg').textContent=''; }, 4000); }

/* ---------- leitor ---------- */
// Livros vindos de Bíblias completas têm os capítulos separados por \f (uma página por capítulo).
// Tradução = parte antes de " · " no título (ex.: "BLIVRE · João"). Livros sem isso ficam em "Outros".
const verOf = b => b.t.includes(' · ') ? b.t.split(' · ')[0] : '';
const nameOf = b => b.t.includes(' · ') ? b.t.split(' · ').slice(1).join(' · ') : b.t;
function fillBooks(sel){
  $('book').textContent=''; $('ver').textContent='';
  if(!S.data.books.length){ $('text').textContent='(vazio — use Ajustes para importar textos)'; $('pg').textContent=''; return; }
  const seen = new Map();
  S.data.books.forEach(b=>{ const v=verOf(b); if(!seen.has(v)) seen.set(v, b.l); });
  for(const [v,l] of seen){
    const o=document.createElement('option'); o.value=v;
    o.textContent = (v || 'Outros') + (l ? ` [${l.toUpperCase()}]` : ''); $('ver').appendChild(o);
  }
  selectBook(Math.min(sel, S.data.books.length-1));
}
// Mostra no menu só os livros da tradução escolhida e seleciona o livro i.
function selectBook(i, page=0){
  const v = verOf(S.data.books[i]); $('ver').value = v;
  const b = $('book'); b.textContent='';
  S.data.books.forEach((bk,k)=>{ if(verOf(bk)!==v) return;
    const o=document.createElement('option'); o.value=k; o.textContent=nameOf(bk); b.appendChild(o); });
  b.value = i; openBook(page);
}
// Troca de tradução mantendo o mesmo livro e capítulo, se existirem.
function changeVer(){
  const v = $('ver').value, cur = S.data.books[+$('book').value];
  const same = S.data.books.findIndex(b=>verOf(b)===v && cur && nameOf(b)===nameOf(cur));
  const first = S.data.books.findIndex(b=>verOf(b)===v);
  selectBook(same>=0 ? same : first, same>=0 ? pi : 0);
}
function paginate(x){
  if(x.includes('\f')) return x.split('\f');
  const out=[]; let i=0;
  while(i < x.length){
    let end = Math.min(i+PAGE, x.length);
    if(end < x.length){ const nl = x.lastIndexOf('\n', end); if(nl > i+PAGE/2) end = nl+1; }
    out.push(x.slice(i,end)); i = end;
  }
  return out.length ? out : [''];
}
const pageCache = new Map();
function pagesOf(i){
  const bk = S.data.books[i];
  if(!pageCache.has(bk)) pageCache.set(bk, paginate(bk.x));
  return pageCache.get(bk);
}
function openBook(p=0){
  const i = +$('book').value; if(!S.data.books[i]) return;
  pages = pagesOf(i);
  const chap = S.data.books[i].x.includes('\f');
  const sel = $('pg'); sel.textContent='';
  pages.forEach((_,k)=>{ const o=document.createElement('option'); o.value=k; o.textContent=(chap?'Cap. ':'p. ')+(k+1)+' / '+pages.length; sel.appendChild(o); });
  render(p);
}
function render(n, verse){
  pi = Math.max(0, Math.min(n, pages.length-1));
  let h = esc(pages[pi]);
  if(verse) h = h.replace(new RegExp('^('+verse+' .*)$','m'), '<mark class="v">$1</mark>');
  if(term){
    const re = new RegExp(esc(term).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi');
    h = h.replace(re, m=>`<mark>${m}</mark>`);
  }
  $('text').innerHTML = h;   // conteúdo já escapado
  $('pg').value = pi;
  const m = $('text').querySelector('mark.v') || $('text').querySelector('mark');
  if(m) m.scrollIntoView({block:'center'}); else window.scrollTo(0,0);
}
// Busca em todos os livros do cofre.
function search(){
  const q = $('q').value.trim(); const r = $('results'); r.textContent='';
  term = q.length >= 2 ? q : '';
  if(!term){ render(pi); return; }
  const ql = term.toLowerCase(); let n=0;
  for(let b=0; b<S.data.books.length && n<80; b++){
    const bk = S.data.books[b], ps = pagesOf(b), chap = bk.x.includes('\f');
    for(let p=0; p<ps.length && n<80; p++){
      const low = ps[p].toLowerCase(); let i = low.indexOf(ql);
      while(i !== -1 && n < 80){
        const d=document.createElement('div');
        d.textContent = `${bk.t} ${chap?p+1:'p.'+(p+1)}: …${ps[p].slice(Math.max(0,i-40), i+ql.length+40).replace(/\s+/g,' ')}…`;
        d.addEventListener('click', ()=>selectBook(b, p));
        r.appendChild(d); n++; i = low.indexOf(ql, i+ql.length);
      }
    }
  }
  if(!n) r.textContent = 'Nada encontrado.';
  else say(n + (n>=80?'+':'') + ' resultado(s) — toque num deles para abrir.');
}

/* ---------- Ir para referência: "Jo 3:16", "joão 3 16", "1co 13" ---------- */
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,'');
const ABBR = {gn:'genesis',ex:'exodo',lv:'levitico',nm:'numeros',dt:'deuteronomio',js:'josue',jz:'juizes',rt:'rute',
'1sm':'1samuel','2sm':'2samuel','1rs':'1reis','2rs':'2reis','1cr':'1cronicas','2cr':'2cronicas',ed:'esdras',ne:'neemias',
et:'ester',jo:'joao',job:'jo',sl:'salmos',pv:'proverbios',ec:'eclesiastes',ct:'canticos',is:'isaias',jr:'jeremias',
lm:'lamentacoes',ez:'ezequiel',dn:'daniel',os:'oseias',jl:'joel',am:'amos',ob:'obadias',jn:'jonas',mq:'miqueias',na:'naum',
hc:'habacuque',sf:'sofonias',ag:'ageu',zc:'zacarias',ml:'malaquias',mt:'mateus',mc:'marcos',lc:'lucas',at:'atos',rm:'romanos',
'1co':'1corintios','2co':'2corintios',gl:'galatas',ef:'efesios',fp:'filipenses',cl:'colossenses','1ts':'1tessalonicenses',
'2ts':'2tessalonicenses','1tm':'1timoteo','2tm':'2timoteo',tt:'tito',fm:'filemom',hb:'hebreus',tg:'tiago','1pe':'1pedro',
'2pe':'2pedro','1jo':'1joao','2jo':'2joao','3jo':'3joao',jd:'judas',ap:'apocalipse'};
function goRef(q){
  if(!q || !q.trim()) return;
  const m = /^\s*(.+?)\s*(\d+)(?:\s*[:.,\s]\s*(\d+))?\s*$/.exec(q);
  if(!m) return say('Use o formato: Jo 3:16');
  let want = fold(m[1]); want = /^j[óò]$/i.test(m[1].trim()) ? 'jo' : (ABBR[want] || want);   // "Jó" com acento = livro de Jó
  const cur = S.data.books[+$('book').value], pre = cur && cur.t.includes(' · ') ? cur.t.split(' · ')[0] : null;
  const names = S.data.books.map(b=>fold(b.t.includes(' · ') ? b.t.split(' · ').slice(1).join(' · ') : b.t));
  const pick = arr => arr.find(i=>pre && S.data.books[i].t.startsWith(pre+' · ')) ?? arr[0];
  const idx = names.map((_,i)=>i);
  let i = pick(idx.filter(k=>names[k]===want));
  if(i === undefined) i = pick(idx.filter(k=>names[k].startsWith(want)));
  if(i === undefined) return say('Livro não encontrado.');
  term=''; $('results').textContent='';
  selectBook(i, +m[2]-1); if(m[3]) render(+m[2]-1, +m[3]);
  $('ref').value=''; $('ref').blur();
}

/* ---------- Bíblias completas no formato VPL do eBible.org ("GEN 1:1 texto") ---------- */
const BOOKS = {GEN:'Gênesis',EXO:'Êxodo',LEV:'Levítico',NUM:'Números',DEU:'Deuteronômio',JOS:'Josué',JDG:'Juízes',RUT:'Rute',
'1SA':'1 Samuel','2SA':'2 Samuel','1KI':'1 Reis','2KI':'2 Reis','1CH':'1 Crônicas','2CH':'2 Crônicas',EZR:'Esdras',NEH:'Neemias',
EST:'Ester',JOB:'Jó',PSA:'Salmos',PRO:'Provérbios',ECC:'Eclesiastes',SNG:'Cânticos',ISA:'Isaías',JER:'Jeremias',LAM:'Lamentações',
EZK:'Ezequiel',DAN:'Daniel',HOS:'Oseias',JOL:'Joel',AMO:'Amós',OBA:'Obadias',JON:'Jonas',MIC:'Miqueias',NAM:'Naum',HAB:'Habacuque',
ZEP:'Sofonias',HAG:'Ageu',ZEC:'Zacarias',MAL:'Malaquias',MAT:'Mateus',MRK:'Marcos',LUK:'Lucas',JHN:'João',ACT:'Atos',ROM:'Romanos',
'1CO':'1 Coríntios','2CO':'2 Coríntios',GAL:'Gálatas',EPH:'Efésios',PHP:'Filipenses',COL:'Colossenses','1TH':'1 Tessalonicenses',
'2TH':'2 Tessalonicenses','1TI':'1 Timóteo','2TI':'2 Timóteo',TIT:'Tito',PHM:'Filemom',HEB:'Hebreus',JAS:'Tiago','1PE':'1 Pedro',
'2PE':'2 Pedro','1JN':'1 João','2JN':'2 João','3JN':'3 João',JUD:'Judas',REV:'Apocalipse',
// abreviações do BibleWorks, usadas no arquivo _vpl.txt do eBible
SOL:'Cânticos',EZE:'Ezequiel',JOE:'Joel',NAH:'Naum',MAR:'Marcos',JOH:'João',PHI:'Filipenses',JAM:'Tiago',
'1JO':'1 João','2JO':'2 João','3JO':'3 João'};
// Corrige livros importados antes com o código no lugar do nome (ex.: "BLIVRE · JOH").
function fixNames(data){
  let changed = false;
  for(const b of data.books){
    const parts = b.t.split(' · '), code = parts[parts.length-1];
    if(/^[1-4A-Z]{3}$/.test(code) && BOOKS[code]){
      parts[parts.length-1] = BOOKS[code]; b.t = parts.join(' · ');
      b.x = b.x.split('\f').map(c=>c.startsWith(code+' ') ? BOOKS[code]+c.slice(code.length) : c).join('\f');
      changed = true;
    }
  }
  return changed;
}
const VPL = /^([1-4A-Z]{3}) (\d+):(\d+)\s?(.*)$/;
function isVPL(txt){
  const ls = txt.replace(/^﻿/,'').split(/\r?\n/).filter(l=>l.trim()).slice(0,20);
  return ls.length >= 5 && ls.filter(l=>VPL.test(l)).length >= ls.length*0.8;
}
function parseVPL(txt, lang, prefix){
  const order=[], map=new Map();
  for(const line of txt.replace(/^﻿/,'').split(/\r?\n/)){
    const m = VPL.exec(line.trim()); if(!m) continue;
    const [,code,c,v,t] = m;
    if(!map.has(code)){ map.set(code, new Map()); order.push(code); }
    const ch = map.get(code); if(!ch.has(c)) ch.set(c, []);
    ch.get(c).push(`${v} ${t}`);
  }
  return order.map(code=>{
    const name = BOOKS[code] || code;
    const chs = [...map.get(code)].map(([c,vs])=>`${name} ${c}\n\n${vs.join('\n')}`);
    return {t:(prefix?prefix+' · ':'')+name, l:lang, x:chs.join('\f')};
  });
}

/* ---------- ações do leitor ---------- */
$('book').addEventListener('change', ()=>openBook(0));
$('ver').addEventListener('change', changeVer);
// O iPhone nem sempre envia "Enter" ao campo; por isso há botão, tecla e evento 'change'.
function onSubmit(id, fn){
  const el = $(id);
  el.addEventListener('keydown', e=>{ if(e.key==='Enter' || e.keyCode===13){ e.preventDefault(); fn(); el.blur(); }});
  el.addEventListener('change', ()=>{ if(el.value.trim()) fn(); });
}
onSubmit('ref', ()=>{ if($('ref').value.trim()) goRef($('ref').value); });
onSubmit('q', search);
$('goRef').addEventListener('click', ()=>goRef($('ref').value));
$('goQ').addEventListener('click', search);
$('pg').addEventListener('change', ()=>render(+$('pg').value));
$('prev').addEventListener('click', ()=>render(pi-1));
$('next').addEventListener('click', ()=>render(pi+1));

$('close').addEventListener('click', lock);
$('mkVault').addEventListener('click', ()=>{ setupBooks = S.data.books.slice(); show('setup'); });

$('doImport').addEventListener('click', async ()=>{
  const fs = [...$('files').files].sort((a,b)=>a.name.localeCompare(b.name, undefined, {numeric:true}));
  if(!fs.length) return say('Escolha arquivos primeiro.');
  const lang = $('impLang').value.trim(), title = $('impTitle').value.trim();
  const texts = await Promise.all(fs.map(f=>f.text()));
  const first = S.data.books.length;
  const vpl = texts.map(isVPL);
  texts.forEach((t,i)=>{ if(vpl[i]) S.data.books.push(...parseVPL(t, lang, title)); });
  const rest = fs.filter((_,i)=>!vpl[i]), restT = texts.filter((_,i)=>!vpl[i]);
  if(!rest.length){ await saveVault(); $('files').value=''; fillBooks(first); return say('Bíblia importada e cifrada.'); }
  fs.length = 0; fs.push(...rest); texts.length = 0; texts.push(...restT);
  if($('merge').checked){
    S.data.books.push({t: title || fs[0].name.replace(/\.txt$/i,''), l:lang,
      x: texts.map((t,i)=>`— ${fs[i].name.replace(/\.txt$/i,'')} —\n${t.trim()}\n`).join('\n')});
  }else{
    fs.forEach((f,i)=>S.data.books.push({t:(fs.length===1 && title) || f.name.replace(/\.txt$/i,''), l:lang, x:texts[i]}));
  }
  await saveVault(); $('files').value=''; fillBooks(S.data.books.length-1); say('Importado e cifrado.');
});
$('doPaste').addEventListener('click', async ()=>{
  const x = $('paste').value; if(!x.trim()) return;
  S.data.books.push({t: $('impTitle').value.trim() || 'Texto', l: $('impLang').value.trim(), x});
  await saveVault(); $('paste').value=''; fillBooks(S.data.books.length-1); say('Adicionado.');
});
$('doRename').addEventListener('click', async ()=>{
  const i=+$('book').value, t=$('renTitle').value.trim(); if(!t || !S.data.books[i]) return;
  const v = verOf(S.data.books[i]); S.data.books[i].t = v ? v+' · '+t : t; await saveVault(); $('renTitle').value=''; fillBooks(i); say('Renomeado.');
});
$('doDelBook').addEventListener('click', async ()=>{
  const i=+$('book').value; if(!S.data.books[i]) return;
  if(!confirmTwice('doDelBook')) return say('Toque de novo para confirmar.');
  S.data.books.splice(i,1); await saveVault(); fillBooks(0); say('Removido.');
});
$('doPass').addEventListener('click', async ()=>{
  const a=$('np1').value, b=$('np2').value;
  const err = checkPass(a,b); if(err) return say(err);
  const decoy = await dbGet('decoy');
  if(decoy && await unseal(decoy, a, 'decoy')) return say('Não pode ser igual à senha de coação.');
  const {key, rec} = await seal(a, 'vault', S.data);
  await dbPut('vault', rec); S.key=key; S.rec=rec; $('np1').value=$('np2').value=''; say('Senha trocada.');
});
$('doDecoy').addEventListener('click', async ()=>{
  const p=$('dp').value; if(norm(p).length<4) return say('Frase de coação muito curta.');
  if(await unseal(S.rec, p, 'vault')) return say('Não pode ser igual à senha principal.');
  const {rec} = await seal(p, 'decoy', {text:$('dtx').value});
  await dbPut('decoy', rec); $('dp').value=''; say('Coação salva.');
});
$('doWipe').addEventListener('click', async ()=>{
  if(!confirmTwice('doWipe')) return say('Toque de novo para apagar tudo.');
  await dbWipe(); await dbPut('cfg', {sampleOff:true}); lock();
});
let armed = null;
function confirmTwice(id){ if(armed===id){ armed=null; return true; } armed=id; setTimeout(()=>{ if(armed===id) armed=null; }, 3000); return false; }

/* ---------- notas falsas ---------- */
$('noteSave').addEventListener('click', async ()=>{
  const rec = await sealWith(S.key, S.rec.salt, S.rec.iter, 'decoy', {text:$('noteTx').value});
  await dbPut('decoy', rec); S.rec = rec;
});
$('noteClose').addEventListener('click', lock);

/* ---------- configuração inicial ---------- */
let setupBooks = [];
function checkPass(a,b){
  const n = norm(a);
  if(n !== norm(b)) return 'As frases não conferem.';
  if(/^\d+$/.test(n) ? n.length < 10 : n.length < 12) return 'Muito curta: use 12+ caracteres, ou 10+ dígitos (ideal 12+).';
  if(window.SAMPLE && n === window.SAMPLE.hintCode) return 'Não use o código de teste.';
  return '';
}
$('doSetup').addEventListener('click', async ()=>{
  const err = checkPass($('s1').value, $('s2').value); if(err){ $('smsg').textContent = err; return; }
  const dp = $('s3').value;
  if(dp && norm(dp) === norm($('s1').value)){ $('smsg').textContent='A coação deve ser diferente.'; return; }
  $('smsg').textContent = 'Cifrando…';
  const data = {books: setupBooks};
  const {key, rec} = await seal($('s1').value, 'vault', data);
  await dbPut('vault', rec);
  if(dp && norm(dp).length >= 4){ const d = await seal(dp, 'decoy', {text:$('dtx').value}); await dbPut('decoy', d.rec); }
  await dbPut('cfg', {sampleOff:true});        // desativa o exemplo depois que o cofre existe
  try{ await navigator.storage?.persist?.(); }catch(e){}
  $('smsg').textContent=''; enter({kind:'vault', key, rec, data});
});
$('cancelSetup').addEventListener('click', lock);

/* ---------- jogo Asteroides (fachada funcional) ---------- */
// O cofre abre quando a senha é digitada como "nome do jogador". Qualquer outro nome só aparece no placar.
const cv = $('cv'), cx = cv.getContext('2d');
let W=0, H=0, DPR=1;
function resize(){
  const r = cv.getBoundingClientRect(); DPR = window.devicePixelRatio || 1;
  W = r.width; H = r.height; cv.width = W*DPR; cv.height = H*DPR; cx.setTransform(DPR,0,0,DPR,0,0);
}
window.addEventListener('resize', resize);

const keys = {left:false, right:false, thrust:false, fire:false};
let ship, rocks, shots, parts, score=0, lives=3, level=0, state='start', banner=0, fireCd=0, nextLife=10000, paused=false;
function bestGet(){ try{ return +localStorage.getItem('ast-best') || 0; }catch(e){ return 0; } }
function bestSet(v){ try{ localStorage.setItem('ast-best', v); }catch(e){} }

function newShip(){ return {x:W/2, y:H/2, a:-Math.PI/2, vx:0, vy:0, r:12, inv:2.5}; }
function makeRock(x, y, size, speed){
  const n = 9 + Math.floor(Math.random()*4), pts = [];
  for(let i=0;i<n;i++) pts.push(0.72 + Math.random()*0.38);
  const ang = Math.random()*Math.PI*2, sp = speed*(0.6+Math.random()*0.8);
  return {x, y, size, r:[0,13,24,42][size], vx:Math.cos(ang)*sp, vy:Math.sin(ang)*sp, rot:(Math.random()-0.5)*1.2, a:0, pts};
}
function startLevel(){
  level++; rocks = []; shots = [];
  const n = Math.min(2 + level, 11), speed = 38 + level*7;
  for(let i=0;i<n;i++){
    let x, y; do { x = Math.random()*W; y = Math.random()*H; } while(Math.hypot(x-ship.x, y-ship.y) < 150);
    rocks.push(makeRock(x, y, 3, speed));
  }
  banner = 1.6; ship.inv = Math.max(ship.inv, 1.6);
}
function newGame(){
  resize(); score=0; lives=3; level=0; nextLife=10000; parts=[]; ship=newShip(); state='play'; paused=false;
  startLevel();
}
function boom(x, y, n, color){
  for(let i=0;i<n;i++){ const a=Math.random()*Math.PI*2, s=30+Math.random()*120;
    parts.push({x, y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, t:0.4+Math.random()*0.5, c:color}); }
}
const wrap = o => { if(o.x<-o.r) o.x+=W+2*o.r; if(o.x>W+o.r) o.x-=W+2*o.r; if(o.y<-o.r) o.y+=H+2*o.r; if(o.y>H+o.r) o.y-=H+2*o.r; };

function hitRock(i){
  const r = rocks[i]; rocks.splice(i,1);
  score += [0,100,50,20][r.size]; boom(r.x, r.y, 6+r.size*3, '#bbb');
  if(r.size > 1) for(let k=0;k<2;k++){ const n = makeRock(r.x, r.y, r.size-1, 45+level*8); rocks.push(n); }
  if(score >= nextLife){ lives++; nextLife += 10000; }
  if(score > bestGet()) bestSet(score);
}
function step(dt){
  if(banner > 0) banner -= dt;
  for(const p of parts){ p.x+=p.vx*dt; p.y+=p.vy*dt; p.t-=dt; } parts = parts.filter(p=>p.t>0);
  for(const r of rocks){ r.x+=r.vx*dt; r.y+=r.vy*dt; r.a+=r.rot*dt; wrap(r); }
  if(state !== 'play') return;
  // nave
  if(keys.left) ship.a -= 4.2*dt;
  if(keys.right) ship.a += 4.2*dt;
  if(keys.thrust){ ship.vx += Math.cos(ship.a)*260*dt; ship.vy += Math.sin(ship.a)*260*dt; }
  const sp = Math.hypot(ship.vx, ship.vy); if(sp > 330){ ship.vx*=330/sp; ship.vy*=330/sp; }
  ship.vx *= Math.pow(0.55, dt); ship.vy *= Math.pow(0.55, dt);
  ship.x += ship.vx*dt; ship.y += ship.vy*dt; wrap(ship);
  if(ship.inv > 0) ship.inv -= dt;
  // tiros (segurar = tiro automático)
  fireCd -= dt;
  if(keys.fire && fireCd <= 0 && shots.length < 8){
    shots.push({x:ship.x+Math.cos(ship.a)*14, y:ship.y+Math.sin(ship.a)*14, vx:ship.vx+Math.cos(ship.a)*480, vy:ship.vy+Math.sin(ship.a)*480, t:0.9, r:2});
    fireCd = 0.18;
  }
  for(const s of shots){ s.x+=s.vx*dt; s.y+=s.vy*dt; s.t-=dt; wrap(s); }
  shots = shots.filter(s=>s.t>0);
  // colisões
  for(let i=rocks.length-1;i>=0;i--){
    const r = rocks[i];
    const si = shots.findIndex(s=>Math.hypot(s.x-r.x, s.y-r.y) < r.r);
    if(si >= 0){ shots.splice(si,1); hitRock(i); continue; }
    if(ship.inv <= 0 && Math.hypot(ship.x-r.x, ship.y-r.y) < r.r + ship.r*0.8){
      boom(ship.x, ship.y, 24, '#ffcf5a'); hitRock(i); lives--;
      if(lives <= 0){ state = 'over'; setTimeout(()=>openName(true), 900); return; }
      ship = newShip(); ship.inv = 2.5;
    }
  }
  if(!rocks.length) startLevel();
}
function drawGame(){
  cx.fillStyle = '#05060a'; cx.fillRect(0,0,W,H);
  cx.lineWidth = 1.6; cx.lineJoin = 'round';
  // asteroides
  cx.strokeStyle = '#cfd3dc';
  for(const r of (rocks||[])){
    cx.beginPath();
    r.pts.forEach((k,i)=>{ const a = r.a + i/r.pts.length*Math.PI*2, x = r.x+Math.cos(a)*r.r*k, y = r.y+Math.sin(a)*r.r*k; i?cx.lineTo(x,y):cx.moveTo(x,y); });
    cx.closePath(); cx.stroke();
  }
  // partículas e tiros
  for(const p of (parts||[])){ cx.fillStyle = p.c; cx.globalAlpha = Math.min(1,p.t*2); cx.fillRect(p.x-1,p.y-1,2.5,2.5); }
  cx.globalAlpha = 1; cx.fillStyle = '#fff';
  for(const s of (shots||[])){ cx.beginPath(); cx.arc(s.x,s.y,2,0,Math.PI*2); cx.fill(); }
  // nave
  if(state==='play' && ship && !(ship.inv>0 && Math.floor(ship.inv*8)%2)){
    cx.save(); cx.translate(ship.x, ship.y); cx.rotate(ship.a);
    cx.strokeStyle = '#8fd3ff'; cx.beginPath(); cx.moveTo(16,0); cx.lineTo(-11,-10); cx.lineTo(-6,0); cx.lineTo(-11,10); cx.closePath(); cx.stroke();
    if(keys.thrust && Math.random()>0.3){ cx.strokeStyle='#ffb347'; cx.beginPath(); cx.moveTo(-8,-5); cx.lineTo(-18-Math.random()*6,0); cx.lineTo(-8,5); cx.stroke(); }
    cx.restore();
  }
  // placar
  cx.fillStyle = '#e8e8e8'; cx.font = '600 16px -apple-system,system-ui,sans-serif'; cx.textAlign = 'left';
  cx.fillText(`${score}`, 12, 24);
  cx.textAlign = 'center'; cx.fillText(level ? `FASE ${level}` : '', W/2, 24);
  cx.textAlign = 'right'; cx.fillText('▲'.repeat(Math.max(0,Math.min(lives,6))), W-12, 24);
  cx.fillStyle = '#888'; cx.font = '12px -apple-system,system-ui,sans-serif'; cx.fillText(`RECORDE ${bestGet()}`, W-12, 42);
  cx.textAlign = 'center';
  const mid = (t, size=26, y=H/2) => { cx.fillStyle='#fff'; cx.font = `700 ${size}px -apple-system,system-ui,sans-serif`; cx.fillText(t, W/2, y); };
  if(state==='start'){ mid('ASTEROIDES', 34, H/2-20); mid('Toque para começar', 16, H/2+16); }
  else if(state==='over'){ mid('FIM DE JOGO', 30); }
  else if(paused){ mid('PAUSADO', 28, H/2-10); mid('Toque para continuar', 15, H/2+20); }
  else if(banner > 0){ mid(`FASE ${level}`, 30); }
}
let last = 0;
function loop(t){
  const dt = Math.min(0.033, (t-last)/1000 || 0); last = t;
  if(!paused && $('name').hidden && !$('game').hidden) step(dt);
  if(!$('game').hidden) drawGame();
  requestAnimationFrame(loop);
}
cv.addEventListener('pointerdown', ()=>{
  if(state==='start' || state==='over'){ if($('name').hidden) newGame(); }
  else if(paused) paused = false;
});
$('pause').addEventListener('click', ()=>{ if(state==='play') paused = !paused; });
// controles de toque (vários dedos ao mesmo tempo)
for(const b of document.querySelectorAll('#pad button')){
  const k = b.dataset.k;
  const on = e=>{ e.preventDefault(); keys[k]=true; if(state==='start'||state==='over') { if($('name').hidden) newGame(); } else paused=false; };
  const off = e=>{ e.preventDefault(); keys[k]=false; };
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
  b.addEventListener('contextmenu', e=>e.preventDefault());
}
const KMAP = {ArrowLeft:'left', ArrowRight:'right', ArrowUp:'thrust', ' ':'fire'};
document.addEventListener('keydown', e=>{ if(!$('name').hidden || $('game').hidden) return; const k=KMAP[e.key]; if(k){ e.preventDefault(); keys[k]=true; if(state!=='play') newGame(); }});
document.addEventListener('keyup', e=>{ const k=KMAP[e.key]; if(k) keys[k]=false; });

// Janela "Nome do jogador": abre pelo botão Jogador ou no fim de jogo.
let playerName = '';
function openName(gameOver){
  for(const k in keys) keys[k]=false;
  if(state==='play') paused = true;
  $('nameTitle').textContent = gameOver ? `Fim de jogo! ${score} pontos — seu nome:` : 'Jogador';
  $('nameIn').value=''; $('name').hidden=false;
}
function closeName(){ $('name').hidden=true; $('nameIn').value=''; $('nameIn').blur(); }
$('player').addEventListener('click', ()=>{ openName(false); $('nameIn').focus(); });
async function submitName(){
  const v = $('nameIn').value; closeName();
  if(!v.trim()) return;
  if(await unlock(v)) return;
  playerName = v.trim().slice(0,16); $('player').textContent = '👤 ' + playerName;   // só na memória
}
$('nameOk').addEventListener('click', submitName);
$('nameIn').addEventListener('keydown', e=>{ if(e.key==='Enter' || e.keyCode===13){ e.preventDefault(); submitName(); }});
$('nameCancel').addEventListener('click', closeName);

/* ---------- trava automática ---------- */
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) lock(); });
window.addEventListener('pagehide', lock);

/* ---------- offline ---------- */
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').then(r=>r.update()).catch(()=>{});
  // Quando chega uma versão nova, recarrega na hora (só se o cofre estiver fechado).
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{ if(!reloaded && !S){ reloaded = true; location.reload(); } });
}
resize(); ship = newShip(); rocks = []; for(let i=0;i<5;i++) rocks.push(makeRock(Math.random()*W, Math.random()*H, 1+Math.floor(Math.random()*3), 30));
shots=[]; parts=[]; requestAnimationFrame(loop);
