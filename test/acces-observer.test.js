'use strict';
// « Famicard dit qui a accès », mode OBSERVER : le défaut, la variable n'est
// pas posée. Déployé ainsi, Famiminmax ne refuse RIEN de plus qu'avant : il
// note seulement (journal + rapport) les refus qui auraient eu lieu. C'est ce
// qui permet de publier sans risque, puis de relire le rapport avec Jimmy.
// Processus à part (node --test isole chaque fichier) : le mode est lu au
// chargement de server.js. Base pg-mem, faux Famicard local.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { newDb } = require('pg-mem');

const SECRET = 'secret-portail-de-test-0123456789abcdef';
const SECRET_SESSION = 'secret-session-de-test-fedcba9876543210';
process.env.ADMIN_CODE = 'test-code';
process.env.FAMIMINMAX_SECRET = SECRET;
process.env.FAMIMINMAX_SESSION_SECRET = SECRET_SESSION;
process.env.FAMIMINMAX_ADMINS = '4, 12';
delete process.env.ACCES_FAMICARD_MODE; // le défaut

const db = require('../lib/db');

const hmac = (message, secret = SECRET) => crypto.createHmac('sha256', secret).update(message).digest('hex');
const maintenant = () => Math.floor(Date.now() / 1000);

const journal = [];
for (const k of ['log', 'warn', 'error']) {
  const ecrire = console[k].bind(console);
  console[k] = (...a) => { journal.push(a.map(String).join(' ')); ecrire(...a); };
}
const lignes = (motif) => journal.filter((l) => motif.test(l));

// Faux Famicard : la liste, toujours servie (la vérification de la demande est
// testée dans acces.test.js)
const JIMMY = { id: 4, nom: 'Jimmy Hendrickx' };
const LISE = { id: 12, nom: 'Lise Martin' };
const KIM = { id: 5, nom: 'Kim Peeters' };
const famicard = { personnes: [JIMMY], appels: 0 };
const faux = http.createServer((req, res) => {
  famicard.appels++;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ contrat: 1, service: 'famiminmax', genere_le: new Date().toISOString(), total: famicard.personnes.length, personnes: famicard.personnes }));
});

let serveur;
let acces;
let port;

function brut(chemin, { methode = 'GET', entetes = {}, corps, vers = port } = {}) {
  return new Promise((ok, ko) => {
    const req = http.request({ host: '127.0.0.1', port: vers, path: chemin, method: methode, headers: entetes, agent: false }, (rep) => {
      const morceaux = [];
      rep.on('data', (c) => morceaux.push(c));
      rep.on('end', () => {
        const texte = Buffer.concat(morceaux).toString('utf8');
        let data = null;
        try { data = JSON.parse(texte); } catch { /* pas du JSON */ }
        ok({ status: rep.statusCode, headers: rep.headers, texte, data });
      });
    });
    req.on('error', ko);
    if (corps !== undefined) req.write(typeof corps === 'string' ? corps : JSON.stringify(corps));
    req.end();
  });
}
function laissezPasser({ id, nom }) {
  const charge = Buffer.from(`${id}|${maintenant() + 60}|${nom}`, 'utf8').toString('base64url');
  return charge + '.' + hmac(charge);
}
const entrer = (qui, suite = '') => brut('/entrer?j=' + encodeURIComponent(laissezPasser(qui)) + suite);
const cookieDe = (rep) => String((rep.headers['set-cookie'] || [])[0] || '').split(';')[0];
async function rapport(vers) {
  const exp = maintenant() + 120;
  const rep = await brut(`/api/famicard/acces-rapport?exp=${exp}&sig=${hmac(`acces-rapport|${exp}`)}`, { vers });
  assert.strictEqual(rep.status, 200, rep.texte);
  return rep.data;
}

// Une autre instance du serveur, chargée avec ces variables (le mode est lu au chargement)
function chargerAvec(variables) {
  const avant = {};
  for (const [k, v] of Object.entries(variables)) { avant[k] = process.env[k]; process.env[k] = v; }
  delete require.cache[require.resolve('../server')];
  try {
    return require('../server');
  } finally {
    for (const [k, v] of Object.entries(avant)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

before(async () => {
  await new Promise((ok) => faux.listen(0, '127.0.0.1', ok));
  process.env.ACCES_FAMICARD_URL = `http://127.0.0.1:${faux.address().port}/api_acces.php`;
  // Le premier fetch d'un processus charge son moteur (undici) : sur une machine
  // chargée, plus de 5 s. Une fois ici, sans délai.
  await (await fetch(`http://127.0.0.1:${faux.address().port}/__chauffe`)).text();
  let amorcerRoles;
  ({ serveur, acces, amorcerRoles } = require('../server'));
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  db.setPool(new Pool());
  await db.initSchema();
  await amorcerRoles(); // 4 et 12 admins
  await db.requete("INSERT INTO produits (code_article, ean, description, stock_min) VALUES ('57913', '5410764216374', 'Goudspray 150ml', 120)");
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  port = serveur.address().port;
  await acces.rafraichir(); // la liste : Jimmy seul
});

after(() => {
  serveur.close();
  faux.closeAllConnections();
  faux.close();
});

test('mode observer par défaut : hors liste, tout passe comme avant, et chaque refus qui aurait eu lieu est noté', async () => {
  assert.strictEqual(acces.applique, false);
  const appels = famicard.appels;
  // Kim (5), pas cochée : elle entre, sa session est reconnue et signe ses propositions
  let rep = await entrer(KIM);
  assert.strictEqual(rep.headers.location, '/');
  const kim = cookieDe(rep);
  assert.match(kim, /^fmm=[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
  const moi = (await brut('/api/moi', { entetes: { Cookie: kim } })).data;
  assert.strictEqual(moi.portail, true);
  assert.strictEqual(moi.centralId, 5);
  rep = await brut('/api/proposition', {
    methode: 'POST', entetes: { 'Content-Type': 'application/json', Cookie: kim }, corps: { codeArticle: '57913', minPropose: 96 },
  });
  assert.strictEqual(rep.status, 200, rep.texte);
  const { rows } = await db.requete("SELECT auteur, auteur_central_id FROM propositions WHERE code_article = '57913'");
  assert.deepStrictEqual(rows[0], { auteur: 'Kim Peeters', auteur_central_id: 5 });
  // Lise (12), admin mais pas cochée : l'administration s'ouvre comme avant
  rep = await entrer(LISE, '&vers=admin');
  assert.strictEqual(rep.headers.location, '/admin');
  assert.strictEqual((await brut('/api/etat', { entetes: { Cookie: cookieDe(rep) } })).status, 200);
  // Jimmy, coché : rien à noter
  assert.strictEqual((await brut('/api/etat', { entetes: { Cookie: cookieDe(await entrer(JIMMY)) } })).status, 200);
  // Pas de relecture anticipée : rien n'a été refusé
  assert.strictEqual(famicard.appels, appels);

  const r = await rapport();
  assert.strictEqual(r.mode, 'observer');
  assert.strictEqual(r.liste.source, 'famicard');
  const fois = Object.fromEntries(r.refus.map((l) => [`${l.qui} / ${l.porte}`, l.fois]));
  assert.deepStrictEqual(fois, {
    'Kim Peeters (Famicard n° 5) / entrer': 1,
    'Kim Peeters (Famicard n° 5) / session': 2,
    'Lise Martin (Famicard n° 12) / entrer': 1,
    'Lise Martin (Famicard n° 12) / admin': 1,
  });
  assert.deepStrictEqual(r.admins_hors_liste, [{ id: 12, nom: null }]);
  assert.strictEqual(lignes(/aurait été refusé \(mode observer\) : Kim Peeters \(Famicard n° 5\), porte « entrer »/).length, 1);
  assert.strictEqual(lignes(/REFUSÉ/).length, 0);
});

test('observer sans ADMIN_CODE : l’administration reste ouverte comme avant', async () => {
  const { serveur: libre } = chargerAvec({ ADMIN_CODE: '' });
  await new Promise((ok) => libre.listen(0, '127.0.0.1', ok));
  try {
    assert.strictEqual((await brut('/api/etat', { vers: libre.address().port })).status, 200);
  } finally {
    libre.close();
  }
});

test('valeur de mode inconnue (faute de frappe) : observer, avec un avertissement ; « Appliquer » écrit autrement : appliqué', async () => {
  const n = journal.length;
  let instance = chargerAvec({ ACCES_FAMICARD_MODE: 'appliqué' });
  assert.strictEqual(instance.acces.applique, false);
  assert.strictEqual(instance.acces.rapport().mode, 'observer');
  assert.deepStrictEqual(journal.slice(n), [
    '⚠ ACCES_FAMICARD_MODE="appliqué" inconnu : mode observer, rien n\'est refusé (valeurs : observer, appliquer).',
  ]);
  for (const valeur of [' Appliquer ', 'APPLIQUER']) {
    instance = chargerAvec({ ACCES_FAMICARD_MODE: valeur });
    assert.strictEqual(instance.acces.applique, true, valeur);
    assert.strictEqual(instance.acces.rapport().mode, 'appliquer', valeur);
  }
  for (const valeur of ['observer', '', '  ']) {
    instance = chargerAvec({ ACCES_FAMICARD_MODE: valeur });
    assert.strictEqual(instance.acces.applique, false, JSON.stringify(valeur));
  }
  assert.strictEqual(journal.length, n + 1); // un seul avertissement, pour la faute de frappe
});
