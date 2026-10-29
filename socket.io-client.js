/* Tiny client shim for SHADOW MARKET's dependency-free polling transport. */
(function(global){
  function io(){
    const handlers={};let socketId=null,connected=false,closed=false,pollTimer=null,sendChain=Promise.resolve();
    const emitLocal=(event,data)=>{for(const fn of handlers[event]||[]){try{fn(data)}catch(e){console.error(e)}}};
    const api={
      on(event,fn){(handlers[event]||(handlers[event]=[])).push(fn);return api;},
      emit(event,data={}){if(!socketId||closed)return api;const target=socketId;sendChain=sendChain.then(()=>fetch('/api/emit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({socketId:target,event,data})})).catch(()=>{});return api;},
      disconnect(){closed=true;if(pollTimer)clearInterval(pollTimer);if(socketId)navigator.sendBeacon('/api/disconnect',new Blob([JSON.stringify({socketId})],{type:'application/json'}));if(connected){connected=false;emitLocal('disconnect','client disconnect');}}
    };
    async function connect(){try{const r=await fetch('/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!r.ok)throw Error('connect failed');const d=await r.json();socketId=d.socketId;connected=true;emitLocal('connect');poll();}catch(e){emitLocal('connect_error',e);if(!closed)setTimeout(connect,1500);}}
    async function poll(){if(!socketId||closed)return;try{const r=await fetch('/api/poll?socketId='+encodeURIComponent(socketId),{cache:'no-store'});if(r.status===410){if(pollTimer)clearInterval(pollTimer);socketId=null;connected=false;emitLocal('disconnect','connection expired');if(!closed)setTimeout(connect,250);return;}if(!r.ok)return;const d=await r.json();for(const m of d.messages||[])emitLocal(m.event,m.data);if(!closed)pollTimer=setTimeout(poll,350);}catch(e){if(connected){connected=false;emitLocal('disconnect','network error');}}}
    connect();return api;
  }
  global.io=io;
})(window);
