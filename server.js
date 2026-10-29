'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Dependency-free HTTP event transport. The server owns the game state; clients poll
// for events every 350ms, so separate devices stay synchronized without a third-party service.
const socketMap = new Map();
const connectionHandlers = [];
const io = {
  sockets: { sockets: socketMap },
  on(event, handler) { if (event === 'connection') connectionHandlers.push(handler); },
  to(socketId) { return { emit: (event, data) => socketMap.get(socketId)?._push(event, data) }; }
};
function makeVirtualSocket() {
  const socket = { id: crypto.randomBytes(12).toString('hex'), data: {}, connected: true, _queue: [], _handlers: {}, _lastSeen: Date.now(),
    on(event, handler) { (this._handlers[event] ||= []).push(handler); },
    emit(event, data) { this._push(event, data); },
    _push(event, data) { if (this.connected) this._queue.push({ event, data }); },
    _dispatch(event, data) { for (const fn of this._handlers[event] || []) { try { fn(data); } catch (e) { console.error('Socket handler error:', event, e); this._push('notice', {type:'error', message:'A server error occurred while processing that action.'}); } } },
    disconnect() { if (!this.connected) return; this.connected=false; this._dispatch('disconnect'); socketMap.delete(this.id); }
  };
  return socket;
}
function sendJson(res, status, data) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(data)); }
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const server = http.createServer((req,res)=>{
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); return res.end(); }
  if (url.pathname === '/health') return sendJson(res,200,{ok:true,game:'SHADOW MARKET'});
  if (req.method === 'POST' && ['/api/connect','/api/emit','/api/disconnect'].includes(url.pathname)) {
    let raw=''; req.on('data',chunk=>{raw+=chunk;if(raw.length>1000000){req.destroy();}}); req.on('end',()=>{let body={};try{body=raw?JSON.parse(raw):{};}catch{return sendJson(res,400,{error:'Invalid JSON'});}
      if(url.pathname==='/api/connect') { const socket=makeVirtualSocket(); socketMap.set(socket.id,socket); for(const fn of connectionHandlers) fn(socket); return sendJson(res,200,{socketId:socket.id}); }
      const socket=socketMap.get(String(body.socketId||'')); if(!socket)return sendJson(res,410,{error:'Connection expired'}); socket._lastSeen=Date.now();
      if(url.pathname==='/api/emit') { if(typeof body.event!=='string')return sendJson(res,400,{error:'Missing event'}); socket._dispatch(body.event,body.data); return sendJson(res,200,{ok:true}); }
      socket.disconnect(); return sendJson(res,200,{ok:true});
    }); return;
  }
  if(req.method==='GET' && url.pathname==='/api/poll') { const socket=socketMap.get(String(url.searchParams.get('socketId')||'')); if(!socket)return sendJson(res,410,{error:'Connection expired'}); socket._lastSeen=Date.now(); const messages=socket._queue.splice(0,250); return sendJson(res,200,{messages,serverNow:Date.now()}); }
  let requestPath=url.pathname==='/socket.io/socket.io.js'?'/socket.io-client.js':decodeURIComponent(url.pathname);
  if(requestPath==='/')requestPath='/index.html';
  const file=path.resolve(__dirname,'public',`.${requestPath}`);
  if(!file.startsWith(path.resolve(__dirname,'public')+path.sep))return sendJson(res,403,{error:'Forbidden'});
  fs.readFile(file,(err,content)=>{if(err){if(requestPath!=='/index.html'){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('Not found');}return fs.readFile(path.join(__dirname,'public','index.html'),(e,b)=>{if(e){res.writeHead(500);return res.end('Server error');}res.writeHead(200,{'Content-Type':MIME['.html']});res.end(b);});}res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':path.extname(file)==='.html'?'no-cache':'public, max-age=300'});res.end(content);});
});

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ASSETS = ['ember', 'tide', 'vault'];
const ASSET_NAMES = { ember: 'Ember', tide: 'Tide', vault: 'Vault' };
const SIGNALS = [
  { name: 'Strong bullish', movement: 20 }, { name: 'Bullish', movement: 10 },
  { name: 'Neutral', movement: 0 }, { name: 'Bearish', movement: -10 },
  { name: 'Strong bearish', movement: -20 }
];
const EVENTS = [
  { name: 'Market Frenzy', description: 'Ember receives a +10 percentage-point boost.', modifiers: { ember: 10 } },
  { name: 'Flight to Safety', description: 'Vault gains +10 points; Ember loses 10 points.', modifiers: { vault: 10, ember: -10 } },
  { name: 'Liquidity Crunch', description: 'Every negative market return worsens by 5 percentage points.', negativePenalty: 5 },
  { name: 'Insider Rumor', description: 'Each player gets a private clue about one asset.', privateClue: true }
];
const ABILITIES = {
  guardian: { name: 'Guardian', description: 'Pay 5 coins to protect one extra asset by 10 points against market loss.' },
  phantom: { name: 'Phantom', description: 'Pay 5 extra coins to strengthen one sabotage operation by 10 points or raise theft to 10 coins.' },
  oracle: { name: 'Oracle', description: 'Once per match, see the exact movement for one asset before locking. No cost.' },
  diplomat: { name: 'Diplomat', description: 'Once per match, propose a pact: if accepted and neither player attacks the other, both gain 5 coins.' },
  tycoon: { name: 'Tycoon', description: 'Gain 10 coins before planning. No cost.' },
  sentinel: { name: 'Sentinel', description: 'Pay 5 coins to block one incoming Asset Theft this round.' }
};
const ROUND_MS = 65000;
const PLANNING_MS = 20000;
const NEGOTIATION_MS = 15000;

function id() { return crypto.randomBytes(12).toString('hex'); }
function randInt(n) { return crypto.randomInt(0, n); }
function makeCode() { let c; do { c = Array.from({length:6}, () => CODE_CHARS[randInt(CODE_CHARS.length)]).join(''); } while (rooms.has(c)); return c; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function safeName(n) { return String(n || 'Trader').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18) || 'Trader'; }
function roundDown(n) { return Math.floor(n); }
function roomOf(socket) { const code = socket.data.roomCode; return code ? rooms.get(code) : null; }
function playerOf(room, pid) { return room?.players.get(pid); }
function totalCoins(room) { return [...room.players.values()].reduce((s,p) => s + p.coins, 0); }
function log(room, message, kind='info') { room.feed.unshift({ id: id(), message, kind, at: Date.now() }); room.feed = room.feed.slice(0, 40); }
function playerPublic(p, viewerId, room) {
  const isSelf = p.id === viewerId;
  return { id:p.id, name:p.name, coins:p.coins, connected:p.connected, ready:p.ready, host:p.id===room.hostId,
    ability:p.ability, abilityUsed:p.abilityUsed, reputation:p.reputation,
    allianceWith:p.allianceWith || null, submitted: !!p.submission,
    isSelf, investments: room.phase==='results' || room.phase==='finished' || isSelf ? (p.lastInvestments || null) : null };
}
function publicState(room, viewerId) {
  const viewer = playerOf(room, viewerId);
  const submissions = {};
  for (const p of room.players.values()) if (p.submission) submissions[p.id] = true;
  return {
    code: room.code, phase: room.phase, round: room.round, maxRounds:6, hostId:room.hostId,
    players:[...room.players.values()].map(p => playerPublic(p, viewerId, room)),
    readyCount:[...room.players.values()].filter(p=>p.ready).length,
    submittedCount:[...room.players.values()].filter(p=>p.submission).length,
    deadline:room.deadline, serverNow:Date.now(), signals:room.market?.signals || null,
    event:room.market?.event ? {name:room.market.event.name, description:room.market.event.description} : null,
    privateClue: viewer?.privateClue || null,
    feed:room.feed, chat:room.chat || [], results:room.results, finalResults:room.finalResults,
    allianceOptions:[...room.players.values()].filter(p=>p.id!==viewerId && p.connected).map(p=>({id:p.id,name:p.name})),
    abilityOptions:ABILITIES,
    host: room.hostId===viewerId,
    settings: {rounds:6, startingCoins:100, planningSeconds:20, negotiationSeconds:15}
  };
}
function broadcast(room) { for (const p of room.players.values()) { if (p.socketId) io.to(p.socketId).emit('state', publicState(room,p.id)); } }
function sendError(socket, message) { socket.emit('notice', {type:'error', message}); }
function sendNotice(room, message, kind='info') { log(room,message,kind); broadcast(room); }
function newPlayer(name, socket, token) { return { id:id(), token:token || id(), name:safeName(name), socketId:socket.id, connected:true, ready:false, coins:100, ability:null, abilityUsed:false, reputation:0, totalInvestmentProfit:0, sabotageCount:0, allianceWith:null, submission:null, privateClue:null, lastInvestments:null, sentinel:false, diplomatPact:null, joinedAt:Date.now() }; }
function createRoom(socket, name, token) {
  const code=makeCode(); const player=newPlayer(name,socket,token);
  const room={code,hostId:player.id,players:new Map([[player.id,player]]),phase:'lobby',round:0,deadline:null,market:null,feed:[],chat:[],results:null,finalResults:null,timer:null,createdAt:Date.now(),roundStartCoins:0};
  rooms.set(code,room); socket.data.roomCode=code; socket.data.playerId=player.id; socket.data.token=player.token;
  log(room,`${player.name} created the room.`, 'system');
  socket.emit('identity',{playerId:player.id,token:player.token,code}); broadcast(room); return room;
}
function findPlayerByToken(room, token) { return [...room.players.values()].find(p=>p.token===token); }
function joinRoom(socket, code, name, token) {
  code=String(code||'').toUpperCase().replace(/[^A-Z0-9]/g,''); const room=rooms.get(code);
  if(!room) return sendError(socket,'Room code not found. Check the code and try again.');
  let p=token ? findPlayerByToken(room,token) : null;
  if(p) {
    if(p.socketId && p.socketId!==socket.id) { const old=io.sockets.sockets.get(p.socketId); if(old) old.disconnect(true); }
    p.socketId=socket.id; p.connected=true; socket.data.roomCode=code; socket.data.playerId=p.id; socket.data.token=p.token;
    socket.emit('identity',{playerId:p.id,token:p.token,code}); log(room,`${p.name} reconnected.`, 'system'); broadcast(room); return;
  }
  if(room.phase!=='lobby' && room.phase!=='finished') return sendError(socket,'This match has already started. Rejoin with the original device session or wait for a rematch.');
  if(room.players.size>=8) return sendError(socket,'This room is full (8 players maximum).');
  if(room.phase==='finished') return sendError(socket,'This room is showing results. Wait for the rematch lobby before joining.');
  p=newPlayer(name,socket,token); room.players.set(p.id,p); socket.data.roomCode=code; socket.data.playerId=p.id; socket.data.token=p.token;
  socket.emit('identity',{playerId:p.id,token:p.token,code}); log(room,`${p.name} joined the room.`, 'system'); broadcast(room);
}
function stopTimer(room) { if(room.timer) clearTimeout(room.timer); room.timer=null; }
function setDeadline(room, ms, fn) { stopTimer(room); room.deadline=Date.now()+ms; room.timer=setTimeout(fn,ms); }
function resetRoundPlayers(room) { for(const p of room.players.values()){ p.submission=null; p.privateClue=null; p.sentinel=false; p.diplomatPact=null; p.allianceWith=null; p.lastInvestments=null; } }
function startMatch(room) {
  if(room.players.size<2) return;
  stopTimer(room); room.phase='briefing'; room.round=0; room.results=null; room.finalResults=null;
  for(const p of room.players.values()){p.coins=100;p.abilityUsed=false;p.reputation=0;p.totalInvestmentProfit=0;p.sabotageCount=0;p.allianceWith=null;p.submission=null;p.ready=false;p.privateClue=null;}
  log(room,'A new six-round match begins. Every trader starts with 100 coins.','system'); beginRound(room);
}
function makeMarket(room) {
  const signals={}, movements={};
  // Public signals intentionally indicate direction/risk, not the exact return. The exact move is fixed
  // at briefing time, so it cannot change after actions lock. Oracle reveals one exact move privately.
  for(const a of ASSETS) {
    const r=randInt(5); const movement=[-20,-10,0,10,20][r]; movements[a]=movement;
    const name=movement>=10 ? 'Bullish flow' : movement<=-10 ? 'Bearish pressure' : 'Mixed signals';
    signals[a]={name};
  }
  let event=null; if(room.round===3) event=EVENTS[0]; else if(room.round===5) event=EVENTS[1];
  room.market={signals,movements,event};
  for(const p of room.players.values()) {
    p.privateClue=null;
    if(event?.privateClue) { const a=ASSETS[randInt(ASSETS.length)]; p.privateClue={asset:a,name:ASSET_NAMES[a],movement:movements[a],signal:signals[a].name}; }
    if(room.round===1 && p.ability==='oracle' && !p.abilityUsed) { const a=ASSETS[randInt(ASSETS.length)]; p.privateClue={asset:a,name:ASSET_NAMES[a],movement:movements[a],signal:signals[a].name}; p.abilityUsed=true; }
  }
}
function beginRound(room) {
  if(room.round>=6) return finishMatch(room);
  room.round+=1; resetRoundPlayers(room); makeMarket(room); room.phase='negotiation'; room.results=null;
  log(room,`Round ${room.round}: market briefing is live. Read the signals and negotiate.`, 'round');
  broadcast(room);
  setDeadline(room,NEGOTIATION_MS,()=>beginPlanning(room));
}
function beginPlanning(room) { if(room.phase!=='negotiation') return; room.phase='planning'; log(room,`Round ${room.round}: planning is open for 20 seconds.`, 'system'); broadcast(room); setDeadline(room,PLANNING_MS,()=>resolveRound(room)); }
function chooseAbility(room,p,action) {
  if(!action || !action.type) return {ok:true};
  if(p.abilityUsed) return {ok:false,reason:'Your special ability has already been used this match.'};
  if(!p.ability) return {ok:false,reason:'Choose a special ability in the lobby first.'};
  if(action.type!==p.ability) return {ok:false,reason:'That is not your selected ability.'};
  if(action.type==='oracle') {
    const a=ASSETS.includes(action.asset)?action.asset:'ember';
    p.privateClue={asset:a,name:ASSET_NAMES[a],movement:room.market.movements[a],signal:room.market.signals[a].name};
    p.abilityUsed=true; return {ok:true,cost:0,desc:`Oracle revealed ${ASSET_NAMES[a]}'s exact movement.`};
  }
  if(action.type==='tycoon') { p.coins+=10; p.abilityUsed=true; return {ok:true,cost:0,desc:'Tycoon granted 10 coins.'}; }
  if(action.type==='diplomat') {
    const target=playerOf(room,action.targetId); if(!target||target.id===p.id) return {ok:false,reason:'Choose another player for Diplomat.'};
    p.diplomatPact=target.id; p.abilityUsed=true; return {ok:true,cost:0,desc:`Diplomat pact proposed to ${target.name}.`};
  }
  return {ok:true};
}
function validateSubmission(room,p,raw) {
  const x=raw&&typeof raw==='object'?raw:{};
  const investments={}; let investTotal=0;
  for(const a of ASSETS){const n=Number(x.investments?.[a]||0); if(!Number.isFinite(n)||n<0||!Number.isInteger(n)) return {error:'Investments must be whole non-negative coins.'}; if(n>60) return {error:'An investment cannot exceed 60 coins.'}; investments[a]=n; investTotal+=investments[a];}
  if(investTotal>60) return {error:'Total investment cannot exceed 60 coins per round.'};
  const protectionAssets=Array.isArray(x.protectionAssets)?[...new Set(x.protectionAssets.filter(a=>ASSETS.includes(a)))].slice(0,2):[];
  const sabotage=x.sabotage&&typeof x.sabotage==='object'?{type:x.sabotage.type,targetId:String(x.sabotage.targetId||''),asset:ASSETS.includes(x.sabotage.asset)?x.sabotage.asset:'ember'}:null;
  if(sabotage && !['disrupt','steal'].includes(sabotage.type)) return {error:'Choose a valid sabotage operation.'};
  if(sabotage && (!playerOf(room,sabotage.targetId)||sabotage.targetId===p.id)) return {error:'Choose a valid opponent to sabotage.'};
  const transfer=x.transfer&&typeof x.transfer==='object'?{targetId:String(x.transfer.targetId||''),amount:Number(x.transfer.amount)}:null;
  if(transfer && (!playerOf(room,transfer.targetId)||transfer.targetId===p.id||!Number.isInteger(transfer.amount)||transfer.amount<1||transfer.amount>20)) return {error:'A transfer must be 1–20 coins to another player.'};
  const alliance=x.alliance&&typeof x.alliance==='object'?{targetId:String(x.alliance.targetId||''),accept:!!x.alliance.accept}:null;
  if(alliance && (!playerOf(room,alliance.targetId)||alliance.targetId===p.id)) return {error:'Choose another player for an alliance.'};
  const ability=x.ability&&typeof x.ability==='object'?{type:String(x.ability.type||''),asset:x.ability.asset,targetId:String(x.ability.targetId||''),upgrade:String(x.ability.upgrade||'disrupt')}:null;
  // Costs are reserved in priority order; Oracle/Tycoon/Diplomat effects resolve before ordinary actions.
  let budget=p.coins;
  const abilityCost=ability && ['guardian','phantom','sentinel'].includes(ability.type)?(ability.type==='phantom'?5:5):0;
  const costs={protection:protectionAssets.length*5,ability:abilityCost,sabotage:sabotage?10:0,transfer:transfer?transfer.amount:0};
  const allowed={protection:[],ability:null,sabotage:null,transfer:null};
  for(const asset of protectionAssets){if(budget>=5){budget-=5;allowed.protection.push(asset);}}
  if(ability){
    const known=['guardian','phantom','oracle','diplomat','tycoon','sentinel'].includes(ability.type);
    const targetOk=ability.type!=='diplomat'||(playerOf(room,ability.targetId)&&ability.targetId!==p.id);
    const assetOk=ability.type!=='guardian'&&ability.type!=='oracle'||ASSETS.includes(ability.asset);
    if(known&&targetOk&&assetOk&&p.ability===ability.type&&!p.abilityUsed&&costs.ability<=budget){budget-=costs.ability;allowed.ability=ability;if(ability.type==='tycoon')budget+=10;}
  }
  if(sabotage&&budget>=10){budget-=10;allowed.sabotage=sabotage;}
  if(transfer&&budget>=transfer.amount){budget-=transfer.amount;allowed.transfer=transfer;}
  // Investments are committed from the remaining coin pool; enforce affordability after all reserved actions.
  if(investTotal>budget) return {error:`Your actions leave ${budget} coins available, but investments total ${investTotal}. Reduce investments or optional actions.`};
  // alliance invitation/acceptance has no coin cost
  return {submission:{investments,investTotal,protectionAssets:allowed.protection,sabotage:allowed.sabotage,transfer:allowed.transfer,alliance,ability:allowed.ability,phantomUpgrade:ability?.type==='phantom'?ability.upgrade:null,lockedAt:Date.now()},reserved:{protection:allowed.protection.length*5,ability:allowed.ability?costs.ability:0,sabotage:allowed.sabotage?10:0,transfer:allowed.transfer?allowed.transfer.amount:0,investTotal}};
}
function resolveRound(room) {
  if(!['planning','negotiation'].includes(room.phase)) return;
  stopTimer(room); room.phase='resolving'; room.deadline=null;
  const events=[]; const players=[...room.players.values()];
  // Missing submissions become a safe no-op.
  for(const p of players) if(!p.submission) p.submission={investments:{ember:0,tide:0,vault:0},investTotal:0,protectionAssets:[],sabotage:null,transfer:null,alliance:null,ability:null,phantomUpgrade:null,lockedAt:Date.now(),auto:true};
  // Step 1: mutually accepted alliance proposals. Existing alliance is only one round.
  const alliances=new Set();
  for(const p of players){const a=p.submission.alliance; if(!a) continue; const q=playerOf(room,a.targetId); if(!q||q.id===p.id||!q.submission?.alliance||q.submission.alliance.targetId!==p.id) continue; const key=[p.id,q.id].sort().join(':'); alliances.add(key); p.allianceWith=q.id; q.allianceWith=p.id;}
  // Step 2: commit all reserved costs exactly once and investments out of liquid coins.
  const spent={};
  for(const p of players){const s=p.submission; const costs=(s.protectionAssets.length*5)+(s.ability&&['guardian','phantom','sentinel'].includes(s.ability.type)?5:0)+(s.sabotage?10:0)+(s.transfer?s.transfer.amount:0)+s.investTotal; spent[p.id]=costs; if(costs>p.coins+(s.ability?.type==='tycoon'?10:0)){ // defensive invariant: cancel lowest priority actions until affordable
      let total=costs;
      if(s.transfer){total-=s.transfer.amount;s.transfer=null;}
      if(total>p.coins&&s.sabotage){total-=10;s.sabotage=null;}
      if(total>p.coins&&s.ability&&['guardian','phantom','sentinel'].includes(s.ability.type)){total-=5;s.ability=null;}
      while(total>p.coins&&s.protectionAssets.length){s.protectionAssets.pop();total-=5;}
      while(total>p.coins&&s.investTotal>0){const a=[...ASSETS].reverse().find(a=>s.investments[a]>0); if(!a)break; const cut=Math.min(s.investments[a],total-p.coins);s.investments[a]-=cut;s.investTotal-=cut;total-=cut;}
    }}
  // Special abilities with zero cost or cost already accounted for. Tycoon is credited once before costs; to avoid affordability ambiguity, ability effects are now applied and costs are then charged below.
  for(const p of players){const s=p.submission; if(!s.ability) continue; const a=s.ability;
    if(a.type==='tycoon'){p.coins+=10;p.abilityUsed=true;events.push(`${p.name} used Tycoon (+10 coins).`);}
    else if(a.type==='oracle'){const asset=ASSETS.includes(a.asset)?a.asset:'ember';p.privateClue={asset,name:ASSET_NAMES[asset],movement:room.market.movements[asset],signal:room.market.signals[asset].name};p.abilityUsed=true;events.push(`${p.name} consulted Oracle.`);}
    else if(a.type==='diplomat'){const q=playerOf(room,a.targetId); if(q){p.diplomatPact=q.id;p.abilityUsed=true;events.push(`${p.name} proposed a Diplomat pact to ${q.name}.`);}}
    else if(['guardian','phantom','sentinel'].includes(a.type)){p.abilityUsed=true;events.push(`${p.name} activated ${ABILITIES[a.type].name}.`);}
  }
  // Charge committed costs exactly once.
  for(const p of players){const s=p.submission; const cost=s.protectionAssets.length*5+(s.ability&&['guardian','phantom','sentinel'].includes(s.ability.type)?5:0)+(s.sabotage?10:0)+(s.transfer?s.transfer.amount:0)+s.investTotal; p.coins-=cost; if(p.coins<0) throw new Error('Coin invariant violated during cost settlement');}
  // Transfers are already deducted; credit recipients only if the submitted transfer remains valid and funded.
  for(const p of players){const t=p.submission.transfer;if(t){const q=playerOf(room,t.targetId);if(q){q.coins+=t.amount;events.push(`${p.name} transferred ${t.amount} coins to ${q.name}.`);}}}
  // Determine market returns. Market movement is fixed at briefing; sabotage modifies only its target.
  const baseReturns={}; for(const a of ASSETS){let movement=room.market.movements[a]; if(room.market.event?.modifiers?.[a]) movement+=room.market.event.modifiers[a]; if(room.market.event?.negativePenalty && movement<0) movement-=room.market.event.negativePenalty; baseReturns[a]=clamp(movement,-30,30);}
  const disruptions=[];
  for(const attacker of players){const s=attacker.submission; if(!s.sabotage)continue; const target=playerOf(room,s.sabotage.targetId); if(!target)continue;
    if(s.sabotage.type==='disrupt') { const ts=target.submission; let chosen=s.sabotage.asset; if(!ts.investments[chosen]) chosen=ASSETS.slice().sort((a,b)=>ts.investments[b]-ts.investments[a])[0]; const bonus=s.phantomUpgrade==='disrupt'&&s.ability?.type==='phantom'?10:0; disruptions.push({attacker,target,asset:chosen,delta:10+bonus}); events.push(`${attacker.name} used Market Disruption against ${target.name}'s ${ASSET_NAMES[chosen]} position.`); }
    else { const bonus=s.phantomUpgrade==='steal'&&s.ability?.type==='phantom'?5:0; disruptions.push({attacker,target,steal:5+bonus}); }
  }
  const effectiveReturns={}; for(const p of players) effectiveReturns[p.id]={...baseReturns};
  disruptions.filter(d=>d.asset).sort((a,b)=>a.attacker.id.localeCompare(b.attacker.id)).forEach(d=>{const inv=d.target.submission.investments; if(!inv[d.asset])return; const current=effectiveReturns[d.target.id][d.asset]; effectiveReturns[d.target.id][d.asset]=clamp(current-(current>0?d.delta:current<0?d.delta:0),-30,30); d.attacker.sabotageCount+=1;});
  // Protection offsets negative movement only, after sabotage. Guardian adds one token to the selected asset.
  const assetReturns={}; for(const p of players){const s=p.submission; const protectedAssets=[...s.protectionAssets]; if(s.ability?.type==='guardian'&&ASSETS.includes(s.ability.asset)) protectedAssets.push(s.ability.asset); const local={}; for(const a of ASSETS){let r=effectiveReturns[p.id][a]; const tokens=protectedAssets.filter(x=>x===a).length; if(r<0&&tokens) r=Math.min(0,r+tokens*10); local[a]=r;} assetReturns[p.id]=local;}
  // Settle invested principal + return. Investments were deducted once in the cost phase.
  for(const p of players){const s=p.submission; let profit=0; const inv={}; for(const a of ASSETS){const amt=s.investments[a]||0; const r=assetReturns[p.id][a]; const delta=amt===0?0:(r>=0?Math.floor(amt*r/100):-Math.ceil(amt*Math.abs(r)/100)); const value=Math.max(0,amt+delta); p.coins+=value; profit+=value-amt; inv[a]={invested:amt,returnPct:r,profit:value-amt,value};} p.lastInvestments=inv; p.reputation+=profit>0?1:0; p.totalInvestmentProfit+=profit; }
  // Theft resolves after investment settlement. Sentinel blocks one theft per target, if activated and paid.
  const thefts=disruptions.filter(d=>d.steal).sort((a,b)=>a.attacker.id.localeCompare(b.attacker.id));
  const sentinelUsed=new Set();
  for(const d of thefts){const t=d.target; if(t.submission.ability?.type==='sentinel'&&!sentinelUsed.has(t.id)){sentinelUsed.add(t.id);events.push(`${t.name}'s Sentinel blocked theft from ${d.attacker.name}.`);continue;} const amount=Math.min(t.coins,d.steal); t.coins-=amount;d.attacker.coins+=amount;if(amount>0)d.attacker.sabotageCount+=1;events.push(amount?`${d.attacker.name} stole ${amount} coins from ${t.name}.`:`${d.attacker.name}'s theft failed: ${t.name} had no coins available.`);}
  // Betrayal penalty: any sabotage against a current-round ally transfers up to 5 coins to ally.
  for(const attacker of players){const s=attacker.submission;if(!s.sabotage)continue;const target=playerOf(room,s.sabotage.targetId);if(target&&attacker.allianceWith===target.id){const penalty=Math.min(5,attacker.coins);attacker.coins-=penalty;target.coins+=penalty;attacker.reputation-=1;events.push(`${attacker.name} betrayed ${target.name}; ${penalty} coins transferred as a penalty.`);}}
  // Diplomat bonus: only if both parties have the same mutual pact and neither attacked the other.
  for(const p of players){if(!p.diplomatPact||p.id>p.diplomatPact)continue;const q=playerOf(room,p.diplomatPact);if(!q||q.diplomatPact!==p.id)continue;const attacked=(a,b)=>a.submission.sabotage?.targetId===b.id; if(!attacked(p,q)&&!attacked(q,p)){p.coins+=5;q.coins+=5;events.push(`Diplomat pact held: ${p.name} and ${q.name} each gained 5 coins.`);}}
  // Publish a transparent per-player ledger. Costs and transfers are separately labeled; investment result shows net P/L.
  const playerResults=players.map(p=>{const s=p.submission;return {id:p.id,name:p.name,coins:p.coins,investments:p.lastInvestments,spent:{protection:s.protectionAssets.length*5,ability:s.ability&&['guardian','phantom','sentinel'].includes(s.ability.type)?5:0,sabotage:s.sabotage?10:0,transfer:s.transfer?.amount||0,invested:s.investTotal},sabotage:s.sabotage?{type:s.sabotage.type,target:playerOf(room,s.sabotage.targetId)?.name||'Unknown'}:null,auto:!!s.auto,ability:s.ability?.type||null};});
  const beforeInvariant=totalCoins(room); // coin creation is only explicit bonuses and market P/L; transfers cancel.
  room.results={round:room.round,returns:baseReturns,event:room.market.event?room.market.event.name:null,players:playerResults,events,coinTotal:beforeInvariant,signals:room.market.signals};
  log(room,`Round ${room.round} resolved. Market returns: ${ASSETS.map(a=>`${ASSET_NAMES[a]} ${baseReturns[a]>0?'+':''}${baseReturns[a]}%`).join(', ')}.`, 'results');
  for(const e of events) log(room,e,'event');
  room.phase='results'; room.deadline=null; broadcast(room);
  setDeadline(room,10000,()=>{if(room.round>=6)finishMatch(room);else beginRound(room);});
}
function finishMatch(room) {
  stopTimer(room); room.phase='finished'; room.deadline=null;
  const ps=[...room.players.values()]; const totals=ps.map(p=>({id:p.id,name:p.name,wealth:p.coins,coins:p.coins,reputation:p.reputation,sabotageCount:p.sabotageCount||0,investmentProfit:p.totalInvestmentProfit||0}));
  totals.sort((a,b)=>b.wealth-a.wealth||b.investmentProfit-a.investmentProfit||b.coins-a.coins||a.sabotageCount-b.sabotageCount||a.name.localeCompare(b.name));
  const winners=totals.filter(x=>x.wealth===totals[0]?.wealth&&x.investmentProfit===totals[0]?.investmentProfit&&x.coins===totals[0]?.coins&&x.sabotageCount===totals[0]?.sabotageCount).map(x=>x.id);
  room.finalResults={standings:totals,winnerIds:winners,shared:winners.length>1}; log(room,winners.length>1?'Match complete: shared victory!':`Match complete: ${totals[0]?.name||'No winner'} wins with ${totals[0]?.wealth||0} coins.`,'system'); broadcast(room);
}

io.on('connection',socket=>{
  socket.on('createRoom',(data={})=>{try{const token=String(data.token||'');createRoom(socket,data.name,token);}catch(e){sendError(socket,'Could not create room. Please retry.');}});
  socket.on('joinRoom',(data={})=>{try{joinRoom(socket,data.code,data.name,data.token);}catch(e){sendError(socket,'Could not join room. Please retry.');}});
  socket.on('chooseAbility',(data={})=>{const room=roomOf(socket),p=playerOf(room,socket.data.playerId);if(!room||!p||room.phase!=='lobby')return sendError(socket,'Choose an ability in the lobby before the match starts.');if(!Object.hasOwn(ABILITIES,data.ability))return sendError(socket,'Unknown ability.');p.ability=data.ability;broadcast(room);});
  socket.on('ready',()=>{const room=roomOf(socket),p=playerOf(room,socket.data.playerId);if(!room||!p||room.phase!=='lobby')return;p.ready=!p.ready;broadcast(room);});
  socket.on('startMatch',()=>{const room=roomOf(socket);if(!room||socket.data.playerId!==room.hostId)return sendError(socket,'Only the host can start the match.');if(room.phase!=='lobby'&&room.phase!=='finished')return sendError(socket,'A match is already in progress.');if(room.players.size<2)return sendError(socket,'At least two players are required.');if([...room.players.values()].some(p=>!p.ready))return sendError(socket,'Everyone must be ready before the host starts.');startMatch(room);});
  socket.on('chatMessage',(data={})=>{const room=roomOf(socket),p=playerOf(room,socket.data.playerId);if(!room||!p||!p.connected)return;const message=String(data.message||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,240);if(!message)return;room.chat.push({id:id(),playerId:p.id,name:p.name,message,at:Date.now()});room.chat=room.chat.slice(-60);broadcast(room);});
  socket.on('submitAction',(data={})=>{const room=roomOf(socket),p=playerOf(room,socket.data.playerId);if(!room||!p||room.phase!=='planning')return sendError(socket,'Actions can only be submitted during planning.');if(p.submission)return sendError(socket,'Your actions are already locked for this round.');const v=validateSubmission(room,p,data);if(v.error)return sendError(socket,v.error);p.submission=v.submission;log(room,`${p.name} locked their actions.`, 'system');broadcast(room);if([...room.players.values()].every(x=>x.submission))resolveRound(room);});
  socket.on('nextRound',()=>{const room=roomOf(socket);if(!room||room.phase!=='results')return;if(room.timer){clearTimeout(room.timer);room.timer=null;}if(room.round>=6)finishMatch(room);else beginRound(room);});
  socket.on('rematchVote',()=>{const room=roomOf(socket),p=playerOf(room,socket.data.playerId);if(!room||!p||room.phase!=='finished')return;p.ready=!p.ready;broadcast(room);const connected=[...room.players.values()].filter(x=>x.connected);if(connected.length>=2&&connected.every(x=>x.ready))startMatch(room);});
  socket.on('disconnect',()=>{const room=roomOf(socket),p=playerOf(room,socket.data.playerId);if(!room||!p)return;p.connected=false;p.socketId=null;log(room,`${p.name} disconnected. Their seat is reserved for reconnection.`,'system');if(room.hostId===p.id){const next=[...room.players.values()].filter(x=>x.connected).sort((a,b)=>a.joinedAt-b.joinedAt)[0];if(next)room.hostId=next.id;}broadcast(room);});
});

// Periodic cleanup of abandoned lobby/finished rooms; active match state is retained.
setInterval(()=>{for(const [sid,socket] of socketMap){if(Date.now()-socket._lastSeen>45000)socket.disconnect();}for(const [code,r] of rooms){if(['lobby','finished'].includes(r.phase)&&Date.now()-r.createdAt>6*60*60*1000&&![...r.players.values()].some(p=>p.connected)){stopTimer(r);rooms.delete(code);}}},60*60*1000).unref();
const port=process.env.PORT||3000; server.listen(port,'0.0.0.0',()=>console.log(`SHADOW MARKET listening on ${port}`));
