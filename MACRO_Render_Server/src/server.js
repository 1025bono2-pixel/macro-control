const express=require('express');
const http=require('http');
const path=require('path');
const crypto=require('crypto');
const {WebSocketServer,WebSocket}=require('ws');

const PORT=Number(process.env.PORT||10000);
const HOST_SECRET=String(process.env.HOST_SECRET||'');
const app=express();
const server=http.createServer(app);
const wss=new WebSocketServer({noServer:true});
let host=null;
const pending=new Map();
const apiCache=new Map();
const CACHE_TTL=15000;
const STALE_TTL=5*60*1000;

function rejectPending(reason='Host 연결이 끊겼습니다.'){
  for(const [id,p] of pending){clearTimeout(p.timer);try{p.reject(new Error(reason))}catch{}pending.delete(id)}
}
function cacheKey(req){
  const auth=String(req.headers.authorization||'');
  return crypto.createHash('sha256').update(auth+'|'+req.method+'|'+req.originalUrl).digest('hex');
}
function cacheable(req){
  return req.method==='GET'&&/^\/api\/(me|status|macro\/recent|notices|macros|rooms(?:\?|$)|admin\/detail\/bot\/)/.test(req.originalUrl);
}

function send(ws,data){if(ws&&ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify(data));return true}return false}
function suppliedSecret(req,url){const auth=String(req.headers.authorization||'');if(auth.startsWith('Bearer '))return auth.slice(7);return String(url.searchParams.get('secret')||'')}
function callHost(payload,timeout=10000){return new Promise((resolve,reject)=>{if(!host||host.readyState!==WebSocket.OPEN)return reject(new Error('총괄 PC Host가 오프라인입니다.'));const requestId=crypto.randomUUID();const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Host 응답 시간 초과'))},timeout);pending.set(requestId,{resolve,reject,timer});send(host,{type:'proxy.http',requestId,payload})})}

server.on('upgrade',(req,socket,head)=>{
  let url;try{url=new URL(req.url,'http://localhost')}catch{return socket.destroy()}
  if(url.pathname!=='/host')return socket.destroy();
  if(!HOST_SECRET){console.log('[HOST] rejected: HOST_SECRET is not configured');socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return socket.destroy()}
  if(suppliedSecret(req,url)!==HOST_SECRET){console.log('[HOST] rejected: unauthorized');socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return socket.destroy()}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});

wss.on('connection',ws=>{
  if(host&&host.readyState===WebSocket.OPEN){rejectPending('Host 연결이 교체되어 요청을 다시 시도해야 합니다.');host.close(1012,'replaced')}
  host=ws;ws.isAlive=true;
  console.log('[HOST] connected');
  send(ws,{type:'host.ready',version:'2.1'});
  ws.on('pong',()=>{ws.isAlive=true});
  ws.on('message',raw=>{let m;try{m=JSON.parse(String(raw))}catch{return}if(m.requestId&&pending.has(m.requestId)){const p=pending.get(m.requestId);pending.delete(m.requestId);clearTimeout(p.timer);m.ok===false?p.reject(new Error(m.error||'Host error')):p.resolve(m.result)}});
  ws.on('error',e=>console.log('[HOST] socket error:',e.message));
  ws.on('close',(code,reason)=>{console.log(`[HOST] disconnected code=${code} reason=${String(reason||'')}`);if(host===ws){host=null;rejectPending('총괄 PC Host 연결이 끊겼습니다.')}});
});

const heartbeat=setInterval(()=>{if(!host||host.readyState!==WebSocket.OPEN)return;if(host.isAlive===false){console.log('[HOST] heartbeat timeout');host.terminate();return}host.isAlive=false;try{host.ping()}catch{}},25000);
server.on('close',()=>clearInterval(heartbeat));

app.get('/health',(_q,r)=>r.json({ok:true,hostConnected:!!(host&&host.readyState===WebSocket.OPEN)}));
app.use('/api',(req,res)=>{
  const chunks=[];let size=0,aborted=false;
  const canCache=cacheable(req),key=canCache?cacheKey(req):null,now=Date.now();
  const cached=key?apiCache.get(key):null;
  if(cached&&now-cached.at<CACHE_TTL){res.setHeader('X-MACRO-Cache','HIT');return res.status(cached.status).send(cached.body)}
  req.on('data',c=>{size+=c.length;if(size>25*1024*1024){aborted=true;res.status(413).json({error:'요청 크기가 너무 큽니다.'});req.destroy();return}chunks.push(c)});
  req.on('end',async()=>{
    if(aborted)return;
    try{
      const body=Buffer.concat(chunks);
      const result=await callHost({method:req.method,path:req.originalUrl,headers:req.headers,bodyBase64:body.toString('base64')});
      const out=Buffer.from(result.bodyBase64||'','base64');
      for(const[k,v]of Object.entries(result.headers||{})){if(v!==undefined&&!['connection','transfer-encoding','content-length'].includes(k.toLowerCase()))try{res.setHeader(k,v)}catch{}}
      const status=result.status||500;
      if(canCache&&status>=200&&status<300){
        apiCache.set(key,{at:Date.now(),status,body:out});
        if(apiCache.size>500)for(const[k,v]of apiCache)if(Date.now()-v.at>STALE_TTL)apiCache.delete(k);
      }
      res.status(status).send(out);
    }catch(e){
      if(cached&&Date.now()-cached.at<STALE_TTL){
        res.setHeader('X-MACRO-Cache','STALE');res.setHeader('X-MACRO-Host','offline');
        return res.status(cached.status).send(cached.body);
      }
      res.status(503).json({error:e.message});
    }
  });
});
app.use(express.static(path.join(__dirname,'..','public')));
app.get('/*splat',(_req,res)=>res.sendFile(path.join(__dirname,'..','public','index.html')));
server.listen(PORT,'0.0.0.0',()=>console.log('[MACRO CONTROL] '+PORT));
