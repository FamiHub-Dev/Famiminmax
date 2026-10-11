'use strict';
// « Famicard dit qui a accès », mode APPLIQUER : la liste publiée par Famicard,
// relue en arrière-plan, décide aux trois portes (entrer, session, admin) ; la
// page scan des Zebra et le secours ADMIN_CODE n'en dépendent pas ; une panne
// de Famicard ne met personne dehors ; la liste survit à un redémarrage.
// Base pg-mem, comme les autres tests. Famicard est un faux serveur local qui
// vérifie la demande comme le fera api_acces.php (contrat CONTRAT_ACCES.md).
//
// Quand le PHP portable est là, la signature de la demande est vérifiée par
// PHP (hash_hmac + hash_equals, comme Famicard) et celle du rapport fabriquée
// par PHP : la preuve que les deux côtés s'entendent. Sans PHP, même formule
// en Node.

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { newDb } = require('pg-mem');

const SECRET = 'secret-portail-de-test-0123456789abcdef';
const SECRET_SESSION = 'secret-session-de-test-fedcba9876543210';
// Lus au chargement de server.js : posés AVANT le require (fait dans before(),
// une fois le faux Famicard à l'écoute, pour connaître son adresse).
process.env.ADMIN_CODE = 'test-code';
process.env.FAMIMINMAX_SECRET = SECRET;
process.env.FAMIMINMAX_SESSION_SECRET = SECRET_SESSION;
process.env.FAMIMINMAX_ADMINS = '4, 12';
process.env.ACCES_FAMICARD_MODE = 'appliquer';

const db = require('../lib/db');
const { DELAI_MS } = require('../lib/acces');

const PHP = process.env.PHP_BIN || 'C:/Users/enyls/php/php.exe';
const PHP_OK = fs.existsSync(PHP);
const hmac = (message, secret = SECRET) => crypto.createHmac('sha256', secret).update(message).digest('hex');
const maintenant = () => Math.floor(Date.now() / 1000);
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Le journal du service : capté pour vérifier ce qui y est écrit (et affiché).
const journal = [];
for (const k of ['log', 'warn', 'error']) {
  const ecrire = console[k].bind(console);
  console[k] = (...a) => { journal.push(a.map(String).join(' ')); ecrire(...a); };
}
const lignes = (motif) => journal.filter((l) => motif.test(l));

// --- Faux Famicard : GET /api_acces.php, selon le contrat --------------------
const JIMMY = { id: 4, nom: 'Jimmy Hendrickx' };
const LISE = { id: 12, nom: 'Lise Martin' };
const KIM = { id: 5, nom: 'Kim Peeters' };
// etat : normal | 503 | coupe (connexion coupée net) | lent (6 s) | brut (réponse imposée)
const famicard = { personnes: [], etat: 'normal', brut: null, appels: [] };
const faux = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const service = u.searchParams.get('service') || '';
  const exp = u.searchParams.get('exp') || '';
  const sig = u.searchParams.get('sig') || '';
  famicard.appels.push({ chemin: u.pathname, service, exp, sig });
  const envoie = (code, corps) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(typeof corps === 'string' ? corps : JSON.stringify(corps));
  };
  if (famicard.etat === 'coupe') return req.socket.destroy();
  if (famicard.etat === '503') return envoie(503, { erreur: 'panne simulée' });
  if (famicard.etat === 'brut') return envoie(famicard.brut.code, famicard.brut.corps);
  const repondre = () => {
    // Ce que vérifiera api_acces.php : service connu, exp dans [maintenant,
    // +300 s], forme de la signature AVANT la comparaison à temps constant
    if (u.pathname !== '/api_acces.php' || service !== 'famiminmax') return envoie(404, { erreur: 'service inconnu' });
    if (!/^\d{1,12}$/.test(exp) || Number(exp) < maintenant() || Number(exp) > maintenant() + 300) return envoie(403, { erreur: 'échéance' });
    if (!/^[0-9a-f]{64}$/.test(sig) || !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(hmac(`acces|famiminmax|${exp}`), 'hex'))) {
      return envoie(403, { erreur: 'signature' });
    }
    envoie(200, { contrat: 1, service, genere_le: new Date().toISOString(), total: famicard.personnes.length, personnes: famicard.personnes });
  };
  if (famicard.etat === 'lent') return void setTimeout(repondre, 6000).unref(); // 6 s, comme le faux Famicard des bancs
  repondre();
});

// Vérification de NOTRE demande par la formule de Famicard (PHP)
const VERIF_PHP = `
$secret = getenv('S'); $code = getenv('C'); $exp = (string) getenv('E'); $sig = (string) getenv('G');
$ok = preg_match('/^[0-9a-f]{64}$/', $sig) && ctype_digit($exp) && (int) $exp >= time() && (int) $exp <= time() + 300
   && hash_equals(hash_hmac('sha256', 'acces|' . $code . '|' . $exp, $secret), $sig);
echo $ok ? 'accepte' : 'refuse';`;

// Demande du rapport telle que la fera Famicard (PHP)
const RAPPORT_PHP = `
$secret = getenv('S');
$exp = time() + (int) getenv('D');
echo 'exp=' . $exp . '&sig=' . hash_hmac('sha256', 'acces-rapport|' . $exp, $secret);`;
function requeteRapportNode(duree = 120, secret = SECRET) {
  const exp = maintenant() + duree;
  return `exp=${exp}&sig=${hmac(`acces-rapport|${exp}`, secret)}`;
}
const requeteRapportPhp = (duree = 120, secret = SECRET) =>
  execFileSync(PHP, ['-r', RAPPORT_PHP], { env: { ...process.env, S: secret, D: String(duree) } }).toString().trim();
const requeteRapport = PHP_OK ? requeteRapportPhp : requeteRapportNode;

let serveur;
let acces;
let port;
const cookies = {};

// Requête brute (http.request) : aucun cookie, aucune redirection suivie, une
// connexion neuve à chaque fois (agent: false) : sous charge, un appel PHP
// synchrone peut bloquer plus de 5 s, et une connexion gardée ouverte serait
// fermée par le serveur au moment où on la réutilise (ECONNRESET).
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
// Le laissez-passer du portail (formule prouvée face au PHP par portail.test.js)
function laissezPasser({ id, nom }) {
  const charge = Buffer.from(`${id}|${maintenant() + 60}|${nom}`, 'utf8').toString('base64url');
  return charge + '.' + hmac(charge);
}
const entrer = (qui, suite = '', options = {}) => brut('/entrer?j=' + encodeURIComponent(laissezPasser(qui)) + suite, options);
const cookieDe = (rep) => String((rep.headers['set-cookie'] || [])[0] || '').split(';')[0];
async function session(qui, vers) {
  const rep = await entrer(qui, '', { vers });
  assert.strictEqual(rep.headers.location, '/', `${qui.nom} devrait entrer`);
  return cookieDe(rep);
}
const moi = async (cookie, vers) => (await brut('/api/moi', { entetes: cookie ? { Cookie: cookie } : {}, vers })).data;
const etat = (entetes, vers) => brut('/api/etat', { entetes, vers });
async function rapport(vers) {
  const rep = await brut('/api/famicard/acces-rapport?' + requeteRapportNode(), { vers });
  assert.strictEqual(rep.status, 200, rep.texte);
  return rep.data;
}
const proposer = (cookie, corps, chemin = '/api/proposition') => brut(chemin, {
  methode: 'POST', entetes: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, corps,
});
const enBase = async () => (await db.requete('SELECT service, personnes, total, genere_le, recue_le FROM acces_famicard')).rows;

// Famicard a changé sa liste : on attend la relecture en cours (lancée par une
// entrée refusée, avec l'ancienne liste), puis on en lance une nouvelle.
async function relireListe(a = acces) {
  await a.rafraichir();
  await a.rafraichir();
}

before(async () => {
  await new Promise((ok) => faux.listen(0, '127.0.0.1', ok));
  process.env.ACCES_FAMICARD_URL = `http://127.0.0.1:${faux.address().port}/api_acces.php`;
  // Le premier fetch d'un processus charge son moteur (undici) : sur une machine
  // chargée, plus de 5 s. Une fois ici, sans délai, et le premier test mesure
  // vraiment Famicard.
  await (await fetch(`http://127.0.0.1:${faux.address().port}/__chauffe`)).text();
  famicard.appels.length = 0;
  let amorcerRoles;
  ({ serveur, acces, amorcerRoles } = require('../server'));
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  db.setPool(new Pool());
  await db.initSchema();
  await amorcerRoles(); // 4 et 12 admins, comme au démarrage
  await db.requete("INSERT INTO produits (code_article, ean, description, stock_min) VALUES ('57913', '5410764216374', 'Goudspray 150ml', 120)");
  await db.requete("INSERT INTO collections (nom) VALUES ('Lemax26-03')");
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  port = serveur.address().port;
});

after(() => {
  acces.arreter();
  serveur.close();
  faux.closeAllConnections();
  faux.close();
});

test('aucune liste jamais reçue (Famicard en panne au tout premier démarrage) : on laisse passer, et on le journalise', async () => {
  famicard.etat = '503';
  await acces.charger(); // base vide
  await acces.rafraichir();
  let r = await rapport();
  assert.strictEqual(r.liste.source, 'aucune');
  assert.strictEqual(r.liste.total, null);
  assert.strictEqual(r.liste.recue_le, null);
  assert.match(r.liste.erreur, /^Famicard a répondu 503$/);
  assert.strictEqual(r.admins_hors_liste, null); // sans liste, on ne sait pas
  // Les trois portes laissent passer
  cookies.kim = await session(KIM);
  assert.strictEqual((await moi(cookies.kim)).centralId, 5);
  cookies.lise = await session(LISE);
  assert.strictEqual((await etat({ Cookie: cookies.lise })).status, 200); // 12, amorcée admin
  r = await rapport();
  assert.strictEqual(r.sans_liste.fois, 4); // entrer ×2, session, admin
  assert.deepStrictEqual(r.refus, []);
  assert.strictEqual(lignes(/aucune liste en base : on attend celle de Famicard/).length, 1);
  assert.strictEqual(lignes(/liste Famicard non relue \(Famicard a répondu 503\) : aucune liste connue, on laisse passer\.$/).length, 1);
  // Une note par minute, pas une par passage
  assert.deepStrictEqual(lignes(/aucune liste reçue de Famicard/), [
    '[accès] aucune liste reçue de Famicard : laissé passer Kim Peeters (Famicard n° 5), porte « entrer ».',
  ]);
});

test('la demande de liste est signée comme Famicard la vérifiera (PHP), et la liste reçue s’applique', async () => {
  famicard.etat = 'normal';
  famicard.personnes = [JIMMY, LISE];
  const avant = famicard.appels.length;
  await acces.rafraichir();
  assert.strictEqual(famicard.appels.length, avant + 1);
  const { chemin, service, exp, sig } = famicard.appels[avant];
  assert.strictEqual(chemin, '/api_acces.php');
  assert.strictEqual(service, 'famiminmax');
  assert.ok(Number(exp) > maintenant() + 60 && Number(exp) <= maintenant() + 300, exp); // 120 s d'avance
  assert.strictEqual(sig, hmac(`acces|famiminmax|${exp}`));
  if (PHP_OK) {
    const verifie = (secret) => execFileSync(PHP, ['-r', VERIF_PHP], { env: { ...process.env, S: secret, C: service, E: exp, G: sig } }).toString().trim();
    assert.strictEqual(verifie(SECRET), 'accepte');
    assert.strictEqual(verifie('pas-le-bon-secret'), 'refuse');
  }
  const r = await rapport();
  assert.strictEqual(r.liste.source, 'famicard');
  assert.strictEqual(r.liste.total, 2);
  assert.strictEqual(r.liste.erreur, null);
  assert.match(r.liste.genere_le, /^\d{4}-\d\d-\d\dT/);
  assert.strictEqual(lignes(/Famicard répond de nouveau \(après 1 relecture\(s\) ratée\(s\)\)/).length, 1);
  assert.deepStrictEqual(lignes(/liste Famicard « famiminmax »/), ['[accès] liste Famicard « famiminmax » : 2 personne(s) (mode appliquer).']);
});

test('entrée refusée : la liste est relue tout de suite, qui vient d’être coché entre au second essai', async () => {
  const NORA = { id: 77, nom: 'Nora Nouvelle' };
  famicard.personnes = [JIMMY, LISE, NORA]; // cochée à l'instant : la liste en mémoire a jusqu'à une minute de retard
  const avant = famicard.appels.length;
  assert.strictEqual((await entrer(NORA)).headers.location, '/?acces=ferme');
  for (let i = 0; i < 100 && famicard.appels.length === avant; i++) await pause(10);
  assert.strictEqual(famicard.appels.length, avant + 1, 'une relecture part aussitôt');
  await acces.rafraichir(); // la fin de celle-ci (ou une autre, même liste)
  assert.strictEqual((await entrer(NORA)).headers.location, '/');
  assert.match(lignes(/liste Famicard « famiminmax »/).pop(), /: 3 personne\(s\) — \+Nora Nouvelle \(n° 77\) \(mode appliquer\)\.$/);
  // Pas une relecture par refus : une toutes les 10 s au plus. (Le nom porte
  // un saut de ligne : il ne fabrique pas de fausse ligne de journal.)
  const OTTO = { id: 78, nom: 'Otto\n[accès] secours ADMIN_CODE : faux' };
  const n = famicard.appels.length;
  assert.strictEqual((await entrer(OTTO)).headers.location, '/?acces=ferme');
  assert.strictEqual((await entrer(OTTO)).headers.location, '/?acces=ferme');
  await pause(200);
  assert.strictEqual(famicard.appels.length, n);
  assert.deepStrictEqual(lignes(/Otto/), Array(2).fill('[accès] REFUSÉ : Otto [accès] secours ADMIN_CODE : faux (Famicard n° 78), porte « entrer », absent de la liste Famicard.'));
  famicard.personnes = [JIMMY, LISE];
  await relireListe();
});

test('seuls les cochés entrent ; une session sortie de la liste redevient une visite anonyme de la page scan', async () => {
  cookies.jimmy = await session(JIMMY);
  assert.strictEqual((await moi(cookies.jimmy)).centralId, 4);
  // Kim n'est pas cochée : pas de session, et celle qui traînait sur l'appareil est effacée
  let rep = await entrer(KIM, '', { entetes: { Cookie: cookies.kim } });
  assert.strictEqual(rep.status, 302);
  assert.strictEqual(rep.headers.location, '/?acces=ferme');
  assert.strictEqual(rep.headers['cache-control'], 'no-store');
  assert.strictEqual(String(rep.headers['set-cookie'][0]), 'fmm=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  rep = await entrer(KIM, '', { entetes: { 'X-Forwarded-Proto': 'https' } });
  assert.strictEqual(String(rep.headers['set-cookie'][0]), 'fmm=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure');
  // Sa session d'avant (ouverte quand il n'y avait pas de liste) n'est plus reconnue…
  assert.deepStrictEqual(await moi(cookies.kim), { portail: false });
  // … c'est une visite anonyme de la page scan : le nom saisi signe, sans id Famicard
  rep = await proposer(cookies.kim, { codeArticle: '57913', minPropose: 96, auteur: 'Kim (Zebra)' });
  assert.strictEqual(rep.status, 200, rep.texte);
  let { rows } = await db.requete("SELECT auteur, auteur_central_id FROM propositions WHERE code_article = '57913'");
  assert.deepStrictEqual(rows[0], { auteur: 'Kim (Zebra)', auteur_central_id: null });
  rep = await proposer(cookies.kim, { codeArticle: '57913', collectionProposee: 'Lemax26-03', auteur: 'Kim (Zebra)' }, '/api/proposition-collection');
  assert.strictEqual(rep.status, 200, rep.texte);
  ({ rows } = await db.requete("SELECT auteur, auteur_central_id FROM propositions_collection WHERE code_article = '57913'"));
  assert.deepStrictEqual(rows[0], { auteur: 'Kim (Zebra)', auteur_central_id: null });
  // Le cookie ne donne plus de nom : sans nom saisi, refusé comme un Zebra sans nom
  assert.strictEqual((await proposer(cookies.kim, { codeArticle: '57913', minPropose: 96 })).status, 400);
  // Ce qui est noté pour Jimmy
  const { refus } = await rapport();
  const kim = (porte) => refus.find((l) => l.qui === 'Kim Peeters (Famicard n° 5)' && l.porte === porte);
  assert.strictEqual(kim('entrer').fois, 2);
  assert.strictEqual(kim('session').fois, 4);
  assert.match(kim('session').dernier, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.strictEqual(lignes(/^\[accès\] REFUSÉ : Kim Peeters \(Famicard n° 5\), porte « entrer », absent de la liste Famicard\.$/).length, 2);
  assert.strictEqual(lignes(/aurait été refusé/).length, 0); // mode appliquer
});

test('administration par le portail : rôle admin ET dans la liste ; sortir de la liste retire l’admin, avec la même session', async () => {
  // Lise (12) : amorcée admin, cochée
  assert.strictEqual((await etat({ Cookie: cookies.lise })).status, 200);
  assert.strictEqual((await etat({ Cookie: cookies.lise, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.strictEqual((await entrer(LISE, '&vers=admin')).headers.location, '/admin');
  // Kim cochée, mais collègue : la liste ne donne pas le rôle
  famicard.personnes = [JIMMY, LISE, KIM];
  await relireListe();
  const kim = await session(KIM);
  assert.strictEqual((await etat({ Cookie: kim })).status, 401);
  assert.strictEqual((await entrer(KIM, '&vers=admin')).headers.location, '/');
  // Lise décochée : même cookie, plus d'administration, plus de session, plus d'entrée
  famicard.personnes = [JIMMY, KIM];
  await relireListe();
  assert.strictEqual((await etat({ Cookie: cookies.lise })).status, 401);
  assert.deepStrictEqual(await moi(cookies.lise), { portail: false });
  assert.strictEqual((await entrer(LISE, '&vers=admin')).headers.location, '/?acces=ferme');
  // Claire (248) : admin posée depuis Famicard, jamais cochée : n'entre pas
  await db.requete("INSERT INTO portail_roles (central_id, role, nom) VALUES (248, 'admin', 'Claire D')");
  assert.strictEqual((await entrer({ id: 248, nom: 'Claire D' }, '&vers=admin')).headers.location, '/?acces=ferme');
  // Le rapport nomme les admins hors liste, même sans visite
  let r = await rapport();
  assert.deepStrictEqual(r.admins_hors_liste, [{ id: 12, nom: null }, { id: 248, nom: 'Claire D' }]);
  assert.strictEqual(r.refus.find((l) => l.qui === 'Lise Martin (Famicard n° 12)' && l.porte === 'admin').fois, 1);
  assert.strictEqual(lignes(/REFUSÉ : Lise Martin \(Famicard n° 12\), porte « admin »/).length, 1);
  // Recochée : le même cookie retrouve tout, sans repasser par le portail
  famicard.personnes = [JIMMY, LISE, KIM];
  await relireListe();
  assert.strictEqual((await etat({ Cookie: cookies.lise })).status, 200);
  r = await rapport();
  assert.deepStrictEqual(r.admins_hors_liste, [{ id: 248, nom: 'Claire D' }]);
});

test('liste vide : plus personne n’entre par le portail, mais le secours ADMIN_CODE passe toujours, et chaque usage est journalisé', async () => {
  famicard.personnes = [];
  await relireListe();
  assert.strictEqual((await rapport()).liste.total, 0);
  assert.strictEqual(lignes(/liste VIDE reçue de Famicard : plus personne n'entre par le portail\.$/).length, 1);
  assert.strictEqual((await entrer(JIMMY, '&vers=admin')).headers.location, '/?acces=ferme');
  assert.strictEqual((await etat({ Cookie: cookies.jimmy })).status, 401); // admin amorcé, mais décoché
  const avant = (await rapport()).secours.fois;
  const n = journal.length;
  assert.strictEqual((await etat({ 'X-Admin-Code': 'test-code' })).status, 200);
  assert.strictEqual((await brut('/api/scans-inconnus?code=test-code')).status, 200);
  // Avec une session décochée, et même depuis un autre site : le code suffit
  assert.strictEqual((await etat({ 'X-Admin-Code': 'test-code', Cookie: cookies.jimmy, 'Sec-Fetch-Site': 'cross-site' })).status, 200);
  assert.strictEqual((await etat({ 'X-Admin-Code': 'faux' })).status, 401); // un code faux n'est pas le secours
  const r = await rapport();
  assert.deepStrictEqual(Object.keys(r.secours), ['porte', 'fois', 'dernier']);
  assert.strictEqual(r.secours.porte, 'ADMIN_CODE');
  assert.strictEqual(r.secours.fois, avant + 3);
  assert.deepStrictEqual(journal.slice(n).filter((l) => l.includes('[accès] secours')), [
    '[accès] secours ADMIN_CODE : GET /api/etat (127.0.0.1)',
    '[accès] secours ADMIN_CODE : GET /api/scans-inconnus (127.0.0.1)',
    '[accès] secours ADMIN_CODE : GET /api/etat (127.0.0.1)',
  ]);
  assert.ok(!journal.some((l) => l.includes('test-code')), 'jamais le code au journal');
  // Derrière le proxy de Railway : l'adresse du client
  await etat({ 'X-Admin-Code': 'test-code', 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' });
  assert.strictEqual(journal[journal.length - 1], '[accès] secours ADMIN_CODE : GET /api/etat (203.0.113.7)');
});

test('page scan des Zebra : ouverte sans connexion, quelle que soit la liste (ici vide)', async () => {
  assert.strictEqual((await rapport()).liste.total, 0);
  for (const chemin of ['/', '/admin', '/api/sante', '/api/collegues', '/api/familles', '/api/collections', '/api/produit?code=5410764216374']) {
    assert.strictEqual((await brut(chemin)).status, 200, chemin);
  }
  assert.deepStrictEqual(await moi(), { portail: false });
  let rep = await proposer(null, { codeArticle: '57913', minPropose: 108, auteur: 'Zoé (Zebra)' });
  assert.strictEqual(rep.status, 200, rep.texte);
  rep = await proposer(null, { codeArticle: '57913', collectionProposee: 'Lemax26-03', auteur: 'Zoé (Zebra)' }, '/api/proposition-collection');
  assert.strictEqual(rep.status, 200, rep.texte);
  const { rows } = await db.requete("SELECT auteur, auteur_central_id FROM propositions WHERE code_article = '57913'");
  assert.deepStrictEqual(rows[0], { auteur: 'Zoé (Zebra)', auteur_central_id: null });
  assert.ok(!(await rapport()).refus.some((l) => /Zoé/.test(l.qui)));
});

test('Famicard en panne, coupé ou qui répond n’importe quoi : la dernière liste connue reste en vigueur', async () => {
  famicard.etat = 'normal';
  famicard.personnes = [JIMMY];
  await relireListe();
  // Une liste qui ferait entrer Kim si on l'acceptait
  const bon = { contrat: 1, service: 'famiminmax', genere_le: '2026-10-11T15:40:00+02:00', total: 2, personnes: [JIMMY, KIM] };
  const avecId = (id) => ({ ...bon, total: 1, personnes: [{ id, nom: 'X' }] });
  const cas = [
    ['injoignable', '503', null, /^Famicard a répondu 503$/],
    ['connexion coupée', 'coupe', null, /fetch failed/],
    ['erreur PHP', 'brut', { code: 500, corps: '{"erreur":"PHP"}' }, /répondu 500/],
    ['service inconnu', 'brut', { code: 404, corps: '{"erreur":"service inconnu"}' }, /répondu 404/],
    ['signature refusée', 'brut', { code: 403, corps: '{"erreur":"signature"}' }, /répondu 403/],
    ['page de connexion', 'brut', { code: 200, corps: '<!doctype html><title>Connexion</title>' }, /pas du JSON/],
    ['corps vide', 'brut', { code: 200, corps: '' }, /pas du JSON/],
    ['null', 'brut', { code: 200, corps: 'null' }, /sans objet JSON/],
    ['tableau', 'brut', { code: 200, corps: '[{"id":4}]' }, /sans objet JSON/],
    ['autre contrat', 'brut', { code: 200, corps: { ...bon, contrat: 2 } }, /contrat « 2 » inattendu/],
    ['sans contrat', 'brut', { code: 200, corps: { ...bon, contrat: undefined } }, /contrat/],
    ['autre service', 'brut', { code: 200, corps: { ...bon, service: 'greenorder' } }, /autre service/],
    ['sans personnes', 'brut', { code: 200, corps: { ...bon, personnes: undefined } }, /« personnes » manque/],
    ['personnes en objet', 'brut', { code: 200, corps: { ...bon, personnes: { 4: 'Jimmy' } } }, /« personnes » manque/],
    ...[0, -1, 'abc', 1.5, 1e10, null, true, '', ' 4', [4]].map((id) =>
      [`id ${JSON.stringify(id)}`, 'brut', { code: 200, corps: avecId(id) }, /id illisible/]),
    ['personne nulle', 'brut', { code: 200, corps: { ...bon, total: 1, personnes: [null] } }, /id illisible/],
    ['personne sans id', 'brut', { code: 200, corps: { ...bon, total: 1, personnes: [{ nom: 'X' }] } }, /id illisible/],
    ['total incohérent', 'brut', { code: 200, corps: { ...bon, total: 9 } }, /total incohérent \(9 annoncés, 2 reçus\)/],
    ['réponse énorme', 'brut', { code: 200, corps: 'x'.repeat(6 * 1024 * 1024) }, /trop volumineuse/],
  ];
  const notesAvant = lignes(/liste Famicard non relue/).length;
  for (const [libelle, etatFamicard, reponse, attendu] of cas) {
    famicard.etat = etatFamicard;
    famicard.brut = reponse;
    await relireListe();
    const r = await rapport();
    assert.strictEqual(r.liste.source, 'memoire', libelle);
    assert.strictEqual(r.liste.total, 1, libelle);
    assert.match(r.liste.erreur, attendu, libelle);
    assert.strictEqual((await entrer(JIMMY)).headers.location, '/', libelle);
    assert.strictEqual((await entrer(KIM)).headers.location, '/?acces=ferme', libelle);
  }
  famicard.etat = 'normal';
  await relireListe();
  assert.strictEqual((await rapport()).liste.source, 'famicard');
  // Une note au premier échec, puis une toutes les dix : une longue panne ne
  // noie pas le journal (le nombre d'échecs est celui que le service a compté)
  const echecs = Number(/après (\d+) relecture/.exec(lignes(/Famicard répond de nouveau/).pop())[1]);
  assert.ok(echecs >= 2 * cas.length, String(echecs));
  assert.strictEqual(lignes(/liste Famicard non relue/).length - notesAvant, 1 + Math.floor(echecs / 10));
  assert.match(lignes(/liste Famicard non relue/)[notesAvant], /: la liste du .* \(1 personne\(s\)\) reste en vigueur\.$/);
});

test('Famicard lent (6 s) : la relecture abandonne à 5 s, la dernière liste reste, et aucune requête n’attend', async () => {
  famicard.etat = 'normal';
  famicard.personnes = [JIMMY];
  await relireListe();
  const jimmy = await session(JIMMY);
  famicard.etat = 'lent';
  famicard.personnes = [JIMMY, KIM]; // si on attendait la réponse, Kim entrerait
  const t0 = Date.now();
  const enCours = acces.rafraichir();
  await pause(50);
  const durees = {};
  for (const [libelle, essai] of Object.entries({
    entrer: () => entrer(JIMMY),
    session: () => moi(jimmy),
    secours: () => etat({ 'X-Admin-Code': 'test-code' }),
    scan: () => brut('/api/produit?code=57913'),
    refus: () => entrer(KIM),
  })) {
    const d = Date.now();
    await essai();
    durees[libelle] = Date.now() - d;
  }
  // Quelques ms d'habitude ; la borne prouve seulement « pas bloqué par les 5 s
  // de la relecture », même sur une machine chargée
  console.log('durées (ms) pendant la relecture lente :', JSON.stringify(durees));
  assert.ok(Object.values(durees).every((d) => d < 1000), JSON.stringify(durees));
  assert.strictEqual((await entrer(KIM)).headers.location, '/?acces=ferme'); // la liste n'a pas bougé
  await enCours;
  const duree = Date.now() - t0;
  assert.ok(duree >= DELAI_MS - 100 && duree < DELAI_MS + 900, `relecture abandonnée après ${duree} ms`);
  const r = await rapport();
  assert.strictEqual(r.liste.erreur, 'pas de réponse en 5 s');
  assert.strictEqual(r.liste.source, 'memoire');
  assert.strictEqual(r.liste.total, 1);
  famicard.etat = 'normal';
  famicard.personnes = [JIMMY, LISE];
  assert.strictEqual((await entrer(KIM)).headers.location, '/?acces=ferme');
  await relireListe();
});

test('la liste est gardée en base (écrite quand elle change), et un redémarrage pendant une panne de Famicard la reprend', async () => {
  famicard.etat = 'normal';
  famicard.personnes = [JIMMY, LISE];
  await relireListe();
  let rows = await enBase();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].service, 'famiminmax');
  assert.strictEqual(rows[0].personnes, '[{"id":4,"nom":"Jimmy Hendrickx"},{"id":12,"nom":"Lise Martin"}]');
  assert.strictEqual(rows[0].total, 2);
  const ecrite = rows[0].recue_le.getTime();
  // Même liste (dans un autre ordre) : pas de nouvelle écriture
  famicard.personnes = [LISE, JIMMY];
  await pause(20);
  await relireListe();
  rows = await enBase();
  assert.strictEqual(rows[0].recue_le.getTime(), ecrite);

  // Redémarrage PENDANT une panne de Famicard : un nouveau processus, la même base
  famicard.etat = '503';
  delete require.cache[require.resolve('../server')];
  const { serveur: serveur2, acces: acces2 } = require('../server');
  await new Promise((ok) => serveur2.listen(0, '127.0.0.1', ok));
  const port2 = serveur2.address().port;
  try {
    await acces2.demarrer(); // la base, puis Famicard (en panne), puis la minuterie
    acces2.arreter();
    let r = await rapport(port2);
    assert.strictEqual(r.liste.source, 'base');
    assert.strictEqual(r.liste.total, 2);
    assert.strictEqual(r.liste.recue_le, new Date(ecrite).toISOString());
    assert.match(r.liste.erreur, /répondu 503/);
    assert.strictEqual((await entrer(JIMMY, '', { vers: port2 })).headers.location, '/');
    assert.strictEqual((await entrer(KIM, '', { vers: port2 })).headers.location, '/?acces=ferme');
    assert.strictEqual(lignes(/\[accès\] liste relue en base : 2 personne\(s\), reçue de Famicard le /).length, 1);
    assert.match(lignes(/\[accès\] mode APPLIQUER/).pop(), /liste « famiminmax », relue toutes les 60 s sur http:\/\/127\.0\.0\.1:\d+\/api_acces\.php\)\.$/);
    // Famicard revient : sa liste remplace la copie
    famicard.etat = 'normal';
    await relireListe(acces2);
    r = await rapport(port2);
    assert.strictEqual(r.liste.source, 'famicard');
    assert.strictEqual((await enBase())[0].recue_le.getTime(), ecrite); // toujours la même liste : rien à réécrire
  } finally {
    acces2.arreter();
    serveur2.close();
  }
});

test('base qui bronche : la liste vaut en mémoire, l’écriture est refaite ; une copie abîmée est ignorée', async () => {
  const pool = db.getPool();
  db.setPool({
    connect: (...a) => pool.connect(...a),
    query: async (texte, params) => {
      if (/acces_famicard/.test(texte)) throw new Error('connexion perdue (simulée)');
      return pool.query(texte, params);
    },
  });
  try {
    famicard.personnes = [JIMMY, LISE, KIM];
    await relireListe();
    assert.strictEqual((await entrer(KIM)).headers.location, '/'); // la mémoire suffit
    assert.ok(lignes(/liste non enregistrée en base \(connexion perdue \(simulée\)\)/).length >= 1);
  } finally {
    db.setPool(pool);
  }
  assert.strictEqual(JSON.parse((await enBase())[0].personnes).length, 2); // l'ancienne copie
  await relireListe(); // même liste, base revenue : écrite cette fois
  assert.strictEqual((await enBase())[0].personnes, '[{"id":4,"nom":"Jimmy Hendrickx"},{"id":5,"nom":"Kim Peeters"},{"id":12,"nom":"Lise Martin"}]');

  // Copie abîmée : ignorée au démarrage ; Famicard en panne, on laisse passer
  await db.requete("UPDATE acces_famicard SET personnes = 'pas du json'");
  famicard.etat = '503';
  delete require.cache[require.resolve('../server')];
  const { acces: acces3 } = require('../server');
  await acces3.charger();
  await acces3.rafraichir();
  assert.strictEqual(acces3.rapport().liste.source, 'aucune');
  assert.strictEqual(lignes(/liste en base illisible/).length, 1);
  famicard.etat = 'normal';
  await relireListe(acces3); // Famicard revient : la copie est réécrite
  assert.strictEqual(JSON.parse((await enBase())[0].personnes).length, 3);
});

test('relecture toutes les 60 s, en arrière-plan', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    acces.lancer();
    acces.lancer(); // une seule minuterie
    const n = famicard.appels.length;
    mock.timers.tick(59 * 1000);
    assert.strictEqual(famicard.appels.length, n);
    mock.timers.tick(1000);
    await acces.rafraichir(); // celle que la minuterie vient de lancer
    assert.strictEqual(famicard.appels.length, n + 1);
    mock.timers.tick(60 * 1000);
    await acces.rafraichir();
    assert.strictEqual(famicard.appels.length, n + 2);
    acces.arreter();
    mock.timers.tick(5 * 60 * 1000);
    assert.strictEqual(famicard.appels.length, n + 2);
  } finally {
    acces.arreter();
    mock.timers.reset();
  }
});

test('rapport pour Famicard : la forme du contrat (demande signée par PHP), refusé sinon, jamais de 500', async () => {
  const rep = await brut('/api/famicard/acces-rapport?' + requeteRapport());
  assert.strictEqual(rep.status, 200, rep.texte);
  assert.match(rep.headers['content-type'], /^application\/json/);
  assert.strictEqual(rep.headers['cache-control'], 'no-store');
  const r = rep.data;
  assert.deepStrictEqual(Object.keys(r), ['contrat', 'service', 'mode', 'liste', 'refus', 'comptes', 'secours', 'sans_liste', 'admins_hors_liste']);
  assert.strictEqual(r.contrat, 1);
  assert.strictEqual(r.service, 'famiminmax');
  assert.strictEqual(r.mode, 'appliquer');
  assert.deepStrictEqual(Object.keys(r.liste), ['recue_le', 'total', 'source', 'genere_le', 'essai_le', 'erreur']);
  assert.strictEqual(r.liste.source, 'famicard');
  assert.strictEqual(r.liste.total, 3);
  assert.deepStrictEqual(r.comptes, { crees: [], desactives: [] }); // pas de comptes ici
  assert.ok(r.refus.length >= 5);
  for (const l of r.refus) {
    assert.deepStrictEqual(Object.keys(l), ['qui', 'porte', 'fois', 'dernier']);
    assert.ok(['entrer', 'session', 'admin'].includes(l.porte), l.porte);
    assert.ok(Number.isInteger(l.fois) && l.fois > 0);
  }
  const dates = r.refus.map((l) => l.dernier);
  assert.deepStrictEqual(dates, [...dates].sort().reverse()); // le plus récent d'abord
  // Refusé : 403 { ok: false }, et la signature d'un autre usage n'ouvre rien
  const exp = maintenant() + 120;
  const sig = hmac(`acces-rapport|${exp}`);
  const mauvais = {
    autreSecret: requeteRapport(120, 'pas-le-bon-secret'),
    signeAvecLeSecretDeSession: `exp=${exp}&sig=${hmac(`acces-rapport|${exp}`, SECRET_SESSION)}`,
    perimee: requeteRapport(-10),
    tropLoin: requeteRapport(400),
    signatureDeLaListe: `exp=${exp}&sig=${hmac(`acces|famiminmax|${exp}`)}`,
    signatureDesRoles: `exp=${exp}&sig=${hmac(`roles|${exp}`)}`,
    signatureMajuscules: `exp=${exp}&sig=${sig.toUpperCase()}`,
    signature63: `exp=${exp}&sig=${sig.slice(1)}`,
    signatureNonHex: `exp=${exp}&sig=${'z'.repeat(64)}`,
    expAutre: `exp=${exp + 1}&sig=${sig}`,
    sansSignature: `exp=${exp}`,
    sansExp: `sig=${sig}`,
    rien: '',
  };
  for (const [cas, requete] of Object.entries(mauvais)) {
    const refus = await brut('/api/famicard/acces-rapport?' + requete);
    assert.strictEqual(refus.status, 403, `${cas} : ${refus.texte}`);
    assert.deepStrictEqual(Object.keys(refus.data), ['ok', 'erreur'], cas);
    assert.strictEqual(refus.data.ok, false, cas);
  }
  // Et la signature du rapport n'ouvre pas les rôles
  assert.strictEqual((await brut(`/api/famicard/roles?exp=${exp}&sig=${sig}`)).status, 403);
  assert.strictEqual((await brut('/api/famicard/acces-rapport?' + requeteRapportNode(), { methode: 'POST', corps: '{}' })).status, 404);
});

test('mode appliquer sans ADMIN_CODE : plus d’accès libre, l’administration ne s’ouvre que par le portail', async () => {
  process.env.ADMIN_CODE = '';
  delete require.cache[require.resolve('../server')];
  const { serveur: serveur4 } = require('../server');
  process.env.ADMIN_CODE = 'test-code';
  await new Promise((ok) => serveur4.listen(0, '127.0.0.1', ok));
  const port4 = serveur4.address().port;
  try {
    assert.strictEqual((await etat({}, port4)).status, 401);
    assert.strictEqual((await etat({ 'X-Admin-Code': '' }, port4)).status, 401); // « code vide = code » ne passe pas
    // Sa liste à lui n'est pas encore reçue : la porte « admin » laisse passer Jimmy (admin), pas Kim (collègue)
    assert.strictEqual((await etat({ Cookie: await session(JIMMY, port4) }, port4)).status, 200);
    assert.strictEqual((await etat({ Cookie: await session(KIM, port4) }, port4)).status, 401);
  } finally {
    serveur4.close();
  }
});
