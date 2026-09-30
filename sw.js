const CACHE='bale-wms-mobile-v2';
const CORE=['./','./index.html','./style.css','./app.js','./firebase-config.js','./manifest.webmanifest','./icon.svg','./suppliers.txt'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys())if(k!==CACHE)await caches.delete(k);await self.clients.claim()})()));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  if(u.origin===self.location.origin){
    // Network-first so GitHub/Firebase deployments and suppliers.txt update promptly; cached app remains usable offline.
    e.respondWith(fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy))}return r}).catch(()=>caches.match(e.request).then(x=>x||caches.match('./index.html'))));
    return;
  }
  if(u.hostname==='unpkg.com'||u.hostname==='www.gstatic.com')e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(r=>{if(r.ok)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r})));
});
