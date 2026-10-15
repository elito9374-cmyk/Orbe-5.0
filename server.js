const express=require('express');
const cors=require('cors');
const path=require('path');
const fs=require('fs');
const Database=require('better-sqlite3');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const OPENAI_API_KEY=process.env.OPENAI_API_KEY||'';
const OPENAI_MODEL=(process.env.OPENAI_MODEL||'').trim()||'gpt-5.6-luna';
const MODEL_FALLBACKS=['gpt-5.6-luna','gpt-5.5','gpt-5.4'];
let workingModel=null;
const aiHits=new Map();

const app=express();
const PORT=process.env.PORT||3000;
const ORBE_ORIGIN=process.env.ORBE_ORIGIN||'';
function openDb(p){fs.mkdirSync(path.dirname(p),{recursive:true});const d=new Database(p);d.pragma('journal_mode = WAL');return d;}
let DB_PATH=process.env.DB_PATH||path.join(__dirname,'orbe.db');
let db;
try{db=openDb(DB_PATH);}catch(e){console.error('[orbe] Base inaccessible ('+DB_PATH+') : '+e.message+' -> repli sur /tmp (données NON persistantes). Monte un volume Railway sur /data.');DB_PATH='/tmp/orbe.db';db=openDb(DB_PATH);}
const JWT_SECRET=(()=>{if(process.env.JWT_SECRET)return process.env.JWT_SECRET;const f=path.join(path.dirname(DB_PATH),'.jwt_secret');try{const v=fs.readFileSync(f,'utf8').trim();if(v)return v;}catch{}const v=require('crypto').randomBytes(48).toString('hex');try{fs.writeFileSync(f,v,{mode:0o600});}catch{}console.warn('[orbe] JWT_SECRET absent : secret généré automatiquement. Définis JWT_SECRET dans Railway.');return v;})();
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,bio TEXT DEFAULT '',avatar TEXT DEFAULT '',created_at INTEGER NOT NULL);\nCREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,sender_id INTEGER NOT NULL,receiver_id INTEGER NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(sender_id) REFERENCES users(id),FOREIGN KEY(receiver_id) REFERENCES users(id));\nCREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id,receiver_id,created_at);`);
app.use(cors(ORBE_ORIGIN?{origin:ORBE_ORIGIN}:{}));
app.use(express.json({limit:'2mb'}));
app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(),microphone=(),geolocation=()');next()});
function safeUser(u){return {id:u.id,username:u.username,bio:u.bio||'',avatar:u.avatar||''};}
function auth(req,res,next){try{const h=req.headers.authorization||''; if(!h.startsWith('Bearer '))return res.status(401).json({error:'auth'}); req.user=jwt.verify(h.slice(7),JWT_SECRET); next();}catch{return res.status(401).json({error:'auth'});}}

app.get('/health',(req,res)=>{let dbOk=false;try{db.prepare('SELECT 1').get();dbOk=true;}catch{}res.json({ok:true,service:'orbe',ai:Boolean(OPENAI_API_KEY),db:dbOk,persistent:DB_PATH!=='/tmp/orbe.db'});});
app.post('/api/ai/chat',auth,async(req,res)=>{
  const now=Date.now(), key=String(req.user.id), recent=aiHits.get(key)||[];
  const kept=recent.filter(t=>now-t<60000); if(kept.length>=20)return res.status(429).json({error:'Trop de demandes. Réessaie dans une minute.'});
  kept.push(now); aiHits.set(key,kept);
  if(!OPENAI_API_KEY)return res.status(503).json({error:'Orbe IA n’est pas encore configuré sur ce serveur.'});
  const messages=Array.isArray(req.body?.messages)?req.body.messages.slice(-12).map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'').slice(0,1200)})).filter(m=>m.content):[];
  if(!messages.length)return res.status(400).json({error:'Message manquant.'});
  try{
    const instructions=`Tu es Orbe IA, le copilote d’un réseau social destiné notamment aux jeunes. Réponds en français, avec un ton chaleureux, clair et court. Aide à découvrir des centres d’intérêt, lancer des discussions, imaginer des missions de groupe et utiliser Orbe positivement. Ne révèle jamais de données privées sur les membres et n’invente jamais de profil. Ne demande jamais mot de passe, adresse, établissement scolaire, numéro de téléphone, localisation précise ou autre donnée sensible. Encourage les activités en groupe et les lieux publics quand une rencontre réelle est évoquée. Ne prétends pas être humain.`;
    const candidates=[...new Set([workingModel,OPENAI_MODEL,...MODEL_FALLBACKS].filter(Boolean))];
    let lastErr='';
    for(const model of candidates){
      const ctrl=new AbortController(); const to=setTimeout(()=>ctrl.abort(),45000);
      let r,data;
      try{
        r=await fetch('https://api.openai.com/v1/responses',{method:'POST',signal:ctrl.signal,headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_API_KEY}`},body:JSON.stringify({model,instructions,input:messages,max_output_tokens:1500})});
        data=await r.json().catch(()=>({}));
      }finally{clearTimeout(to);}
      if(r.ok){
        const text=(data.output_text||((data.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||'').filter(Boolean).join('\n'))).trim();
        if(text){workingModel=model;return res.json({text});}
        lastErr='réponse vide (status='+(data.status||'?')+')'; continue;
      }
      const em=(data&&data.error&&data.error.message)||('HTTP '+r.status);
      lastErr='HTTP '+r.status+' '+em;
      console.error('[orbe][openai] modèle '+model+' -> '+lastErr);
      if(r.status===401)return res.status(502).json({error:'Clé OpenAI refusée. Vérifie OPENAI_API_KEY dans Railway.'});
      if(r.status===429)return res.status(502).json({error:'Quota OpenAI atteint : vérifie ton solde de crédits OpenAI.'});
      if(r.status===404||r.status===400||(data&&data.error&&data.error.code==='model_not_found'))continue;
      break;
    }
    console.error('[orbe][openai] échec final : '+lastErr);
    return res.status(502).json({error:'Orbe IA est momentanément indisponible. Réessaie dans un instant.'});
  }catch(e){console.error('[orbe][openai] exception : '+e.message);res.status(502).json({error:'Impossible de contacter Orbe IA.'});}
});

app.post('/api/signup',(req,res)=>{const {email,username,password,bio='',avatar=''}=req.body||{}; if(typeof email!=='string'||typeof username!=='string'||typeof password!=='string'||!email||!username||password.length<8||password.length>200||email.length>254||username.length>30)return res.status(400).json({error:'Champs invalides'}); try{const hash=bcrypt.hashSync(password,12);const info=db.prepare('INSERT INTO users(email,username,password_hash,bio,avatar,created_at) VALUES(?,?,?,?,?,?)').run(email.toLowerCase(),username.toLowerCase(),hash,String(bio).slice(0,120),String(avatar).slice(0,500000),Date.now());const u=db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);const token=jwt.sign({id:u.id},JWT_SECRET,{expiresIn:'30d'});res.json({token,user:safeUser(u)});}catch(e){res.status(400).json({error:'E-mail ou pseudo déjà utilisé'});}});
app.post('/api/login',(req,res)=>{const {login,password}=req.body||{};const u=db.prepare('SELECT * FROM users WHERE email=? OR username=?').get(String(login||'').toLowerCase(),String(login||'').replace(/^@/,'').toLowerCase());if(!u||!bcrypt.compareSync(String(password||''),u.password_hash))return res.status(401).json({error:'Identifiants incorrects'});res.json({token:jwt.sign({id:u.id},JWT_SECRET,{expiresIn:'30d'}),user:safeUser(u)});});
app.get('/api/me',auth,(req,res)=>{const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);res.json({user:safeUser(u)});});
app.get('/api/users/search',auth,(req,res)=>{const q=String(req.query.q||'').trim().toLowerCase();let rows=q?db.prepare("SELECT id,username,bio,avatar FROM users WHERE id<>? AND (username LIKE ? OR bio LIKE ?) ORDER BY username LIMIT 50").all(req.user.id,`%${q}%`,`%${q}%`):db.prepare('SELECT id,username,bio,avatar FROM users WHERE id<>? ORDER BY created_at DESC LIMIT 50').all(req.user.id);res.json({users:rows});});
app.get('/api/messages/:userId',auth,(req,res)=>{const id=Number(req.params.userId);const rows=db.prepare('SELECT id,sender_id AS senderId,receiver_id AS receiverId,text,created_at AS createdAt FROM messages WHERE (sender_id=? AND receiver_id=?) OR (sender_id=? AND receiver_id=?) ORDER BY created_at ASC LIMIT 500').all(req.user.id,id,id,req.user.id);res.json({messages:rows});});
app.post('/api/messages/:userId',auth,(req,res)=>{const id=Number(req.params.userId);const text=String(req.body?.text||'').trim();if(!text||text.length>500)return res.status(400).json({error:'Message invalide'});const exists=db.prepare('SELECT id FROM users WHERE id=?').get(id);if(!exists)return res.status(404).json({error:'Utilisateur introuvable'});const info=db.prepare('INSERT INTO messages(sender_id,receiver_id,text,created_at) VALUES(?,?,?,?)').run(req.user.id,id,text,Date.now());res.json({id:info.lastInsertRowid});});
app.get('/api/conversations',auth,(req,res)=>{const rows=db.prepare(`SELECT u.id,u.username,u.bio,u.avatar, m.text,m.created_at AS createdAt FROM users u JOIN messages m ON (m.sender_id=u.id AND m.receiver_id=?) OR (m.receiver_id=u.id AND m.sender_id=?) WHERE m.id IN (SELECT MAX(id) FROM messages WHERE sender_id=? OR receiver_id=? GROUP BY CASE WHEN sender_id=? THEN receiver_id ELSE sender_id END) ORDER BY m.created_at DESC`).all(req.user.id,req.user.id,req.user.id,req.user.id,req.user.id);res.json({conversations:rows});});
const PUBLIC_DIR=path.join(__dirname,'public');
const INDEX_FILE=[path.join(PUBLIC_DIR,'index.html'),path.join(__dirname,'index.html')].find(f=>fs.existsSync(f));
if(fs.existsSync(PUBLIC_DIR))app.use(express.static(PUBLIC_DIR));
app.use('/api',(req,res)=>res.status(404).json({error:'not_found'}));
app.get('*',(req,res)=>INDEX_FILE?res.sendFile(INDEX_FILE):res.status(503).send('index.html manquant à la racine du dépôt'));
app.use((err,req,res,next)=>{if(res.headersSent)return next(err);const big=err&&err.type==='entity.too.large';const bad=err&&(err.type==='entity.parse.failed'||err.status===400);console.error('[orbe] erreur',req.method,req.path,err&&err.message);res.status(big?413:bad?400:500).json({error:big?'Contenu trop volumineux':bad?'Requête invalide':'Erreur serveur'});});
setInterval(()=>{const now=Date.now();for(const [k,v] of aiHits){if(!v.some(t=>now-t<60000))aiHits.delete(k);}},300000).unref();
const server=app.listen(PORT,'0.0.0.0',()=>console.log(`Orbe running on port ${PORT} (db: ${DB_PATH})`));
server.keepAliveTimeout=65000;server.headersTimeout=66000;
process.on('unhandledRejection',e=>console.error('[orbe] unhandledRejection',e));
process.on('uncaughtException',e=>console.error('[orbe] uncaughtException',e));
function shutdown(){server.close(()=>{try{db.close();}catch{}process.exit(0);});setTimeout(()=>process.exit(0),8000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
