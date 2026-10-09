const express=require('express');
const http=require('http');
const path=require('path');
const crypto=require('crypto');
const {WebSocketServer,WebSocket}=require('ws');
const PORT=Number(process.env.PORT||10000),HOST_SECRET=String(process.env.HOST_SECRET||'');
const app=express(),server=http.createServer(app),wss=new WebSocketServer({server,path:'/host'});
let host=null;const pending=new Map();
function send(ws,x){if(ws&&ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify(x));return true}return false}
function callHost(payload,timeout=30000){return new Promise((resolve,reject)=>{if(!host||host.readyState!==WebSocket.OPEN)return reject(new Error('총괄 PC Host가 오프라인입니다.'));const requestId=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('Host 응답 시간 초과'));},timeout);pending.set(requestId,{resolve,reject,timer});send(host,{type:'proxy.http',requestId,payload});});}
wss.on('connection',(ws,req)=>{const u=new URL(req.url,'http://localhost');if(!HOST_SECRET||u.searchParams.get('secret')!==HOST_SECRET)return ws.close(1008,'unauthorized');if(host&&host.readyState===WebSocket.OPEN)host.close(1012,'replaced');host=ws;console.log('[HOST] connected');ws.on('message',raw=>{let m;try{m=JSON.parse(String(raw))}catch{return}if(m.requestId&&pending.has(m.requestId)){const p=pending.get(m.requestId);pending.delete(m.requestId);clearTimeout(p.timer);m.ok===false?p.reject(new Error(m.error||'Host error')):p.resolve(m.result)}});ws.on('close',()=>{if(host===ws){host=null;console.log('[HOST] disconnected')}})});
app.get('/health',(_q,r)=>r.json({ok:true,hostConnected:!!(host&&host.readyState===WebSocket.OPEN)}));
app.use('/api',(req,res)=>{const chunks=[];req.on('data',c=>{chunks.push(c);if(chunks.reduce((n,b)=>n+b.length,0)>25*1024*1024)req.destroy()});req.on('end',async()=>{try{const body=Buffer.concat(chunks);const result=await callHost({method:req.method,path:req.originalUrl,headers:req.headers,bodyBase64:body.toString('base64')});const h=result.headers||{};for(const [k,v] of Object.entries(h)){if(v!==undefined&&!['connection','transfer-encoding','content-length'].includes(k.toLowerCase()))try{res.setHeader(k,v)}catch{}}const out=Buffer.from(result.bodyBase64||'','base64');res.status(result.status||500).send(out)}catch(e){res.status(503).json({error:e.message})}})});
app.use(express.static(path.join(__dirname,'..','public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'..','public','index.html')));
server.listen(PORT,'0.0.0.0',()=>console.log('[MACRO CONTROL] '+PORT));
