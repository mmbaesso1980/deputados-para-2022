/**
 * FiscalizaPA - Core Module v2.0
 * Sistema de creditos, cache IA, parecer tecnico, CPV, logging
 * Firestore: fiscallizapa.firebaseapp.com
 * SEM TRIAL - 150 creditos no primeiro login
 */

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
  if (firebase.apps.length) firebase.app(); else firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.firestore();
} catch(e) { console.warn('Firebase init:', e); }

// ========== CONFIG ==========
const WELCOME_CREDITS = 150;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const GEMINI_KEY = 'AIzaSyDuII-aOUbsrVv3H-Qb_0XSe1XLV97Da24';

const CREDIT_COSTS = {
  perfil_basico: 0,
  analise_gastos: 5,
  investigar_notas: 5,
  chat_pergunta: 3,
  chat_cache_hit: 1,
  parecer_tecnico: 8,
  cpv_analise: 3
};

const TERMOS_PROIBIDOS = ['fraude','desvio','corrupcao','crime','ilegalidade comprovada','desonesto'];
const TERMOS_PERMITIDOS = ['indicio','divergencia','inconsistencia','variacao estatistica','padrao atipico','inconformidade preliminar'];

// ========== CREDIT SYSTEM (NO TRIAL) ==========
async function initUserCredits(userId) {
  if (!db || !userId) return { credits: WELCOME_CREDITS };
  try {
    var ref = db.collection('credit_wallets').doc(userId);
    var doc = await ref.get();
    if (!doc.exists) {
      var data = { credits: WELCOME_CREDITS, total_used: 0, created_at: firebase.firestore.FieldValue.serverTimestamp(), is_premium: false, plan: 'free' };
      await ref.set(data);
      return { credits: WELCOME_CREDITS };
    }
    return { credits: doc.data().credits || 0, is_premium: doc.data().is_premium || false, plan: doc.data().plan || 'free' };
  } catch(e) { console.warn('initUserCredits:', e); return { credits: WELCOME_CREDITS }; }
}

async function consumeCredits(userId, amount, action) {
  if (!db || !userId) return false;
  try {
    var ref = db.collection('credit_wallets').doc(userId);
    var doc = await ref.get();
    if (!doc.exists) return false;
    var current = doc.data().credits || 0;
    if (current < amount) return false;
    await ref.update({ credits: firebase.firestore.FieldValue.increment(-amount), total_used: firebase.firestore.FieldValue.increment(amount) });
    await db.collection('credit_transactions').add({ user_id: userId, amount: -amount, action: action, balance_after: current - amount, created_at: firebase.firestore.FieldValue.serverTimestamp() });
    return true;
  } catch(e) { console.warn('consumeCredits:', e); return false; }
}

async function addCredits(userId, amount, source) {
  if (!db || !userId) return;
  try {
    var ref = db.collection('credit_wallets').doc(userId);
    await ref.update({ credits: firebase.firestore.FieldValue.increment(amount) });
    await db.collection('credit_transactions').add({ user_id: userId, amount: amount, source: source, created_at: firebase.firestore.FieldValue.serverTimestamp() });
  } catch(e) { console.warn('addCredits:', e); }
}

// ========== LOGGING ==========
async function logAIRequest(userId, deputyId, type, prompt, tokens) {
  if (!db) return;
  try { await db.collection('ai_requests_log').add({ user_id: userId||'anon', deputy_id: deputyId, type: type, prompt_summary: (prompt||'').substring(0,200), tokens: tokens||0, created_at: firebase.firestore.FieldValue.serverTimestamp() }); } catch(e) {}
}

async function logSession(userId, page, deputyId) {
  if (!db) return;
  try { await db.collection('user_sessions').add({ user_id: userId||'anon', page: page, deputy_id: deputyId||null, ua: navigator.userAgent, ref: document.referrer, created_at: firebase.firestore.FieldValue.serverTimestamp() }); } catch(e) {}
}

// ========== IA CACHE SYSTEM ==========
function hashQuestion(q) {
  var h = 0; q = q.toLowerCase().trim();
  for (var i = 0; i < q.length; i++) { h = ((h << 5) - h) + q.charCodeAt(i); h |= 0; }
  return 'q_' + Math.abs(h).toString(36);
}

async function findCachedAnswer(question, deputyId) {
  if (!db) return null;
  try {
    var hash = hashQuestion(question + '_' + (deputyId||''));
    var doc = await db.collection('ia_cache').doc(hash).get();
    if (doc.exists) {
      await db.collection('ia_cache').doc(hash).update({ hit_count: firebase.firestore.FieldValue.increment(1) });
      return doc.data();
    }
    return null;
  } catch(e) { return null; }
}

async function saveCacheAnswer(question, answer, deputyId, related) {
  if (!db) return;
  try {
    var hash = hashQuestion(question + '_' + (deputyId||''));
    await db.collection('ia_cache').doc(hash).set({
      question: question, answer: answer, deputy_id: deputyId||null,
      related_questions: related||[], hit_count: 1,
      created_at: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) {}
}

// ========== GEMINI IA CALLS ==========
async function callGemini(prompt) {
  try {
    var res = await fetch(GEMINI_API_URL + '?key=' + GEMINI_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    var data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sem resposta da IA';
  } catch(e) { return 'Erro na IA: ' + e.message; }
}

function buildParecerPrompt(deputyName, gastosData) {
  return 'Voce e um analista tecnico senior de fiscalizacao de recursos publicos atuando sob os principios constitucionais da Administracao Publica (legalidade, impessoalidade, moralidade, publicidade e eficiencia - art. 37, CF/88). Produza PARECER TECNICO PRELIMINAR.\n\nDeputado: ' + deputyName + '\nDados CEAP: ' + JSON.stringify(gastosData).substring(0,3000) + '\n\nEstrutura obrigatoria:\n1. IDENTIFICACAO DO DOCUMENTO\n2. DESCRICAO TECNICA DA DESPESA\n3. ANALISE COMPARATIVA QUANTITATIVA (tabela com Indicador, Valor Atual, Referencia, Desvio)\n4. INDICIOS IDENTIFICADOS (linguagem neutra: divergencia, inconsistencia, padrao atipico)\n5. ANALISE DE REGULARIDADE FORMAL (checklist)\n6. PARECER TECNICO PRELIMINAR com ressalvas\n7. RECOMENDACAO DE ACOMPANHAMENTO\n8. FUNDAMENTACAO LEGAL (art.37 CF, LC101/2000, Lei 8666)\n\nRESTRICOES: NUNCA use fraude, desvio, corrupcao, crime. SEMPRE use indicio, divergencia, inconsistencia. SEMPRE indique analise preliminar baseada em dados publicos. Formato HTML com classes para dark theme.';
}

function buildInvestigacaoPrompt(deputyName, notasData) {
  return 'Investigue estas notas fiscais do deputado ' + deputyName + ': ' + JSON.stringify(notasData).substring(0,2000) + '. Verifique: 1) Valor compativel com servico 2) Concentracao em fornecedor unico 3) Periodicidade atipica 4) Divergencia com mercado. Use linguagem tecnica neutra (indicio, divergencia, padrao atipico). NUNCA acuse diretamente. Inclua ressalvas metodologicas. Formato HTML dark theme.';
}

// ========== CHAT IA WITH CACHE ==========
async function chatIA(userId, question, deputyName, deputyId, gastosData) {
  var cached = await findCachedAnswer(question, deputyId);
  if (cached) {
    await consumeCredits(userId, CREDIT_COSTS.chat_cache_hit, 'chat_cache');
    return { answer: cached.answer, from_cache: true, related: cached.related_questions || [], credits_used: CREDIT_COSTS.chat_cache_hit };
  }
  var ok = await consumeCredits(userId, CREDIT_COSTS.chat_pergunta, 'chat_new');
  if (!ok) return { answer: null, error: 'sem_creditos' };
  var prompt = 'Voce e analista fiscal do FiscalizaPA. Responda sobre o deputado ' + (deputyName||'') + '. Dados CEAP disponiveis: ' + JSON.stringify(gastosData||{}).substring(0,2000) + '. Pergunta do cidadao: ' + question + '. Responda em HTML formatado para dark theme. Ao final, sugira 3 perguntas relacionadas em formato JSON array. Use linguagem tecnica neutra (indicio, divergencia). NUNCA acuse diretamente.';
  var answer = await callGemini(prompt);
  var related = [];
  try { var m = answer.match(/\[.*?\]/s); if (m) related = JSON.parse(m[0]); } catch(e) {}
  answer = validateContent(answer);
  await saveCacheAnswer(question, answer, deputyId, related);
  await logAIRequest(userId, deputyId, 'chat', question, 500);
  return { answer: answer, from_cache: false, related: related, credits_used: CREDIT_COSTS.chat_pergunta };
}

// ========== CONTENT VALIDATION ==========
function validateContent(text) {
  var clean = text;
  TERMOS_PROIBIDOS.forEach(function(t) {
    var re = new RegExp(t, 'gi');
    clean = clean.replace(re, '[termo removido]');
  });
  if (clean.indexOf('RESSALVAS') < 0 && clean.indexOf('ressalvas') < 0) {
    clean += '<div style="margin-top:15px;padding:12px;border:1px solid #555;border-radius:8px;font-size:0.85em;color:#aaa;"><strong>RESSALVAS:</strong> Analise preliminar baseada em dados publicos. Nao substitui auditoria do TCU/TCE. Eventual irregularidade depende de comprovacao em processo administrativo.</div>';
  }
  return clean;
}

// ========== LOGGING ==========
async function logAIRequest(userId, deputyId, type, prompt, tokens) {
  if (!db) return;
  try {
    await db.collection('ai_requests_log').add({
      user_id: userId || 'anonymous',
      deputy_id: deputyId || null,
      type: type,
      prompt_preview: (prompt || '').substring(0, 200),
      tokens_estimated: tokens || 0,
      created_at: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) { console.warn('logAIRequest:', e); }
}

async function logSession(userId, page, action) {
  if (!db) return;
  try {
    await db.collection('user_sessions').add({
      user_id: userId || 'anonymous',
      page: page,
      action: action,
      user_agent: navigator.userAgent,
      created_at: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) {}
}

// ========== STRIPE ==========
const STRIPE_LINKS = {
  creditos_1000: 'https://buy.stripe.com/test_eVqbJ11b06LZfM21z0Ny01',
  mensal_3990: '',
  anual_35000: ''
};

function openStripePurchase(type) {
  var link = STRIPE_LINKS[type];
  if (link) window.open(link, '_blank');
  else alert('Link de pagamento indisponivel');
}

// ========== RANKING ==========
function calcularRanking(deputyData, allDeputiesData) {
  if (!deputyData || !allDeputiesData || allDeputiesData.length === 0) return null;
  var gastoTotal = deputyData.gastoTotal || 0;
  var presenca = deputyData.presenca || 0;
  var proposicoes = deputyData.proposicoes || 0;
  var scores = allDeputiesData.map(function(d) {
    var g = Math.max(0, 10 - ((d.gastoTotal || 0) / 100000));
    var p = (d.presenca || 0) / 10;
    var pr = Math.min(10, (d.proposicoes || 0) * 2);
    return (g * 0.3 + p * 0.4 + pr * 0.3);
  }).sort(function(a, b) { return a - b; });
  var myG = Math.max(0, 10 - (gastoTotal / 100000));
  var myP = presenca / 10;
  var myPr = Math.min(10, proposicoes * 2);
  var myScore = (myG * 0.3 + myP * 0.4 + myPr * 0.3);
  var percentil = 0;
  for (var i = 0; i < scores.length; i++) {
    if (myScore >= scores[i]) percentil = ((i + 1) / scores.length * 100);
  }
  return {
    score: myScore.toFixed(1),
    percentil: Math.round(percentil),
    label: myScore >= 7 ? 'Bom desempenho' : myScore >= 5 ? 'Desempenho mediano' : 'Abaixo da media'
  };
}

// ========== PROPOSICOES FILTER ==========
function filtrarProposicoesAutorPrincipal(proposicoes, deputyName) {
  if (!proposicoes || !deputyName) return [];
  var tiposValidos = ['PL', 'PLP', 'PEC', 'PDL', 'MPV'];
  return proposicoes.filter(function(p) {
    var tipoOk = tiposValidos.some(function(t) { return (p.siglaTipo || '').toUpperCase() === t; });
    var autorOk = (p.autores || []).some(function(a) {
      return a.ordemAssinatura === 1 && (a.nome || '').toLowerCase().indexOf(deputyName.toLowerCase()) >= 0;
    });
    return tipoOk && autorOk;
  });
}

// ========== PARECER TECNICO ==========
async function gerarParecerTecnico(userId, deputyName, deputyId, gastosData) {
  var ok = await consumeCredits(userId, CREDIT_COSTS.parecer_tecnico, 'parecer_tecnico');
  if (!ok) return { answer: null, error: 'sem_creditos' };
  var prompt = buildParecerPrompt(deputyName, gastosData);
  var answer = await callGemini(prompt);
  answer = validateContent(answer);
  await logAIRequest(userId, deputyId, 'parecer', prompt.substring(0, 200), 1000);
  return { answer: answer, credits_used: CREDIT_COSTS.parecer_tecnico };
}

async function investigarNotas(userId, deputyName, deputyId, notasData) {
  var ok = await consumeCredits(userId, CREDIT_COSTS.investigar_notas, 'investigar_notas');
  if (!ok) return { answer: null, error: 'sem_creditos' };
  var prompt = buildInvestigacaoPrompt(deputyName, notasData);
  var answer = await callGemini(prompt);
  answer = validateContent(answer);
  await logAIRequest(userId, deputyId, 'investigacao', prompt.substring(0, 200), 800);
  return { answer: answer, credits_used: CREDIT_COSTS.investigar_notas };
}

// ========== CPV ANALYSIS ==========
async function analiseCPV(userId, deputyName, deputyId, gastosCategoria) {
  var ok = await consumeCredits(userId, CREDIT_COSTS.cpv_analise, 'cpv_analise');
  if (!ok) return { answer: null, error: 'sem_creditos' };
  var prompt = 'Analise o Custo Por Voto (CPV) do deputado ' + deputyName + '. Dados de gastos por categoria: ' + JSON.stringify(gastosCategoria).substring(0, 2000) + '. Calcule o CPV dividindo o gasto total pela votacao recebida. Compare com a media nacional. Identifique categorias com maior gasto relativo. Use linguagem tecnica neutra. Formato HTML dark theme com tabelas.';
  var answer = await callGemini(prompt);
  answer = validateContent(answer);
  await logAIRequest(userId, deputyId, 'cpv', prompt.substring(0, 200), 600);
  return { answer: answer, credits_used: CREDIT_COSTS.cpv_analise };
}

// ========== EXPORTS ==========
window.FiscalizaCore = {
  initUserCredits: initUserCredits,
  consumeCredits: consumeCredits,
  addCredits: addCredits,
  chatIA: chatIA,
  gerarParecerTecnico: gerarParecerTecnico,
  investigarNotas: investigarNotas,
  analiseCPV: analiseCPV,
  calcularRanking: calcularRanking,
  filtrarProposicoesAutorPrincipal: filtrarProposicoesAutorPrincipal,
  validateContent: validateContent,
  logSession: logSession,
  openStripePurchase: openStripePurchase,
  CREDIT_COSTS: CREDIT_COSTS,
  STRIPE_LINKS: STRIPE_LINKS
};
