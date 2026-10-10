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
const apiCache=new Map(),apiInflight=new Map();
const CACHE_FRESH_MS=12000,CACHE_STALE_MS=300000;
function rejectPending(reason='Host 연결이 끊겼습니다.'){for(const[id,p]of pending){clearTimeout(p.timer);try{p.reject(new Error(reason))}catch{}pending.delete(id)}}
function apiKey(req){return crypto.createHash('sha256').update(String(req.headers.authorization||'')+'|'+req.method+'|'+req.originalUrl).digest('hex')}
function canCache(req){return req.method==='GET'&&/^\/api\/(me|status|macros(?:\?|$)|macro\/recent|rooms(?:\?|$)|notices(?:\?|$)|admin\/detail\/bot\/)/.test(req.originalUrl)}
function clearApiCache(){apiCache.clear()}


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
  if(host&&host.readyState===WebSocket.OPEN){rejectPending('Host 연결이 교체되었습니다.');host.close(1012,'replaced')}
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
 const chunks=[];let size=0,aborted=false,cacheable=canCache(req),key=cacheable?apiKey(req):null,cached=key?apiCache.get(key):null;
 if(cached&&Date.now()-cached.at<CACHE_FRESH_MS){res.setHeader('X-MACRO-Cache','HIT');return res.status(cached.status).send(cached.body)}
 req.on('data',c=>{size+=c.length;if(size>25*1024*1024){aborted=true;res.status(413).json({error:'요청 크기가 너무 큽니다.'});req.destroy();return}chunks.push(c)});
 req.on('end',async()=>{if(aborted)return;try{
  const body=Buffer.concat(chunks),payload={method:req.method,path:req.originalUrl,headers:req.headers,bodyBase64:body.toString('base64')};
  let promise=key?apiInflight.get(key):null;if(!promise){promise=callHost(payload);if(key)apiInflight.set(key,promise)}
  let result;try{result=await promise}finally{if(key&&apiInflight.get(key)===promise)apiInflight.delete(key)}
  const out=Buffer.from(result.bodyBase64||'','base64'),status=result.status||500;
  for(const[k,v]of Object.entries(result.headers||{})){if(v!==undefined&&!['connection','transfer-encoding','content-length'].includes(k.toLowerCase()))try{res.setHeader(k,v)}catch{}}
  if(cacheable&&status>=200&&status<300)apiCache.set(key,{at:Date.now(),status,body:out});
  if(req.method!=='GET'&&status>=200&&status<300)clearApiCache();
  res.status(status).send(out);
 }catch(e){if(cached&&Date.now()-cached.at<CACHE_STALE_MS){res.setHeader('X-MACRO-Cache','STALE');return res.status(cached.status).send(cached.body)}res.status(503).json({error:e.message})}})
});
app.use(express.static(path.join(__dirname,'..','public')));
app.get('/*splat',(_req,res)=>res.sendFile(path.join(__dirname,'..','public','index.html')));
server.listen(PORT,'0.0.0.0',()=>console.log('[MACRO CONTROL] '+PORT));
