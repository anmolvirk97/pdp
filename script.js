/* PDP Duty Planner - secure backend (Cloudflare Worker)
   The GitHub token, repo, PIN hashes and master PIN live ONLY here (secrets / private repo).
   Secrets (wrangler secret put ...):  GITHUB_TOKEN, SESSION_SECRET
   Variables (wrangler.toml / dashboard): GITHUB_USER, GITHUB_REPO, GITHUB_BRANCH (default main), ALLOWED_ORIGIN */

const DEFAULT_ID = 'anmolvirk';
const DEFAULT_MASTER_PIN = '1997';                       // used until the admin changes it
const LEGACY_DEFAULT_HASH = '82825216595cc763980817e691e30f096305774318fa830354f125b951a6aef4';
const SESSION_HOURS = 24;
const ACTIVE_HOLD = 60000;                                // a device counts as "active" for up to 60 s after its last activity signal
const fails = new Map();                                  // best-effort brute-force limiter (per Worker instance)

/* ---------- small helpers ---------- */
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));
const b64u = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
const b64enc = s => btoa(String.fromCharCode(...enc.encode(s)));
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
const same = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const validPin = p => typeof p === 'string' && /^\d{4,8}$/.test(p);

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || {}; } }

/* ---------- PIN hashing: new PINs use salted PBKDF2; old SHA-256 hashes still verify ---------- */
async function pbkdf2(pin, salt) {
    const k = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256));
}
async function makeHash(pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return 'v2$' + hex(salt) + '$' + await pbkdf2(pin, salt);
}
async function checkHash(stored, pin, id) {
    if (!stored) return false;
    if (stored.startsWith('v2$')) { const [, s, h] = stored.split('$'); return same(await pbkdf2(pin, unhex(s)), h); }
    return same(hex(await crypto.subtle.digest('SHA-256', enc.encode(`pdp:${id}:${pin}`))), stored);   // legacy format
}

/* ---------- signed session tokens ---------- */
async function hmac(env, data) {
    const k = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
async function signToken(env, id, sid) {
    const body = b64u(JSON.stringify({ id, sid, exp: Date.now() + SESSION_HOURS * 3600e3 }));
    return body + '.' + await hmac(env, body);
}

/* ---------- one live session per profile (needs the KV binding named KV) ---------- */
async function kvGet(env, id) { if (!env.KV) return null; try { return JSON.parse(await env.KV.get('s:' + id) || 'null'); } catch (e) { return null; } }
async function kvPut(env, id, o) { if (!env.KV) return false; try { await env.KV.put('s:' + id, JSON.stringify(o)); return true; } catch (e) { return false; } }
function clientInfo(req) {
    const ua = req.headers.get('User-Agent') || '', cf = req.cf || {};
    const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return { ip: req.headers.get('CF-Connecting-IP') || 'unknown', loc: [cf.city, cf.country].filter(Boolean).join(', '), device: br + (os ? ' on ' + os : ''), at: Date.now() };
}
// New login = new session id. Every older token for this profile stops working (those devices are logged out).
async function startSession(env, id, cl, old) {
    const rec = { sid: crypto.randomUUID(), cur: cl, prev: (old && old.cur) || (old && old.prev) || null, activeUntil: Date.now() + ACTIVE_HOLD };
    const ok = await kvPut(env, id, rec);
    return { sid: ok ? rec.sid : undefined, info: { cur: cl, prev: rec.prev } };
}

/* ---------- GitHub (the only place the token is used) ---------- */
function gh(env, path, init = {}) {
    const branch = env.GITHUB_BRANCH || 'main';
    const url = `https://api.github.com/repos/${env.GITHUB_USER}/${env.GITHUB_REPO}/contents/${path}` + (init.method && init.method !== 'GET' ? '' : `?ref=${branch}`);
    return fetch(url, Object.assign({}, init, {
        headers: Object.assign({ Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'pdp-planner', 'Content-Type': 'application/json' }, init.headers || {})
    }));
}
async function readJson(env, path) {
    const r = await gh(env, path);
    if (r.status === 404) return { json: null, sha: null };
    if (!r.ok) throw new HttpError(502, 'Storage error (' + r.status + ')');
    const m = await r.json();
    return { json: JSON.parse(b64dec(m.content)), sha: m.sha };
}
async function writeJson(env, path, obj, sha, msg) {
    const body = { message: msg, content: b64enc(JSON.stringify(obj, null, 1)), branch: env.GITHUB_BRANCH || 'main' };
    if (sha) body.sha = sha;
    return gh(env, path, { method: 'PUT', body: JSON.stringify(body) });
}
async function deleteFile(env, path) {
    const { sha } = await readJson(env, path);
    if (!sha) return;
    await gh(env, path, { method: 'DELETE', body: JSON.stringify({ message: 'Delete profile data', sha, branch: env.GITHUB_BRANCH || 'main' }) });
}

/* ---------- profile store (profiles.json: { profiles:[...], masterPinHash }) ---------- */
function seed(store) {
    store.profiles = Array.isArray(store.profiles) ? store.profiles.filter(p => p && p.id) : [];
    let d = store.profiles.find(p => p.id === DEFAULT_ID);
    if (!d) { d = { id: DEFAULT_ID, name: 'Anmol Virk', cls: '6', section: 'R', pinHash: LEGACY_DEFAULT_HASH, dataFile: 'data.json', admin: true, createdAt: 0 }; store.profiles.unshift(d); }
    d.admin = true; d.dataFile = 'data.json'; delete d.archived;
    return store;
}
async function loadStore(env) { const { json, sha } = await readJson(env, 'profiles.json'); return { store: seed(json || {}), sha }; }
// read -> change -> save, retrying if someone saved at the same moment
async function mutate(env, fn) {
    for (let i = 0; i < 3; i++) {
        const { store, sha } = await loadStore(env);
        const out = await fn(store);
        store.updatedAt = Date.now();
        const r = await writeJson(env, 'profiles.json', store, sha, 'Update profiles');
        if (r.ok) return out;
        if (r.status !== 409 && r.status !== 422) throw new HttpError(502, 'Could not save (' + r.status + ')');
    }
    throw new HttpError(409, 'Could not save - please try again.');
}
const pub = p => ({ id: p.id, name: p.name, cls: p.cls || '', section: p.section || '', admin: !!p.admin, dataFile: p.dataFile, archived: !!p.archived, archivedAt: p.archivedAt || 0, createdAt: p.createdAt || 0 });
const dataFileOf = p => p.dataFile || 'profiles/' + p.id + '.json';

async function verifyToken(req, env) {
    const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    const [body, sig] = t.split('.');
    if (!body || !sig || !same(await hmac(env, body), sig)) throw new HttpError(401, 'Session expired - please log in again.');
    let c; try { c = JSON.parse(unb64u(body)); } catch (e) { throw new HttpError(401, 'Invalid session.'); }
    if (!c.exp || c.exp < Date.now()) throw new HttpError(401, 'Session expired - please log in again.');
    if (c.sid && env.KV) {
        const rec = await kvGet(env, c.id);
        if (!rec || rec.sid !== c.sid) throw new HttpError(401, 'You were logged out because this profile was opened on another device.', { code: 'kicked' });
    }
    return c;
}
async function auth(req, env) {
    const c = await verifyToken(req, env);
    const { store } = await loadStore(env);
    const me = store.profiles.find(p => p.id === c.id && !p.archived);
    if (!me) throw new HttpError(401, 'This profile is no longer available.');
    return { me, store };
}

async function pinGuard(env, key, ok) {                     // 5 wrong tries -> 30 s lock, enforced here (not in the browser)
    const f = fails.get(key) || { n: 0, until: 0 };
    if (f.until > Date.now()) throw new HttpError(429, `Too many wrong attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)}s.`);
    if (ok) { fails.delete(key); return; }
    f.n++;
    if (f.n >= 5) { fails.set(key, { n: 0, until: Date.now() + 30000 }); throw new HttpError(429, 'Too many wrong attempts. Locked for 30 seconds.'); }
    fails.set(key, f);
    throw new HttpError(401, `Wrong PIN. ${5 - f.n} attempt${5 - f.n === 1 ? '' : 's'} left.`);
}

/* ---------- file proxy: only the caller's own data (admin may READ any profile's data) ---------- */
function allowedPath(me, store, path, method) {
    if (path.includes('..')) return false;
    const own = dataFileOf(me), bak = 'backups/' + own.replace(/\//g, '_') + '.pre-ids.json';
    if (path === own || path === bak) return true;
    if (method === 'GET' && me.admin) return store.profiles.some(p => dataFileOf(p) === path);
    return false;
}

async function route(req, env, url) {
    const m = req.method, p = url.pathname;
    const body = (m === 'POST' || m === 'PUT') && !p.startsWith('/file/') ? await req.json().catch(() => ({})) : {};

    if (m === 'GET' && p === '/profiles') {
        const { store } = await loadStore(env);
        return { profiles: store.profiles.filter(x => !x.archived).map(x => ({ id: x.id, name: x.name, cls: x.cls || '', section: x.section || '' })) };
    }
    if (m === 'POST' && p === '/login') {
        const { store } = await loadStore(env);
        const t = store.profiles.find(x => x.id === String(body.id || '').toLowerCase());
        if (!t || t.archived) throw new HttpError(404, t ? 'This profile has been archived. Ask the admin to restore it.' : 'Profile not found.');
        await pinGuard(env, 'login:' + t.id, validPin(String(body.pin)) && await checkHash(t.pinHash, String(body.pin), t.id));
        const cur = await kvGet(env, t.id);
        if (cur && cur.sid && (cur.activeUntil || 0) > Date.now() && !body.force)
            throw new HttpError(409, 'This profile is in use on another device.', { code: 'active_elsewhere', other: cur.cur || null });
        const s = await startSession(env, t.id, clientInfo(req), cur);
        return { token: await signToken(env, t.id, s.sid), profile: pub(t), session: s.info };
    }
    if (m === 'POST' && p === '/profile/create') {
        const id = String(body.id || '').toLowerCase(), name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!/^[a-z0-9_-]{3,30}$/.test(id) || !name || !validPin(String(body.pin))) throw new HttpError(400, 'Please check the name, profile ID and PIN.');
        const { store } = await loadStore(env);
        const masterOk = store.masterPinHash ? await checkHash(store.masterPinHash, String(body.masterPin), 'master') : String(body.masterPin) === DEFAULT_MASTER_PIN;
        await pinGuard(env, 'master', masterOk).catch(e => { throw e.status === 401 ? new HttpError(403, e.message.replace('Wrong PIN', 'Wrong master PIN')) : e; });
        const profile = { id, name, cls: String(body.cls || '').trim().slice(0, 12), section: String(body.section || '').trim().slice(0, 6), pinHash: await makeHash(String(body.pin)), dataFile: 'profiles/' + id + '.json', admin: false, createdAt: Date.now() };
        await mutate(env, s => { if (s.profiles.some(x => x.id === id)) throw new HttpError(409, 'That profile ID is already taken (it may be archived).'); s.profiles.push(profile); });
        if (body.starterData) await writeJson(env, profile.dataFile, body.starterData, null, 'Create profile data').catch(() => {});
        const s = await startSession(env, id, clientInfo(req), null);
        return { token: await signToken(env, id, s.sid), profile: pub(profile), session: s.info };
    }

    if (m === 'POST' && p === '/session/ping') {            // "is this device active?" - lightweight, reads only unless the state changes
        const c = await verifyToken(req, env), rec = await kvGet(env, c.id), now = Date.now();
        if (rec && rec.sid === c.sid) {
            const left = (rec.activeUntil || 0) - now;
            if (body.active && left < 12000) { rec.activeUntil = now + ACTIVE_HOLD; await kvPut(env, c.id, rec); }
            else if (!body.active && left > 0) { rec.activeUntil = 0; await kvPut(env, c.id, rec); }
        }
        return { ok: true };
    }
    if (m === 'POST' && p === '/logout') {
        const c = await verifyToken(req, env).catch(() => null);
        const rec = c && await kvGet(env, c.id);
        if (rec && rec.sid === c.sid) { rec.sid = null; rec.activeUntil = 0; await kvPut(env, c.id, rec); }
        return { ok: true };
    }

    const { me, store } = await auth(req, env);

    if (p.startsWith('/file/')) {
        const path = decodeURIComponent(p.slice(6));
        if (!allowedPath(me, store, path, m)) throw new HttpError(403, 'Not allowed.');
        const init = { method: m };
        if (m === 'PUT' || m === 'DELETE') { const b = await req.json().catch(() => ({})); b.branch = env.GITHUB_BRANCH || 'main'; init.body = JSON.stringify(b); }
        const r = await gh(env, path, init);
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }
    if (m === 'GET' && p === '/me') { const r = await kvGet(env, me.id); return { profile: pub(me), session: r ? { cur: r.cur, prev: r.prev } : null }; }
    if (m === 'GET' && p === '/admin/profiles') {
        if (!me.admin) throw new HttpError(403, 'Admin only.');
        return { profiles: store.profiles.map(pub) };
    }
    if (m === 'POST' && p === '/profile/update') {
        const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!name) throw new HttpError(400, 'Name cannot be empty.');
        await mutate(env, s => { const x = s.profiles.find(q => q.id === me.id); x.name = name; x.cls = String(body.cls || '').trim().slice(0, 12); x.section = String(body.section || '').trim().slice(0, 6); });
        return { ok: true };
    }
    if (m === 'POST' && p === '/pin/change') {
        if (!validPin(String(body.newPin))) throw new HttpError(400, 'New PIN must be 4 to 8 digits.');
        if (!await checkHash(me.pinHash, String(body.oldPin), me.id)) throw new HttpError(403, 'Current PIN is wrong.');
        const h = await makeHash(String(body.newPin));
        await mutate(env, s => { s.profiles.find(q => q.id === me.id).pinHash = h; });
        return { ok: true };
    }
    if (m === 'POST' && p === '/master-pin') {
        if (!me.admin) throw new HttpError(403, 'Admin only.');
        if (!validPin(String(body.newPin))) throw new HttpError(400, 'New master PIN must be 4 to 8 digits.');
        const ok = store.masterPinHash ? await checkHash(store.masterPinHash, String(body.oldPin), 'master') : String(body.oldPin) === DEFAULT_MASTER_PIN;
        if (!ok) throw new HttpError(403, 'Current master PIN is wrong.');
        const h = await makeHash(String(body.newPin));
        await mutate(env, s => { s.masterPinHash = h; });
        return { ok: true };
    }
    if (m === 'POST' && ['/admin/reset-pin', '/admin/restore'].includes(p)) {
        if (!me.admin) throw new HttpError(403, 'Admin only.');
        const pin = body.pin ? String(body.pin) : '';
        if ((p === '/admin/reset-pin' || pin) && !validPin(pin)) throw new HttpError(400, 'PIN must be 4 to 8 digits.');
        const h = pin ? await makeHash(pin) : null;
        await mutate(env, s => {
            const t = s.profiles.find(q => q.id === body.id);
            if (!t) throw new HttpError(404, 'Profile not found.');
            if (p === '/admin/restore') { delete t.archived; delete t.archivedAt; delete t.archivedBy; }
            if (h) t.pinHash = h;
        });
        fails.delete('login:' + body.id);
        return { ok: true };
    }
    if (m === 'POST' && (p === '/profile/archive' || p === '/profile/delete')) {
        const id = String(body.id || '');
        if (id === DEFAULT_ID) throw new HttpError(403, 'The default profile cannot be removed.');
        const own = id === me.id;
        if (!own && !me.admin) throw new HttpError(403, 'Not allowed.');
        if (own && !await checkHash(me.pinHash, String(body.pin), me.id)) throw new HttpError(403, 'Wrong PIN.');
        let target;
        await mutate(env, s => {
            target = s.profiles.find(q => q.id === id);
            if (!target) throw new HttpError(404, 'Profile not found.');
            if (p === '/profile/archive') Object.assign(target, { archived: true, archivedAt: Date.now(), archivedBy: me.id });
            else s.profiles = s.profiles.filter(q => q.id !== id);
        });
        if (p === '/profile/delete') { await deleteFile(env, dataFileOf(target)).catch(() => {}); await deleteFile(env, 'backups/' + dataFileOf(target).replace(/\//g, '_') + '.pre-ids.json').catch(() => {}); }
        return { ok: true };
    }
    throw new HttpError(404, 'Not found.');
}

export default {
    async fetch(req, env) {
        const origin = env.ALLOWED_ORIGIN || '';
        const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Vary': 'Origin', 'Cache-Control': 'no-store' };
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (!origin || req.headers.get('Origin') !== origin) return new Response(JSON.stringify({ error: 'Origin not allowed.' }), { status: 403, headers: cors });
        try {
            const out = await route(req, env, new URL(req.url));
            if (out instanceof Response) { Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v)); return out; }
            return new Response(JSON.stringify(out), { headers: Object.assign({ 'Content-Type': 'application/json' }, cors) });
        } catch (e) {
            const status = e instanceof HttpError ? e.status : 500;
            return new Response(JSON.stringify(Object.assign({ error: e instanceof HttpError ? e.message : 'Server error.' }, e instanceof HttpError ? e.extra : {})), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) });
        }
    }
};