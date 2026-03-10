/**
 * FiscalizaPA - Core Module
 * Sistema de creditos, logging, IA e utils
 * Firestore: fiscallizapa.firebaseapp.com
 */

// ============ FIREBASE FIRESTORE INIT ============
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDuII-aOUbsrVv3H-Qb_0XSe1XLV97Da24',
  authDomain: 'fiscallizapa.firebaseapp.com',
  projectId: 'fiscallizapa',
  storageBucket: 'fiscallizapa.firebasestorage.app',
  messagingSenderId: '993207283220',
  appId: '1:993207283220:web:b58b551b41104a3ada0101'
};

let db = null;
try {
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.firestore();
} catch(e) { console.warn('Firestore init:', e); }



// ============ CREDIT SYSTEM ============
const FREE_DAILY_CREDITS = 20;
const CREDITS_PER_DEPUTY = 10;

async function getUserCredits(userId) {
  if (!db || !userId) return { free: FREE_DAILY_CREDITS, paid: 0 };
  try {
    const walletRef = db.collection('credit_wallets').doc(userId);
    const doc = await walletRef.get();
    if (!doc.exists) {
      const today = new Date().toISOString().split('T')[0];
      const initial = { free_credits: FREE_DAILY_CREDITS, paid_credits: 0, last_reset: today, total_used: 0 };
      await walletRef.set(initial);
      return { free: FREE_DAILY_CREDITS, paid: 0 };
    }
    const data = doc.data();
    const today = new Date().toISOString().split('T')[0];
    if (data.last_reset !== today) {
      await walletRef.update({ free_credits: FREE_DAILY_CREDITS, last_reset: today });
      return { free: FREE_DAILY_CREDITS, paid: data.paid_credits || 0 };
    }
    return { free: data.free_credits || 0, paid: data.paid_credits || 0 };
  } catch(e) { console.warn('getUserCredits:', e); return { free: FREE_DAILY_CREDITS, paid: 0 }; }
}

async function consumeCredits(userId, amount) {
  if (!db || !userId) return false;
  try {
    const walletRef = db.collection('credit_wallets').doc(userId);
    const doc = await walletRef.get();
    if (!doc.exists) return false;
    const data = doc.data();
    let freeC = data.free_credits || 0;
    let paidC = data.paid_credits || 0;
    if (freeC + paidC < amount) return false;
    let remaining = amount;
    if (freeC >= remaining) { freeC -= remaining; remaining = 0; }
    else { remaining -= freeC; freeC = 0; paidC -= remaining; }
    await walletRef.update({ free_credits: freeC, paid_credits: paidC, total_used: firebase.firestore.FieldValue.increment(amount) });
    return true;
  } catch(e) { console.warn('consumeCredits:', e); return false; }
}

// ============ LOGGING SYSTEM ============
async function logAIRequest(userId, deputyId, type, prompt, tokens) {
  if (!db) return;
  try {
    await db.collection('ai_requests_log').add({
      user_id: userId || 'anonymous',
      deputy_id: deputyId,
      request_type: type,
      prompt_summary: prompt.substring(0, 200),
      tokens_used: tokens || 0,
      created_at: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) { console.warn('logAIRequest:', e); }
}

async function logSession(userId, page, deputyId) {
  if (!db) return;
  try {
    await db.collection('user_sessions').add({
      user_id: userId || 'anonymous',
      page: page,
      deputy_id: deputyId || null,
      user_agent: navigator.userAgent,
      referrer: document.referrer,
      created_at: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) { console.warn('logSession:', e); }
}

// ============ AI ANALYSIS (Gemini) ============
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function analyzeGastos(deputyName, gastosData, apiKey) {
  const prompt = `Analise os gastos do deputado ${deputyName}. Dados: ${JSON.stringify(gastosData).substring(0,3000)}. Retorne: 1) Resumo geral 2) Top 5 categorias com valores 3) Alertas de gastos atipicos 4) Perguntas investigativas. Formato HTML com classes Bootstrap.`;
  try {
    const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem resposta';
    return text;
  } catch(e) { return '<p class="text-danger">Erro na analise IA: ' + e.message + '</p>'; }
}

async function investigarNota(deputyName, notaData, apiKey) {
  const prompt = `Investigue esta nota fiscal do deputado ${deputyName}: ${JSON.stringify(notaData).substring(0,2000)}. Verifique: 1) Valor compativel com o servico 2) Fornecedor existe 3) Data e local fazem sentido com agenda. Formato HTML.`;
  try {
    const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem resposta';
  } catch(e) { return '<p class="text-danger">Erro: ' + e.message + '</p>'; }
}

// ============ RANKING & PROPOSITIONS ============
function calcRanking(deputy, allDeputies) {
  const score = deputy.score || 5;
  const betterThan = allDeputies ? Math.round((allDeputies.filter(d => (d.score||5) <= score).length / allDeputies.length) * 100) : 50;
  return { score: score.toFixed(1), percentil: betterThan };
}

function renderRanking(score, percentil) {
  const color = score >= 7 ? '#28a745' : score >= 4 ? '#ffc107' : '#dc3545';
  return `<div class="ranking-badge" style="background:${color};color:#fff;padding:10px 20px;border-radius:10px;display:inline-block;font-size:1.2em;font-weight:bold;">
    ${score}/10 &mdash; melhor que ${percentil}% dos deputados federais
  </div>`;
}

const TIPOS_PROPOSICAO_AUTOR = ['PL', 'PLP', 'PEC', 'PDL', 'MPV', 'DEC'];

function filterProposicoes(proposicoes, deputyId) {
  return proposicoes.filter(p => {
    const tipo = (p.siglaTipo || '').toUpperCase();
    if (!TIPOS_PROPOSICAO_AUTOR.includes(tipo)) return false;
    if (p.idDeputadoAutor && p.idDeputadoAutor == deputyId) return true;
    if (p.autores && Array.isArray(p.autores)) {
      const first = p.autores[0];
      if (first && first.uri && first.uri.includes('/' + deputyId)) return true;
    }
    return true;
  });
}

// ============ UI HELPERS ============
function renderCreditBar(free, paid) {
  const total = free + paid;
  const pct = Math.round((total / (FREE_DAILY_CREDITS + paid)) * 100) || 0;
  const color = pct > 50 ? '#28a745' : pct > 20 ? '#ffc107' : '#dc3545';
  return `<div class="credit-bar" style="margin:10px 0;">
    <div style="display:flex;justify-content:space-between;font-size:0.9em;">
      <span>Creditos: ${total} restantes</span>
      <span>${free} gratuitos | ${paid} pagos</span>
    </div>
    <div style="background:#e9ecef;border-radius:5px;height:8px;margin-top:4px;">
      <div style="background:${color};width:${pct}%;height:100%;border-radius:5px;"></div>
    </div>
  </div>`;
}

function showPaywall() {
  return `<div class="paywall-box" style="background:#fff3cd;border:1px solid #ffc107;border-radius:10px;padding:20px;text-align:center;margin:20px 0;">
    <h4>Creditos esgotados!</h4>
    <p>Voce usou seus ${FREE_DAILY_CREDITS} creditos gratuitos de hoje.</p>
    <p>Volte amanha ou adquira creditos extras:</p>
    <a href="conta.html" class="btn btn-success btn-lg">Comprar Creditos</a>
    <p class="mt-2"><small>Pacote 1.000 creditos por R$ 49</small></p>
  </div>`;
}

// ============ INIT ============
function initFiscalizaCore(page, deputyId) {
  logSession(null, page, deputyId);
  console.log('FiscalizaPA Core loaded v1.0');
}

// Export for global use
window.FiscalizaPA = {
  getUserCredits, consumeCredits,
  logAIRequest, logSession,
  analyzeGastos, investigarNota,
  calcRanking, renderRanking,
  filterProposicoes, renderCreditBar,
  showPaywall, initFiscalizaCore,
  FREE_DAILY_CREDITS, CREDITS_PER_DEPUTY
};
