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

function send(ws,data){if(ws&&ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify(data));return true}return false}
function suppliedSecret(req,url){const auth=String(req.headers.authorization||'');if(auth.startsWith('Bearer '))return auth.slice(7);return String(url.searchParams.get('secret')||'')}
function callHost(payload,timeout=30000){return new Promise((resolve,reject)=>{if(!host||host.readyState!==WebSocket.OPEN)return reject(new Error('총괄 PC Host가 오프라인입니다.'));const requestId=crypto.randomUUID();const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Host 응답 시간 초과'))},timeout);pending.set(requestId,{resolve,reject,timer});send(host,{type:'proxy.http',requestId,payload})})}

server.on('upgrade',(req,socket,head)=>{
  let url;try{url=new URL(req.url,'http://localhost')}catch{return socket.destroy()}
  if(url.pathname!=='/host')return socket.destroy();
  if(!HOST_SECRET){console.log('[HOST] rejected: HOST_SECRET is not configured');socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return socket.destroy()}
  if(suppliedSecret(req,url)!==HOST_SECRET){console.log('[HOST] rejected: unauthorized');socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return socket.destroy()}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});

wss.on('connection',ws=>{
  if(host&&host.readyState===WebSocket.OPEN)host.close(1012,'replaced');
  host=ws;ws.isAlive=true;
  console.log('[HOST] connected');
  send(ws,{type:'host.ready',version:'2.1'});
  ws.on('pong',()=>{ws.isAlive=true});
  ws.on('message',raw=>{let m;try{m=JSON.parse(String(raw))}catch{return}if(m.requestId&&pending.has(m.requestId)){const p=pending.get(m.requestId);pending.delete(m.requestId);clearTimeout(p.timer);m.ok===false?p.reject(new Error(m.error||'Host error')):p.resolve(m.result)}});
  ws.on('error',e=>console.log('[HOST] socket error:',e.message));
  ws.on('close',(code,reason)=>{console.log(`[HOST] disconnected code=${code} reason=${String(reason||'')}`);if(host===ws)host=null});
});

const heartbeat=setInterval(()=>{if(!host||host.readyState!==WebSocket.OPEN)return;if(host.isAlive===false){console.log('[HOST] heartbeat timeout');host.terminate();return}host.isAlive=false;try{host.ping()}catch{}},25000);
server.on('close',()=>clearInterval(heartbeat));

app.get('/health',(_q,r)=>r.json({ok:true,hostConnected:!!(host&&host.readyState===WebSocket.OPEN)}));
app.use('/api',(req,res)=>{const chunks=[];let size=0,aborted=false;req.on('data',c=>{size+=c.length;if(size>25*1024*1024){aborted=true;res.status(413).json({error:'요청 크기가 너무 큽니다.'});req.destroy();return}chunks.push(c)});req.on('end',async()=>{if(aborted)return;try{const body=Buffer.concat(chunks);const result=await callHost({method:req.method,path:req.originalUrl,headers:req.headers,bodyBase64:body.toString('base64')});for(const[k,v]of Object.entries(result.headers||{})){if(v!==undefined&&!['connection','transfer-encoding','content-length'].includes(k.toLowerCase()))try{res.setHeader(k,v)}catch{}}res.status(result.status||500).send(Buffer.from(result.bodyBase64||'','base64'))}catch(e){res.status(503).json({error:e.message})}})});
app.use(express.static(path.join(__dirname,'..','public')));
app.get('/*splat',(_req,res)=>res.sendFile(path.join(__dirname,'..','public','index.html')));
server.listen(PORT,'0.0.0.0',()=>console.log('[MACRO CONTROL] '+PORT));
