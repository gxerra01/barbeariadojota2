/* Barbearia do Jota — versão Cloudflare Workers.
   - Os arquivos do site (public/) são servidos pela Cloudflare.
   - A API (/api/*) roda num Durable Object: um único "cérebro" com banco SQLite embutido,
     que processa um pedido por vez — por isso nunca existem 2 agendamentos no mesmo horário. */

const OFFSET_MIN = -180;                 // America/Sao_Paulo (UTC-3, sem horário de verão)
const SESSION_DAYS = 30;
const MIN_CANCEL_MS = 2 * 3600 * 1000;   // cliente cancela até 2h antes

const DEFAULT_CONFIG = {
  shop: { since: 2018, phone: '(11) 98974-5632', whatsapp: '5511989745632', instagram: 'barbeariadojota', email: 'contato@barbeariadojota.com.br', address: 'Rua Serafim, 260', city: 'Centro – São Paulo/SP' },
  daysAhead: 30,
  hours: [
    { open: false, from: '09:00', to: '17:00', bs: '', be: '' },
    { open: true, from: '09:00', to: '19:00', bs: '', be: '' },
    { open: true, from: '09:00', to: '19:00', bs: '', be: '' },
    { open: true, from: '09:00', to: '19:00', bs: '', be: '' },
    { open: true, from: '09:00', to: '19:00', bs: '', be: '' },
    { open: true, from: '09:00', to: '19:00', bs: '', be: '' },
    { open: true, from: '09:00', to: '17:00', bs: '', be: '' }
  ],
  services: [
    { id: 'corte', name: 'Corte', desc: 'Degradê, social, navalhado ou o que você quiser — com acabamento na navalha.', price: 45, dur: 30, active: true },
    { id: 'barba', name: 'Barba', desc: 'Modelagem completa com toalha quente e produtos hidratantes.', price: 35, dur: 30, active: true },
    { id: 'sobr', name: 'Sobrancelha', desc: 'Design na navalha ou pinça, mantendo o visual natural.', price: 20, dur: 30, active: true },
    { id: 'combo', name: 'Corte + Barba', desc: 'O combo clássico: cabelo e barba alinhados na mesma visita.', price: 70, dur: 60, active: true },
    { id: 'full', name: 'Corte + Barba + Sobrancelha', desc: 'Pacote completo para sair da cadeira pronto para qualquer ocasião.', price: 85, dur: 60, active: true },
    { id: 'pezinho', name: 'Pezinho / Acabamento', desc: 'Retoque rápido nos contornos para manter o corte em dia.', price: 15, dur: 30, active: true }
  ]
};

/* ---------- utilidades (datas em "horário de parede" de São Paulo, via UTC deslocado) ---------- */
const clone = o => JSON.parse(JSON.stringify(o));
const pad = n => String(n).padStart(2, '0');
const wallNow = () => Date.now() + OFFSET_MIN * 60000;
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d)); return (x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d) ? x : null; };
const toMin = s => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const fmtMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const slotKey = (date, min) => `${date}_${pad(Math.floor(min / 60))}${pad(min % 60)}`;
const slotStart = (d, min) => d.getTime() + min * 60000;
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const digits = s => String(s || '').replace(/\D/g, '');
const emailOk = e => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 100;
const enc = new TextEncoder();
const buf2hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const hex2buf = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const rnd = n => buf2hex(crypto.getRandomValues(new Uint8Array(n)));
const uid = () => rnd(6);
async function sha(s) { return buf2hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hashPw(pw, saltHex) {
  const salt = saltHex ? hex2buf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { salt: buf2hex(salt), hash: buf2hex(bits) };
}
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function checkPw(pw, u) { return safeEq((await hashPw(pw, u.salt)).hash, u.hash); }
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function daySlots(cfg, date) {
  const hr = cfg.hours[date.getUTCDay()]; if (!hr || !hr.open) return [];
  const end = toMin(hr.to), bs = hr.bs ? toMin(hr.bs) : null, be = hr.be ? toMin(hr.be) : null, out = [];
  for (let t = toMin(hr.from); t + 30 <= end; t += 30) { if (bs != null && be != null && t < be && t + 30 > bs) continue; out.push(t); }
  return out;
}
const parseCookies = req => { const o = {}; (req.headers.get('Cookie') || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; };
const publicUser = u => u && ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, mustChangePassword: !!u.mustChange });
const bookingView = b => ({ id: b.id, date: b.date, time: b.time, start: b.start, dur: b.dur, slots: b.slots, services: b.services, total: b.total, name: b.name, phone: b.phone, source: b.source, createdAt: b.createdAt });
const need = (u, role) => { if (!u) throw new HttpError(401, 'Faça login para continuar.'); if (role && u.role !== role) throw new HttpError(403, 'Acesso restrito.'); return u; };

const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' };

/* ---------- entrada: encaminha /api/* ao Durable Object ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return env.BARBEARIA.get(env.BARBEARIA.idFromName('principal')).fetch(req);
    return env.ASSETS.fetch(req);
  }
};

/* ---------- o "cérebro": banco + regras ---------- */
export class Barbearia {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.attempts = new Map();
    this.users = []; this.bookings = []; this.blocks = {}; this.sessions = {}; this.config = null;
    ctx.blockConcurrencyWhile(() => this.load());
  }
  put(k, v) { return this.ctx.storage.put(k, v); }
  del(k) { return this.ctx.storage.delete(k); }

  async load() {
    const all = await this.ctx.storage.list();
    for (const [k, v] of all) {
      if (k === 'config') this.config = v;
      else if (k.startsWith('u:')) this.users.push(v);
      else if (k.startsWith('b:')) this.bookings.push(v);
      else if (k.startsWith('k:')) this.blocks[k.slice(2)] = v;
      else if (k.startsWith('s:')) this.sessions[k.slice(2)] = v;
    }
    if (!this.config) { this.config = clone(DEFAULT_CONFIG); await this.put('config', this.config); }
    for (const k in this.sessions) if (this.sessions[k].exp < Date.now()) { delete this.sessions[k]; await this.del('s:' + k); }
    if (!this.users.some(u => u.role === 'admin')) {
      const email = (this.env.ADMIN_EMAIL || 'admin@barbeariadojota.com').toLowerCase();
      const pw = this.env.ADMIN_PASSWORD || 'admin123';
      const u = Object.assign({ id: uid(), name: 'Jota (Administrador)', email, phone: '', role: 'admin', createdAt: Date.now(), mustChange: !this.env.ADMIN_PASSWORD }, await hashPw(pw));
      this.users.push(u); await this.put('u:' + u.id, u);
    }
  }

  slotMap() {
    const m = {};
    for (const b of this.bookings) for (const k of b.slots) m[k] = { type: 'booking', bid: b.id };
    for (const k in this.blocks) m[k] = { type: 'block', note: this.blocks[k] };
    return m;
  }
  async currentUser(req) {
    const t = parseCookies(req).sid; if (!t) return null;
    const h = await sha(t), s = this.sessions[h]; if (!s) return null;
    if (s.exp < Date.now()) { delete this.sessions[h]; await this.del('s:' + h); return null; }
    return this.users.find(u => u.id === s.uid) || null;
  }
  async newSession(userId) {
    const token = rnd(32), h = await sha(token);
    this.sessions[h] = { uid: userId, exp: Date.now() + SESSION_DAYS * 864e5 }; await this.put('s:' + h, this.sessions[h]);
    return token;
  }
  rateLimit(req) {
    const ip = req.headers.get('CF-Connecting-IP') || '?', now = Date.now();
    let a = this.attempts.get(ip); if (!a || a.reset < now) a = { n: 0, reset: now + 10 * 60 * 1000 };
    a.n++; this.attempts.set(ip, a);
    if (a.n > 15) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  }

  async makeBooking({ date, start, serviceIds, name, phone, userId, source }, admin) {
    const cfg = this.config;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Data inválida.');
    const d = parseYmd(date); if (!d) throw new HttpError(400, 'Data inválida.');
    start = +start; if (!Number.isInteger(start) || start % 30 !== 0) throw new HttpError(400, 'Horário inválido.');
    if (!Array.isArray(serviceIds) || !serviceIds.length || serviceIds.length > 10) throw new HttpError(400, 'Escolha ao menos um serviço.');
    const sv = [...new Set(serviceIds)].map(id => cfg.services.find(s => s.id === id && s.active));
    if (sv.some(x => !x)) throw new HttpError(400, 'Serviço indisponível.');
    const dur = sv.reduce((a, s) => a + s.dur, 0), blocks = Math.max(1, Math.ceil(dur / 30));
    if (!admin) {
      const n = new Date(wallNow()), today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
      const diff = Math.round((d.getTime() - today) / 864e5);
      if (diff < 0 || diff >= cfg.daysAhead) throw new HttpError(400, 'Data fora do período de agendamento.');
    }
    const open = new Set(daySlots(cfg, d)), occ = this.slotMap(), keys = [];
    for (let i = 0; i < blocks; i++) {
      const t = start + 30 * i;
      if (!open.has(t)) throw new HttpError(400, 'Horário fora do expediente.');
      if (!admin && slotStart(d, t) <= wallNow()) throw new HttpError(400, 'Esse horário já passou.');
      const k = slotKey(date, t);
      if (occ[k]) throw new HttpError(409, 'Esse horário acabou de ser ocupado. Escolha outro.');
      keys.push(k);
    }
    const b = { id: uid(), date, time: fmtMin(start), start, dur: blocks * 30, slots: keys,
      services: sv.map(s => ({ id: s.id, name: s.name, price: s.price, dur: s.dur })),
      total: sv.reduce((a, s) => a + s.price, 0), name, phone, userId: userId || null, source, createdAt: Date.now() };
    this.bookings.push(b); await this.put('b:' + b.id, b); return b;
  }

  sanitizeConfig(c) {
    if (!c || typeof c !== 'object') throw new HttpError(400, 'Dados inválidos.');
    const base = this.config, s = c.shop || {};
    const out = { shop: {}, daysAhead: Math.max(1, Math.min(90, parseInt(c.daysAhead, 10) || base.daysAhead)), hours: [], services: [] };
    const lim = { phone: 20, whatsapp: 20, instagram: 40, email: 80, address: 80, city: 80 };
    for (const k in lim) out.shop[k] = clip(s[k] != null ? s[k] : base.shop[k], lim[k]);
    out.shop.since = clip(s.since != null ? s.since : base.shop.since, 4);
    out.shop.instagram = out.shop.instagram.replace(/^@/, '').replace(/[^\w.]/g, '');
    out.shop.whatsapp = out.shop.whatsapp.replace(/\D/g, '');
    const hm = v => /^\d{2}:\d{2}$/.test(v) && +v.slice(0, 2) < 24 && +v.slice(3) < 60;
    if (!Array.isArray(c.hours) || c.hours.length !== 7) throw new HttpError(400, 'Horários inválidos.');
    c.hours.forEach((x, i) => {
      const o = { open: !!x.open, from: hm(x.from) ? x.from : base.hours[i].from, to: hm(x.to) ? x.to : base.hours[i].to, bs: hm(x.bs) ? x.bs : '', be: hm(x.be) ? x.be : '' };
      if (toMin(o.from) >= toMin(o.to)) throw new HttpError(400, 'No horário de funcionamento, a abertura deve ser antes do fechamento.');
      if (!o.bs || !o.be || toMin(o.bs) >= toMin(o.be)) { o.bs = ''; o.be = ''; }
      out.hours.push(o);
    });
    if (!Array.isArray(c.services) || c.services.length > 40) throw new HttpError(400, 'Serviços inválidos.');
    const seen = new Set();
    for (const x of c.services) {
      const name = clip(x.name, 40); if (!name) continue;
      let id = clip(x.id, 30).replace(/[^\w-]/g, '') || 's' + uid(); while (seen.has(id)) id = 's' + uid(); seen.add(id);
      out.services.push({ id, name, desc: clip(x.desc, 140), price: Math.round(Math.max(0, Math.min(9999, +x.price || 0)) * 100) / 100, dur: [30, 60, 90, 120].includes(+x.dur) ? +x.dur : 30, active: !!x.active });
    }
    return out;
  }

  /* ---------- roteador ---------- */
  async fetch(req) {
    try {
      const url = new URL(req.url); let body = {};
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const text = await req.text();
        if (text.length > 100 * 1024) throw new HttpError(413, 'Requisição muito grande.');
        if (text) {
          if (!(req.headers.get('Content-Type') || '').includes('application/json')) throw new HttpError(415, 'Content-Type inválido.');
          try { body = JSON.parse(text); } catch (e) { throw new HttpError(400, 'JSON inválido.'); }
        }
      }
      return await this.route(req, url, body);
    } catch (e) {
      if (e instanceof HttpError) return this.json({ error: e.message }, e.status);
      console.error(e); return this.json({ error: 'Erro interno do servidor.' }, 500);
    }
  }
  json(data, status, cookie) {
    const h = new Headers(Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, SEC));
    if (cookie) h.append('Set-Cookie', cookie);
    return new Response(JSON.stringify(data), { status: status || 200, headers: h });
  }
  cookie(token, maxAge) { return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`; }

  async route(req, url, body) {
    const m = req.method, p = url.pathname, u = await this.currentUser(req);
    const ok = (d, s, c) => this.json(d, s, c);
    let mm;

    if (m === 'GET' && p === '/api/public') return ok(this.config);
    if (m === 'GET' && p === '/api/me') return ok({ user: publicUser(u) });
    if (m === 'GET' && p === '/api/slots') {
      const from = ymd(new Date(wallNow() - 864e5)), out = {}, adm = u && u.role === 'admin';
      for (const b of this.bookings) if (b.date >= from) for (const k of b.slots) out[k] = adm ? { type: 'booking', bid: b.id } : { type: 'booking' };
      for (const k in this.blocks) if (k.slice(0, 10) >= from) out[k] = adm ? { type: 'block', note: this.blocks[k] } : { type: 'block' };
      return ok(out);
    }

    if (m === 'POST' && p === '/api/register') {
      this.rateLimit(req);
      const name = clip(body.name, 60), email = clip(body.email, 100).toLowerCase(), phone = clip(body.phone, 20), pw = String(body.password || '');
      if (name.length < 2) throw new HttpError(400, 'Informe seu nome.');
      if (!emailOk(email)) throw new HttpError(400, 'E-mail inválido.');
      if (digits(phone).length < 10 || digits(phone).length > 11) throw new HttpError(400, 'Informe um telefone válido com DDD.');
      if (pw.length < 6 || pw.length > 100) throw new HttpError(400, 'A senha deve ter ao menos 6 caracteres.');
      if (this.users.some(x => x.email === email)) throw new HttpError(409, 'Já existe uma conta com esse e-mail. Faça login.');
      const user = Object.assign({ id: uid(), name, email, phone, role: 'client', createdAt: Date.now() }, await hashPw(pw));
      this.users.push(user); await this.put('u:' + user.id, user);
      const token = await this.newSession(user.id);
      return ok({ user: publicUser(user) }, 201, this.cookie(token, SESSION_DAYS * 86400));
    }
    if (m === 'POST' && p === '/api/login') {
      this.rateLimit(req);
      const email = clip(body.email, 100).toLowerCase(), pw = String(body.password || '');
      const user = this.users.find(x => x.email === email);
      if (!user || !(await checkPw(pw, user))) throw new HttpError(401, 'E-mail ou senha incorretos.');
      const token = await this.newSession(user.id);
      return ok({ user: publicUser(user) }, 200, this.cookie(token, SESSION_DAYS * 86400));
    }
    if (m === 'POST' && p === '/api/logout') {
      const t = parseCookies(req).sid;
      if (t) { const h = await sha(t); delete this.sessions[h]; await this.del('s:' + h); }
      return ok({ ok: true }, 200, this.cookie('', 0));
    }
    if (m === 'PUT' && p === '/api/me/password') {
      need(u); this.rateLimit(req);
      const cur = String(body.current || ''), nw = String(body.password || '');
      if (!(await checkPw(cur, u))) throw new HttpError(400, 'Senha atual incorreta.');
      if (nw.length < 6 || nw.length > 100) throw new HttpError(400, 'A nova senha deve ter ao menos 6 caracteres.');
      Object.assign(u, await hashPw(nw)); delete u.mustChange; await this.put('u:' + u.id, u);
      const keep = await sha(parseCookies(req).sid);
      for (const k in this.sessions) if (this.sessions[k].uid === u.id && k !== keep) { delete this.sessions[k]; await this.del('s:' + k); }
      return ok({ ok: true });
    }

    if (m === 'GET' && p === '/api/bookings/mine') {
      need(u);
      return ok(this.bookings.filter(b => b.userId === u.id).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).map(bookingView));
    }
    if (m === 'POST' && p === '/api/bookings') {
      need(u);
      const b = await this.makeBooking({ date: body.date, start: body.start, serviceIds: body.serviceIds, name: u.name, phone: u.phone, userId: u.id, source: 'site' }, false);
      return ok(bookingView(b), 201);
    }
    if (m === 'DELETE' && (mm = p.match(/^\/api\/bookings\/([\w-]+)$/))) {
      need(u);
      const i = this.bookings.findIndex(b => b.id === mm[1]); if (i < 0) throw new HttpError(404, 'Agendamento não encontrado.');
      const b = this.bookings[i];
      if (u.role !== 'admin') {
        if (b.userId !== u.id) throw new HttpError(403, 'Acesso restrito.');
        if (slotStart(parseYmd(b.date), b.start) - wallNow() < MIN_CANCEL_MS) throw new HttpError(400, 'Cancelamentos só são possíveis até 2 horas antes. Fale com a barbearia.');
      }
      this.bookings.splice(i, 1); await this.del('b:' + b.id); return ok({ ok: true });
    }

    if (p.startsWith('/api/admin/')) {
      need(u, 'admin');
      if (m === 'GET' && p === '/api/admin/bookings') {
        const from = ymd(new Date(wallNow() - 7 * 864e5));
        return ok(this.bookings.filter(b => b.date >= from).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(bookingView));
      }
      if (m === 'GET' && p === '/api/admin/clients') {
        return ok(this.users.filter(x => x.role === 'client').map(x => {
          const bs = this.bookings.filter(b => b.userId === x.id);
          return { id: x.id, name: x.name, email: x.email, phone: x.phone, createdAt: x.createdAt, bookings: bs.length, last: bs.map(b => b.date).sort().pop() || null };
        }).sort((a, b) => b.createdAt - a.createdAt));
      }
      if (m === 'POST' && p === '/api/admin/bookings') {
        const name = clip(body.name, 60), phone = clip(body.phone, 20) || '—';
        if (!name) throw new HttpError(400, 'Informe o nome do cliente.');
        const b = await this.makeBooking({ date: body.date, start: body.start, serviceIds: body.serviceIds, name, phone, userId: null, source: 'admin' }, true);
        return ok(bookingView(b), 201);
      }
      if (m === 'POST' && p === '/api/admin/blocks') {
        const key = String(body.key || '');
        const mt = key.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})$/); const d = mt && parseYmd(mt[1]);
        if (!d || !daySlots(this.config, d).includes(+mt[2] * 60 + +mt[3])) throw new HttpError(400, 'Horário inválido.');
        if (this.slotMap()[key]) throw new HttpError(409, 'Horário já ocupado.');
        this.blocks[key] = clip(body.note, 60); await this.put('k:' + key, this.blocks[key]); return ok({ ok: true }, 201);
      }
      if (m === 'DELETE' && (mm = p.match(/^\/api\/admin\/blocks\/([\w-]+)$/))) { delete this.blocks[mm[1]]; await this.del('k:' + mm[1]); return ok({ ok: true }); }
      if (m === 'PUT' && p === '/api/admin/config') { this.config = this.sanitizeConfig(body); await this.put('config', this.config); return ok(this.config); }
    }
    throw new HttpError(404, 'Rota não encontrada.');
  }
}
