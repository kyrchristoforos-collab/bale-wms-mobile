
import {firebaseConfig} from './firebase-config.js';
import {initializeApp} from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js';
import {getAuth,signInWithEmailAndPassword,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js';
import {getFirestore,doc,setDoc,serverTimestamp} from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js';

const app=initializeApp(firebaseConfig), auth=getAuth(app), db=getFirestore(app);
const $=id=>document.getElementById(id);

const QUEUE_KEY='bale-wms-mobile-events-v2';
const SUPPLIERS_KEY='bale-wms-mobile-suppliers-v1';
const DEFAULT_SUPPLIERS=['ECORECOVERY','Sabellico','Calabra'];

let scanner=null, scanning=false, syncing=false, scannedCode='';

function message(s){$('message').textContent=s||''}
function nowIso(){return new Date().toISOString()}

function queue(){
  try{return JSON.parse(localStorage.getItem(QUEUE_KEY)||'[]')}
  catch(_){return []}
}

function writeQueue(items){
  localStorage.setItem(QUEUE_KEY,JSON.stringify(items.slice(0,1000)));
}

function updateEvent(id,patch){
  const a=queue(),i=a.findIndex(x=>x.event_id===id);
  if(i>=0){
    a[i]={...a[i],...patch};
    writeQueue(a);
  }
}

function addEvent(type,payload,label){
  const performed_at=nowIso();

  const event={
    event_id:crypto.randomUUID(),
    type,
    payload:{...payload,performed_at},
    label,
    performed_at,
    state:'PENDING',
    attempts:0,
    last_error:''
  };

  const a=queue();
  a.unshift(event);
  writeQueue(a);
  return event;
}

function stateText(e){
  return e.state==='SENT'?'✓ Απεστάλη':
    e.state==='SENDING'?'↻ Αποστολή...':
    e.state==='ERROR'?'⚠ Σε αναμονή':
    '⏳ Σε αναμονή';
}

function renderHistory(){
  const box=$('history-items');
  box.replaceChildren();
  const a=queue();

  if(!a.length){
    const p=document.createElement('p');
    p.className='hint';
    p.textContent='Δεν υπάρχουν κινήσεις σε αυτή τη συσκευή.';
    box.append(p);
    return;
  }

  for(const e of a){
    const x=document.createElement('article');
    const d=new Date(e.performed_at);

    x.innerHTML=
      `<strong>${e.type==='RECEIPT'?'Παραλαβή':'Λύσιμο'}</strong><br>`+
      `<span>${escapeHtml(e.label)}</span><br>`+
      `<small>${d.toLocaleString('el-GR')} · ${stateText(e)}</small>`+
      (e.last_error&&e.state!=='SENT'
        ?`<br><small class="error">${escapeHtml(e.last_error)}</small>`
        :'');
    box.append(x);
  }
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,c=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

function tab(t){
  for(const x of ['receipt','scan','history']){
    $(x).hidden=x!==t;
  }

  if(t==='history'){
    renderHistory();
    refreshConnectionBadge();
  }else{
    stopCamera();
  }
}

document.querySelectorAll('[data-tab]').forEach(
  b=>b.onclick=()=>tab(b.dataset.tab)
);

$('login').onclick=async()=>{
  try{
    await signInWithEmailAndPassword(
      auth,
      $('email').value.trim(),
      $('password').value
    );
    $('password').value='';
    message('Συνδέθηκες.');
    syncPending();
  }catch(e){
    message('Αποτυχία σύνδεσης: '+e.code);
  }
};

onAuthStateChanged(auth,u=>{
  $('login-panel').hidden=!!u;
  $('main-panel').hidden=!u;
  $('identity').textContent=u?'Συνδεδεμένο':'';

  if(u){
    tab('receipt');
    loadSuppliers();
    syncPending();
  }
});


// ============================================================
// ΠΡΟΜΗΘΕΥΤΕΣ - OFFLINE ΑΠΟΘΗΚΕΥΣΗ
// ============================================================

function normalizeSuppliers(names){
  if(!Array.isArray(names))return [];

  return [...new Map(
    names
      .map(x=>String(x).trim())
      .filter(Boolean)
      .map(x=>[x.toLocaleUpperCase('el-GR'),x])
  ).values()];
}

function cachedSuppliers(){
  try{
    const saved=JSON.parse(
      localStorage.getItem(SUPPLIERS_KEY)||'null'
    );

    if(Array.isArray(saved)){
      return normalizeSuppliers(saved);
    }
  }catch(_){}

  return [];
}

function saveSuppliers(names){
  try{
    localStorage.setItem(
      SUPPLIERS_KEY,
      JSON.stringify(names)
    );
  }catch(e){
    console.warn('Δεν αποθηκεύτηκε η λίστα προμηθευτών.',e);
  }
}

function showSuppliers(names){
  const select=$('supplier');
  const previous=select.value;

  select.replaceChildren(
    new Option('Επίλεξε προμηθευτή','')
  );

  for(const name of names){
    select.add(new Option(name,name));
  }

  if(names.includes(previous)){
    select.value=previous;
  }

  supplierMode();
}

async function loadSuppliers(){
  // Πρώτα εμφανίζουμε άμεσα την αποθηκευμένη λίστα.
  const cached=cachedSuppliers();

  if(cached.length){
    showSuppliers(cached);
  }else{
    // Εφεδρική λίστα για πρώτη χρήση χωρίς Internet.
    showSuppliers(DEFAULT_SUPPLIERS);
  }

  // Έπειτα δοκιμάζουμε να πάρουμε την πιο πρόσφατη λίστα.
  try{
    const r=await fetch(
      './suppliers.txt?ts='+Date.now(),
      {cache:'no-store'}
    );

    if(!r.ok){
      throw Error('HTTP '+r.status);
    }

    const text=await r.text();
    const names=normalizeSuppliers(
      text.split(/\r?\n/)
    );

    if(!names.length){
      throw Error('Η λίστα προμηθευτών είναι κενή.');
    }

    // Ενημερώνουμε και την οθόνη και την τοπική μνήμη.
    showSuppliers(names);
    saveSuppliers(names);

  }catch(e){
    // Δεν χάνεται η λίστα όταν λείπει το Internet.
    console.warn(
      'Χρήση αποθηκευμένης λίστας προμηθευτών:',
      e.message
    );
  }
}

function isEcorecovery(){
  return $('supplier').value.trim().toUpperCase()==='ECORECOVERY';
}

function supplierMode(){
  const eco=isEcorecovery();

  $('ecorecovery-fields').hidden=!eco;
  $('total-kg').required=!eco;
  $('kg-per-bale').required=eco;

  updateEcoTotal();
}

function updateEcoTotal(){
  const q=Number($('quantity').value||0);
  const kg=Number($('kg-per-bale').value||0);

  $('ecorecovery-total').textContent=
    q>0&&kg>0
      ?`Σύνολο: ${q} bales · ${q*kg} kg`
      :'';
}

$('supplier').onchange=supplierMode;
$('quantity').oninput=updateEcoTotal;
$('kg-per-bale').oninput=updateEcoTotal;


// ============================================================
// FIREBASE / OFFLINE QUEUE
// ============================================================

async function sendOne(e){
  if(!auth.currentUser){
    throw Error('Δεν υπάρχει ενεργή σύνδεση Firebase.');
  }

  if(!navigator.onLine){
    throw Error('Δεν υπάρχει σύνδεση Internet.');
  }

  updateEvent(e.event_id,{
    state:'SENDING',
    attempts:(e.attempts||0)+1,
    last_error:''
  });

  const record={
    event_id:e.event_id,
    type:e.type,
    payload:e.payload,
    created_at:serverTimestamp(),
    created_by:auth.currentUser.uid,
    status:'PENDING'
  };

  await Promise.race([
    setDoc(doc(db,'wms_events',e.event_id),record),
    new Promise((_,reject)=>
      setTimeout(
        ()=>reject(Error('Δεν υπήρξε επιβεβαίωση από Firebase.')),
        12000
      )
    )
  ]);

  updateEvent(e.event_id,{
    state:'SENT',
    sent_at:nowIso(),
    last_error:''
  });
}

async function syncPending(){
  if(syncing||!auth.currentUser)return;

  syncing=true;

  try{
    for(const e of queue().slice().reverse()){
      if(e.state==='SENT')continue;

      try{
        await sendOne(e);
      }catch(err){
        updateEvent(e.event_id,{
          state:'ERROR',
          last_error:err.message||String(err)
        });

        if(!navigator.onLine)break;
      }
    }
  }finally{
    syncing=false;
    renderHistory();
    refreshConnectionBadge();
  }
}

async function createAndTry(type,payload,label){
  const e=addEvent(type,payload,label);

  renderHistory();

  try{
    await sendOne(e);
    message('Καταχωρίστηκε και στάλθηκε στο Firebase.');
  }catch(err){
    updateEvent(e.event_id,{
      state:'ERROR',
      last_error:err.message||String(err)
    });

    message(
      'Αποθηκεύτηκε στη συσκευή και περιμένει συγχρονισμό. '+
      (err.message||'')
    );
  }

  renderHistory();
  refreshConnectionBadge();

  return e;
}


// ============================================================
// ΠΑΡΑΛΑΒΗ
// ============================================================

$('receipt-form').onsubmit=async ev=>{
  ev.preventDefault();

  const f=new FormData(ev.target);
  const supplier=String(f.get('supplier')||'').trim();
  const lot=String(f.get('lot')||'').trim();
  const quantity=Number(f.get('quantity'));

  let total_kg,kg_per_bale=null;

  if(isEcorecovery()){
    kg_per_bale=Number(f.get('kg_per_bale'));
    total_kg=kg_per_bale*quantity;
  }else{
    total_kg=Number(f.get('total_kg'));
  }

  if(
    !supplier||
    !Number.isSafeInteger(quantity)||
    quantity<1||
    quantity>10000||
    !Number.isSafeInteger(total_kg)||
    total_kg<1||
    total_kg>100000000||
    (isEcorecovery()&&(
      !Number.isSafeInteger(kg_per_bale)||
      kg_per_bale<1
    ))
  ){
    message('Έλεγξε προμηθευτή, κιλά και πλήθος bales.');
    return;
  }

  const b=ev.target.querySelector('button[type=submit]');
  b.disabled=true;

  try{
    await createAndTry(
      'RECEIPT',
      {
        supplier,
        lot,
        total_kg,
        quantity,
        ...(kg_per_bale?{kg_per_bale}:{})
      },
      `${supplier} · ${quantity} bales · ${total_kg} kg`
    );

    ev.target.reset();
    supplierMode();

  }finally{
    b.disabled=false;
  }
};


// ============================================================
// ΛΥΣΙΜΟ - QR / BARCODE
// ============================================================

function normalizeScan(raw){
  const v=String(raw||'').trim();

  if(!v)return null;

  const m=v.toUpperCase().match(/BL-\d{8}/);

  if(m)return m[0];

  if(v.length<=80&&/^[A-Za-z0-9._:/-]+$/.test(v)){
    return v.toUpperCase();
  }

  return null;
}

function found(raw){
  const code=normalizeScan(raw);

  if(!code){
    $('camera-status').textContent=
      'Ο κωδικός δεν αναγνωρίστηκε. Δοκίμασε ξανά.';
    return;
  }

  scannedCode=code;
  $('bale-code').textContent=code;
  $('scan-result').hidden=false;
  $('open-submit').disabled=false;
  $('camera-status').textContent='Αναγνωρίστηκε QR / Barcode.';

  stopCamera();
}

async function stopCamera(){
  if(scanner){
    try{
      if(scanning)await scanner.stop();
    }catch(_){}

    try{
      scanner.clear();
    }catch(_){}

    scanner=null;
  }

  scanning=false;
  $('camera-stop').hidden=true;
}

$('camera-start').onclick=async()=>{
  if(!window.isSecureContext){
    $('camera-status').textContent='Η κάμερα απαιτεί HTTPS.';
    return;
  }

  if(!window.Html5Qrcode){
    $('camera-status').textContent=
      'Δεν φορτώθηκε ο scanner. Έλεγξε τη σύνδεση και ξαναφόρτωσε.';
    return;
  }

  scannedCode='';
  $('scan-result').hidden=true;
  $('open-submit').disabled=true;

  await stopCamera();

  try{
    scanner=new Html5Qrcode('qr-reader');

    const F=window.Html5QrcodeSupportedFormats;

    const formats=F?[
      F.QR_CODE,
      F.CODE_128,
      F.CODE_39,
      F.CODE_93,
      F.EAN_13,
      F.EAN_8,
      F.ITF,
      F.UPC_A,
      F.UPC_E
    ].filter(x=>x!==undefined):undefined;

    await scanner.start(
      {facingMode:'environment'},
      {
        fps:12,
        qrbox:{width:280,height:180},
        formatsToSupport:formats
      },
      found,
      ()=>{}
    );

    scanning=true;
    $('camera-stop').hidden=false;
    $('camera-status').textContent=
      'Στόχευσε το QR ή Barcode μέσα στο πλαίσιο.';

  }catch(e){
    $('camera-status').textContent=
      'Η κάμερα δεν άνοιξε: '+e.message;

    await stopCamera();
  }
};

$('camera-stop').onclick=stopCamera;

$('open-submit').onclick=async()=>{
  if(!scannedCode){
    message('Σκάναρε πρώτα QR ή Barcode.');
    return;
  }

  const code=scannedCode;
  const b=$('open-submit');
  b.disabled=true;

  try{
    await createAndTry('OPEN_BALE',{code},code);

    scannedCode='';
    $('scan-result').hidden=true;
    $('bale-code').textContent='';
    $('camera-status').textContent=
      'Σκάναρε τον επόμενο κωδικό.';

  }finally{
    b.disabled=false;
  }
};


// ============================================================
// ΚΑΤΑΣΤΑΣΗ ΣΥΝΔΕΣΗΣ
// ============================================================

function refreshConnectionBadge(){
  const pending=queue().filter(x=>x.state!=='SENT').length;

  $('connection-state').textContent=
    navigator.onLine
      ?(pending
        ?`Online · ${pending} σε αναμονή`
        :'Online · όλα απεστάλησαν')
      :`Offline · ${pending} σε αναμονή`;

  $('connection-state').classList.toggle(
    'offline',
    !navigator.onLine
  );
}

window.addEventListener('online',()=>{
  refreshConnectionBadge();
  loadSuppliers();
  syncPending();
});

window.addEventListener('offline',refreshConnectionBadge);

refreshConnectionBadge();

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
