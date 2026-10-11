'use strict';
// Porte du portail : /entrer, /sortir, /api/moi, nom signé des propositions,
// administration par le portail. Base pg-mem, comme e2e.test.js.
//
// Le laissez-passer est fabriqué par le VRAI PHP quand il est là (formule de
// famitask.php, lignes 57-60, recopiée telle quelle) : c'est la preuve que ce
// que signe Famiportail passe ici. Sans PHP, même formule écrite en Node.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { newDb } = require('pg-mem');

const SECRET_PORTAIL = 'secret-portail-de-test-0123456789abcdef';
const SECRET_SESSION = 'secret-session-de-test-fedcba9876543210';
// Lus au chargement de server.js, comme ADMIN_CODE : à poser AVANT le require.
process.env.ADMIN_CODE = 'test-code';
process.env.FAMIMINMAX_SECRET = SECRET_PORTAIL;
process.env.FAMIMINMAX_SESSION_SECRET = SECRET_SESSION;
process.env.FAMIMINMAX_ADMINS = '4, 12';
process.env.FAMIPORTAIL_URL = 'https://portail.exemple.test/';

const db = require('../lib/db');
const { serveur, amorcerRoles } = require('../server');

const PHP = process.env.PHP_BIN || 'C:/Users/enyls/php/php.exe';
const PHP_OK = fs.existsSync(PHP);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// famitask.php, lignes 57-60, à l'identique ; seule l'entrée change ($moi vient
// de l'environnement, prénom et nom en base64 pour que les accents traversent
// Windows intacts).
const FORMULE_PHP = `
$secret = getenv('S');
$moi = ['id' => getenv('I'), 'prenom' => base64_decode(getenv('P')), 'nom' => base64_decode(getenv('N'))];
$corps  = ((int) $moi['id']) . '|' . (time() + (int) getenv('D')) . '|'
        . trim(((string) ($moi['prenom'] ?? '')) . ' ' . ((string) ($moi['nom'] ?? '')));
$charge = rtrim(strtr(base64_encode($corps), '+/', '-_'), '=');   // base64url, comme Node
echo $charge . '.' . hash_hmac('sha256', $charge, $secret);`;

function jetonPhp(id, prenom, nom, duree = 60, secret = SECRET_PORTAIL) {
  return execFileSync(PHP, ['-r', FORMULE_PHP], {
    env: { ...process.env, S: secret, I: String(id), P: b64(prenom), N: b64(nom), D: String(duree) },
  }).toString().trim();
}
function jetonNode(id, prenom, nom, duree = 60, secret = SECRET_PORTAIL) {
  const corps = `${id}|${Math.floor(Date.now() / 1000) + duree}|${`${prenom} ${nom}`.trim()}`;
  const charge = Buffer.from(corps, 'utf8').toString('base64url');
  return charge + '.' + crypto.createHmac('sha256', secret).update(charge).digest('hex');
}
const jeton = PHP_OK ? jetonPhp : jetonNode;

let port;

// Requête brute (http.request) : aucun cookie, aucune redirection suivie,
// en-têtes posés tels quels (Sec-Fetch-Site compris).
function brut(chemin, { methode = 'GET', entetes = {}, corps } = {}) {
  return new Promise((ok, ko) => {
    const req = http.request({ host: '127.0.0.1', port, path: chemin, method: methode, headers: entetes }, (rep) => {
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
const entrer = (j, suite = '', entetes = {}) => brut('/entrer?j=' + encodeURIComponent(j) + suite, { entetes });
const cookieDe = (rep) => String((rep.headers['set-cookie'] || [])[0] || '').split(';')[0];
const moi = async (cookie) => (await brut('/api/moi', { entetes: cookie ? { Cookie: cookie } : {} })).data;
const proposer = (cookie, corps) => brut('/api/proposition', {
  methode: 'POST', entetes: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, corps,
});

before(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  db.setPool(new Pool());
  await db.initSchema();
  // Redémarrage : les migrations facultatives se rejouent sans erreur (pg-mem
  // ne sait pas rejouer tout initSchema, d'où les deux lignes à la main)
  await db.requete('ALTER TABLE propositions ADD COLUMN IF NOT EXISTS auteur_central_id INTEGER');
  await db.requete('ALTER TABLE propositions_collection ADD COLUMN IF NOT EXISTS auteur_central_id INTEGER');
  // Ce que fait demarrer() : la table des rôles, vide, reçoit FAMIMINMAX_ADMINS
  // (4 et 12) en admin. Les tests d'administration ci-dessous passent par elle.
  await amorcerRoles();
  await db.requete("INSERT INTO produits (code_article, ean, description, stock_min) VALUES ('57913', '5410764216374', 'Goudspray 150ml', 120)");
  await db.requete("INSERT INTO collections (nom) VALUES ('Lemax26-03')");
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  port = serveur.address().port;
});

after(() => serveur.close());

test('PHP portable disponible pour la preuve de compatibilité', { skip: !PHP_OK && 'php.exe absent' }, () => {
  const j = jetonPhp(4, 'Jimmy', 'Hendrickx');
  assert.match(j, /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/); // base64url sans « = », signature hex
});

test('sans cookie : /api/moi dit « pas de portail »', async () => {
  assert.deepStrictEqual(await moi(), { portail: false });
});

test('jeton du portail valide : session posée, retour à la page scan', async () => {
  const rep = await entrer(jeton(4, 'Jimmy', 'Hendrickx'));
  assert.strictEqual(rep.status, 302);
  assert.strictEqual(rep.headers.location, '/');
  const c = String(rep.headers['set-cookie'][0]);
  assert.match(c, /^fmm=[A-Za-z0-9_-]+\.[0-9a-f]{64}; /);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=28800/);
  assert.doesNotMatch(c, /Secure/); // http en local
  const { resteMs, ...reste } = await moi(cookieDe(rep));
  assert.deepStrictEqual(reste, {
    portail: true, nom: 'Jimmy Hendrickx', centralId: 4, portailUrl: 'https://portail.exemple.test',
  });
  // Durée restante de la session (8 h), pour que la page oublie le nom ensuite
  assert.ok(resteMs > 8 * 3600 * 1000 - 60000 && resteMs <= 8 * 3600 * 1000, String(resteMs));
});

test('derrière le proxy https de Railway : cookie Secure', async () => {
  const rep = await entrer(jeton(4, 'Jimmy', 'Hendrickx'), '', { 'X-Forwarded-Proto': 'https' });
  assert.strictEqual(rep.status, 302);
  assert.match(String(rep.headers['set-cookie'][0]), /; Secure/);
});

test('noms accentués, avec « | », et les trois longueurs de base64 (padding retiré par PHP)', async () => {
  for (const [prenom, nom] of [['Zoë', 'Dupont-Lefèvre'], ['Ана', 'Коваль'], ['Jean', 'A|B'], ['Al', 'Bo'], ['Ali', 'Bob'], ['Alix', 'Bobo']]) {
    const rep = await entrer(jeton(77, prenom, nom));
    assert.strictEqual(rep.status, 302, prenom + ' ' + nom);
    assert.strictEqual(rep.headers.location, '/');
    assert.strictEqual((await moi(cookieDe(rep))).nom, `${prenom} ${nom}`);
  }
});

test('fiche sans prénom ni nom : on signe avec l’id', async () => {
  const rep = await entrer(jeton(7, '', ''));
  assert.strictEqual(rep.status, 302);
  assert.strictEqual((await moi(cookieDe(rep))).nom, 'Famicard n° 7');
});

test('jetons refusés : retour à /?acces=refuse, jamais de 500', async () => {
  const bon = jetonNode(4, 'Jimmy', 'Hendrickx');
  const [charge, sig] = bon.split('.');
  const mauvais = {
    perime: jeton(4, 'Jimmy', 'Hendrickx', -120),
    autreSecret: jeton(4, 'Jimmy', 'Hendrickx', 60, 'pas-le-bon-secret'),
    signeAvecLeSecretDeSession: jetonNode(4, 'Jimmy', 'Hendrickx', 60, SECRET_SESSION),
    signatureCourte: charge + '.abc',
    signature63: charge + '.' + sig.slice(1),
    signatureMajuscules: charge + '.' + sig.toUpperCase(),
    signatureNonHex: charge + '.' + 'z'.repeat(64),
    chargeModifiee: charge.slice(0, -2) + 'AA.' + sig,
    sansPoint: charge + sig,
    pointSeul: '.',
    vide: '',
    idNonNumerique: (() => {
      const c = Buffer.from(`abc|${Math.floor(Date.now() / 1000) + 60}|X`).toString('base64url');
      return c + '.' + crypto.createHmac('sha256', SECRET_PORTAIL).update(c).digest('hex');
    })(),
    sansExpiration: (() => {
      const c = Buffer.from('4').toString('base64url');
      return c + '.' + crypto.createHmac('sha256', SECRET_PORTAIL).update(c).digest('hex');
    })(),
    chargeIllisible: (() => {
      const c = '%%%***';
      return c + '.' + crypto.createHmac('sha256', SECRET_PORTAIL).update(c).digest('hex');
    })(),
  };
  for (const [cas, j] of Object.entries(mauvais)) {
    const rep = await entrer(j);
    assert.strictEqual(rep.status, 302, cas);
    assert.strictEqual(rep.headers.location, '/?acces=refuse', cas);
    assert.strictEqual(rep.headers['set-cookie'], undefined, cas);
  }
  // Sans paramètre j du tout
  const sansJ = await brut('/entrer');
  assert.strictEqual(sansJ.status, 302);
  assert.strictEqual(sansJ.headers.location, '/?acces=refuse');
});

test('cookie fabriqué ou abîmé : ignoré, comme s’il n’y en avait pas', async () => {
  const cookie = cookieDe(await entrer(jeton(4, 'Jimmy', 'Hendrickx')));
  // Le laissez-passer du portail n'est PAS un cookie : secrets distincts
  assert.deepStrictEqual(await moi('fmm=' + jetonNode(4, 'Jimmy', 'Hendrickx', 3600)), { portail: false });
  assert.deepStrictEqual(await moi(cookie.slice(0, -1) + (cookie.endsWith('0') ? '1' : '0')), { portail: false });
  assert.deepStrictEqual(await moi('fmm=%E0%A4%A'), { portail: false }); // encodage cassé : pas de 500
  assert.deepStrictEqual(await moi('autre=1; fmm=; x=2'), { portail: false });
  // Le bon cookie au milieu d'autres
  assert.strictEqual((await moi('autre=1; ' + cookie + '; x=2')).centralId, 4);
});

test('proposition avec session portail : le nom vient du jeton, pas du navigateur', async () => {
  const cookie = cookieDe(await entrer(jeton(4, 'Jimmy', 'Hendrickx')));
  let rep = await proposer(cookie, { codeArticle: '57913', minPropose: 96, auteur: 'Quelqu’un d’autre' });
  assert.strictEqual(rep.status, 200, rep.texte);
  let { rows } = await db.requete("SELECT auteur, auteur_central_id FROM propositions WHERE code_article = '57913'");
  assert.strictEqual(rows[0].auteur, 'Jimmy Hendrickx');
  assert.strictEqual(rows[0].auteur_central_id, 4);

  // Sans nom dans le corps : accepté, le jeton suffit
  rep = await proposer(cookie, { codeArticle: '57913', minPropose: 108 });
  assert.strictEqual(rep.status, 200, rep.texte);

  // Puis un Zebra en libre-service écrase : son nom, et plus d'id Famicard
  rep = await proposer(null, { codeArticle: '57913', minPropose: 120, auteur: 'Kim' });
  assert.strictEqual(rep.status, 200, rep.texte);
  ({ rows } = await db.requete("SELECT auteur, auteur_central_id FROM propositions WHERE code_article = '57913'"));
  assert.strictEqual(rows[0].auteur, 'Kim');
  assert.strictEqual(rows[0].auteur_central_id, null);

  // Zebra sans nom : toujours refusé, comme avant
  rep = await proposer(null, { codeArticle: '57913', minPropose: 120 });
  assert.strictEqual(rep.status, 400);
});

test('deux propositions qui se croisent : l’id Famicard ne passe pas sur la ligne de l’autre', async () => {
  const cookie = cookieDe(await entrer(jeton(4, 'Jimmy', 'Hendrickx')));
  // On retient l'UPDATE de Jimmy jusqu'à ce que Kim (Zebra) ait écrasé la
  // proposition : c'est l'ordre défavorable, rare mais possible en magasin.
  const pool = db.getPool();
  let lacher;
  const retenu = new Promise((ok) => { lacher = ok; });
  db.setPool({
    connect: (...a) => pool.connect(...a),
    query: async (texte, params) => {
      if (/SET auteur_central_id/.test(texte) && params && String(params[0]) === '4') await retenu;
      return pool.query(texte, params);
    },
  });
  try {
    const jimmy = proposer(cookie, { codeArticle: '57913', minPropose: 60 });
    await new Promise((ok) => setTimeout(ok, 100)); // l'INSERT de Jimmy est passé
    const kim = await proposer(null, { codeArticle: '57913', minPropose: 72, auteur: 'Kim' });
    assert.strictEqual(kim.status, 200, kim.texte);
    lacher();
    assert.strictEqual((await jimmy).status, 200);
  } finally {
    db.setPool(pool);
  }
  const { rows } = await db.requete("SELECT auteur, min_propose, auteur_central_id FROM propositions WHERE code_article = '57913'");
  assert.strictEqual(rows[0].auteur, 'Kim');
  assert.strictEqual(rows[0].min_propose, 72);
  assert.strictEqual(rows[0].auteur_central_id, null); // et pas 4
});

test('proposition de collection avec session portail : même règle', async () => {
  const cookie = cookieDe(await entrer(jeton(12, 'Lise', 'Martin')));
  const rep = await brut('/api/proposition-collection', {
    methode: 'POST', entetes: { 'Content-Type': 'application/json', Cookie: cookie },
    corps: { codeArticle: '57913', collectionProposee: 'Lemax26-03', auteur: 'Usurpateur' },
  });
  assert.strictEqual(rep.status, 200, rep.texte);
  const { rows } = await db.requete("SELECT auteur, auteur_central_id FROM propositions_collection WHERE code_article = '57913'");
  assert.strictEqual(rows[0].auteur, 'Lise Martin');
  assert.strictEqual(rows[0].auteur_central_id, 12);
});

test('administration : session portail d’un id listé, sinon le code comme avant', async () => {
  const admin = cookieDe(await entrer(jeton(4, 'Jimmy', 'Hendrickx')));
  const pasAdmin = cookieDe(await entrer(jeton(5, 'Kim', 'Peeters')));

  assert.strictEqual((await brut('/api/etat')).status, 401);
  assert.strictEqual((await brut('/api/etat', { entetes: { Cookie: pasAdmin } })).status, 401);
  assert.strictEqual((await brut('/api/etat', { entetes: { Cookie: admin } })).status, 200);
  // Ce que fait admin.html : fetch même origine, en-tête de code vide
  assert.strictEqual((await brut('/api/etat', { entetes: { Cookie: admin, 'X-Admin-Code': '', 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  // Un vieux code faux dans le navigateur n'empêche pas la session
  assert.strictEqual((await brut('/api/etat', { entetes: { Cookie: admin, 'X-Admin-Code': 'ancien' } })).status, 200);
  // Depuis un autre site, le cookie ne suffit pas (GET /api/export change l'état)
  assert.strictEqual((await brut('/api/export?type=min', { entetes: { Cookie: admin, 'Sec-Fetch-Site': 'cross-site' } })).status, 401);
  assert.strictEqual((await brut('/api/etat', { entetes: { Cookie: admin, 'Sec-Fetch-Site': 'same-site' } })).status, 401);
  // Le code partagé reste valable, avec ou sans session
  assert.strictEqual((await brut('/api/etat', { entetes: { 'X-Admin-Code': 'test-code' } })).status, 200);
  assert.strictEqual((await brut('/api/etat', { entetes: { 'X-Admin-Code': 'test-code', 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
  assert.strictEqual((await brut('/api/etat', { entetes: { Cookie: pasAdmin, 'X-Admin-Code': 'test-code' } })).status, 200);
});

test('/entrer?vers=admin : seulement pour un id listé', async () => {
  assert.strictEqual((await entrer(jeton(4, 'Jimmy', 'Hendrickx'), '&vers=admin')).headers.location, '/admin');
  assert.strictEqual((await entrer(jeton(5, 'Kim', 'Peeters'), '&vers=admin')).headers.location, '/');
  assert.strictEqual((await entrer(jeton(4, 'Jimmy', 'Hendrickx'), '&vers=https://ailleurs.test')).headers.location, '/');
});

test('/sortir : la session se ferme, retour à la page scan', async () => {
  const rep = await brut('/sortir');
  assert.strictEqual(rep.status, 302);
  assert.strictEqual(rep.headers.location, '/');
  assert.match(String(rep.headers['set-cookie'][0]), /^fmm=; .*Max-Age=0/);
  // Derrière https, effacé avec les mêmes attributs qu'à la pose
  const https = await brut('/sortir', { entetes: { 'X-Forwarded-Proto': 'https' } });
  assert.match(String(https.headers['set-cookie'][0]), /^fmm=; .*Max-Age=0; Secure$/);
});

test('page scan et API publiques inchangées sans session', async () => {
  assert.strictEqual((await brut('/')).status, 200);
  assert.strictEqual((await brut('/admin')).status, 200);
  assert.strictEqual((await brut('/api/sante')).status, 200);
  assert.strictEqual((await brut('/api/collegues')).status, 200);
  assert.strictEqual((await brut('/api/produit?code=5410764216374')).status, 200);
});

test('en-tête Host illisible : 400, et le serveur reste debout', async () => {
  const reponse = await new Promise((ok, ko) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /api/sante HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n'));
    let tout = '';
    s.on('data', (d) => { tout += d; });
    s.on('end', () => ok(tout));
    s.on('error', ko);
  });
  assert.match(reponse, /^HTTP\/1\.1 200/); // la base n'utilise plus le Host : la route répond
  const absolue = await new Promise((ok, ko) => {
    // Cible absolue que Node laisse passer mais que new URL() refuse : c'est
    // notre try/catch qui répond, pas l'analyseur HTTP
    const s = net.connect(port, '127.0.0.1', () => s.write('GET http://a%zz/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let tout = '';
    s.on('data', (d) => { tout += d; });
    s.on('end', () => ok(tout));
    s.on('error', ko);
  });
  assert.match(absolue, /^HTTP\/1\.1 400/);
  assert.strictEqual((await brut('/api/sante')).status, 200); // toujours vivant
});
