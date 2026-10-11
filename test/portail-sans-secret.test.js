'use strict';
// Famiminmax déployé AVANT que les secrets soient posés : /entrer répond 503
// avec un message clair, et rien d'autre ne change. Processus à part (node
// --test isole chaque fichier) : server.js lit les secrets au chargement.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { newDb } = require('pg-mem');

process.env.ADMIN_CODE = 'test-code';
delete process.env.FAMIMINMAX_SECRET;
delete process.env.FAMIMINMAX_SESSION_SECRET;
process.env.FAMIMINMAX_ADMINS = '4';

const db = require('../lib/db');
const { serveur } = require('../server');

// Deuxième instance : le secret du portail posé, celui des sessions oublié.
process.env.FAMIMINMAX_SECRET = 'secret-portail-de-test-0123456789abcdef';
delete require.cache[require.resolve('../server')];
const { serveur: serveurDemi } = require('../server');

let base;
let baseDemi;

before(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  db.setPool(new Pool());
  await db.initSchema();
  await db.requete("INSERT INTO produits (code_article, ean, description, stock_min) VALUES ('57913', '5410764216374', 'Goudspray 150ml', 120)");
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  await new Promise((ok) => serveurDemi.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${serveur.address().port}`;
  baseDemi = `http://127.0.0.1:${serveurDemi.address().port}`;
});

after(() => { serveur.close(); serveurDemi.close(); });

// Un jeton qui SERAIT valide si le secret était posé : il ne doit rien ouvrir.
function jetonPlausible(secret) {
  const c = Buffer.from(`4|${Math.floor(Date.now() / 1000) + 60}|Jimmy Hendrickx`).toString('base64url');
  return c + '.' + crypto.createHmac('sha256', secret).update(c).digest('hex');
}

test('sans FAMIMINMAX_SECRET : /entrer répond 503 avec un message clair', async () => {
  for (const chemin of ['/entrer', '/entrer?j=' + jetonPlausible('')]) {
    const rep = await fetch(base + chemin, { redirect: 'manual' });
    assert.strictEqual(rep.status, 503);
    assert.match(rep.headers.get('content-type'), /text\/plain/);
    assert.strictEqual(rep.headers.get('set-cookie'), null);
    assert.match(await rep.text(), /pas encore relié au portail : FAMIMINMAX_SECRET manque/);
  }
});

test('FAMIMINMAX_SECRET sans FAMIMINMAX_SESSION_SECRET : 503 aussi, la variable manquante est nommée', async () => {
  const rep = await fetch(baseDemi + '/entrer?j=' + jetonPlausible('secret-portail-de-test-0123456789abcdef'), { redirect: 'manual' });
  assert.strictEqual(rep.status, 503);
  assert.match(await rep.text(), /FAMIMINMAX_SESSION_SECRET manque/);
});

test('sans secret : aucun cookie n’ouvre de session, tout le reste comme avant', async () => {
  const cookie = { Cookie: 'fmm=' + jetonPlausible('') };
  assert.deepStrictEqual(await (await fetch(base + '/api/moi', { headers: cookie })).json(), { portail: false });
  assert.strictEqual((await fetch(base + '/api/etat', { headers: cookie })).status, 401);
  assert.strictEqual((await fetch(base + '/api/etat', { headers: { 'X-Admin-Code': 'test-code' } })).status, 200);
  assert.strictEqual((await fetch(base + '/')).status, 200);
  assert.strictEqual((await fetch(base + '/api/sante')).status, 200);
  const rep = await fetch(base + '/api/proposition', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...cookie },
    body: JSON.stringify({ codeArticle: '57913', minPropose: 96, auteur: 'Kim' }),
  });
  assert.strictEqual(rep.status, 200);
  const { rows } = await db.requete("SELECT auteur, auteur_central_id FROM propositions WHERE code_article = '57913'");
  assert.strictEqual(rows[0].auteur, 'Kim');
  assert.strictEqual(rows[0].auteur_central_id, null);
});

test('sans FAMIMINMAX_SECRET : les rôles pour Famicard répondent 503 { ok: false }, rien n’est écrit', async () => {
  // Signé avec un secret VIDE : le HMAC se calcule, il ne doit rien ouvrir
  const exp = Math.floor(Date.now() / 1000) + 120;
  const hmacVide = (m) => crypto.createHmac('sha256', '').update(m).digest('hex');
  let rep = await fetch(`${base}/api/famicard/roles?exp=${exp}&sig=${hmacVide(`roles|${exp}`)}`);
  assert.strictEqual(rep.status, 503);
  assert.deepStrictEqual(await rep.json(), { ok: false, erreur: "Famiminmax n'est pas relié au portail : FAMIMINMAX_SECRET manque." });
  rep = await fetch(base + '/api/famicard/role', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ centralId: 4, role: 'admin', nom: 'Jimmy Hendrickx', exp, sig: hmacVide(`role|4|admin|Jimmy Hendrickx|${exp}`) }),
  });
  assert.strictEqual(rep.status, 503);
  assert.strictEqual((await rep.json()).ok, false);
  assert.deepStrictEqual((await db.requete('SELECT * FROM portail_roles')).rows, []);
  // Le secret du portail suffit aux rôles, sans celui des sessions
  const sig = crypto.createHmac('sha256', 'secret-portail-de-test-0123456789abcdef').update(`roles|${exp}`).digest('hex');
  rep = await fetch(`${baseDemi}/api/famicard/roles?exp=${exp}&sig=${sig}`);
  assert.strictEqual(rep.status, 200);
  assert.deepStrictEqual((await rep.json()).comptes, {});
});
