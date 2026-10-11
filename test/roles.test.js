'use strict';
// Rôles pour Famicard (contrat « rôles par service ») : GET /api/famicard/roles,
// POST /api/famicard/role, l'amorçage de portail_roles par FAMIMINMAX_ADMINS, et
// l'administration par le portail qui suit la table. Base pg-mem, comme
// portail.test.js.
//
// Les demandes de Famicard sont fabriquées par le VRAI PHP quand il est là
// (formules de includes/famitask_roles.php de Famicard, lignes 54-55 et 236-243,
// réduites aux champs du contrat ; le corps sort de json_encode) : c'est la
// preuve que ce que signera Famicard passe ici. Sans PHP, mêmes formules en Node.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { newDb } = require('pg-mem');

const SECRET = 'secret-portail-de-test-0123456789abcdef';
const SECRET_SESSION = 'secret-session-de-test-fedcba9876543210';
// Lus au chargement de server.js : à poser AVANT le require.
process.env.ADMIN_CODE = 'test-code';
process.env.FAMIMINMAX_SECRET = SECRET;
process.env.FAMIMINMAX_SESSION_SECRET = SECRET_SESSION;
// Des entrées illisibles au milieu : ignorées, pas fatales
process.env.FAMIMINMAX_ADMINS = ' 4 , abc, 0, -2, 12 ';

const db = require('../lib/db');
const { serveur, amorcerRoles } = require('../server');

const PHP = process.env.PHP_BIN || 'C:/Users/enyls/php/php.exe';
const PHP_OK = fs.existsSync(PHP);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const hmac = (message, secret = SECRET) => crypto.createHmac('sha256', secret).update(message).digest('hex');
const maintenant = () => Math.floor(Date.now() / 1000);

// famitask_roles.php, lignes 54-55 : la lecture
const PHP_LECTURE = `
$secret = getenv('S');
$exp = time() + (int) getenv('D');
$sig = hash_hmac('sha256', 'roles|' . $exp, $secret);
echo 'exp=' . $exp . '&sig=' . $sig;`;

// famitask_roles.php, lignes 236-243, sans compte ni équipe (le contrat n'en a
// pas) ; le nom en base64 pour que les accents traversent Windows intacts
const PHP_ECRITURE = `
$secret = getenv('S');
$userId = (int) getenv('C');
$nom    = trim((string) base64_decode(getenv('N')));
$role   = (string) getenv('R');
$exp    = time() + (int) getenv('D');
$sig    = hash_hmac('sha256', 'role|' . $userId . '|' . $role . '|' . $nom . '|' . $exp, $secret);
echo json_encode(['centralId' => $userId, 'role' => $role, 'nom' => $nom, 'exp' => $exp, 'sig' => $sig]);`;

const php = (code, env) => execFileSync(PHP, ['-r', code], { env: { ...process.env, ...env } }).toString().trim();
const lecturePhp = (duree = 120, secret = SECRET) => php(PHP_LECTURE, { S: secret, D: String(duree) });
const ecriturePhp = (centralId, role, nom, duree = 120, secret = SECRET) =>
  php(PHP_ECRITURE, { S: secret, C: String(centralId), R: role, N: b64(nom), D: String(duree) });

function lectureNode(duree = 120, secret = SECRET) {
  const exp = maintenant() + duree;
  return `exp=${exp}&sig=${hmac(`roles|${exp}`, secret)}`;
}
function ecritureNode(centralId, role, nom, duree = 120, secret = SECRET) {
  const exp = maintenant() + duree;
  nom = nom.trim();
  return JSON.stringify({ centralId, role, nom, exp, sig: hmac(`role|${centralId}|${role}|${nom}|${exp}`, secret) });
}
const lecture = PHP_OK ? lecturePhp : lectureNode;
const ecriture = PHP_OK ? ecriturePhp : ecritureNode;

// Signe un corps quelconque comme le ferait PHP (absent ou null = '') : pour les
// demandes bien signées mais mal formées, que Famicard n'enverrait jamais.
const v = (x) => (x == null ? '' : String(x));
const signeCorps = (c) => ({ ...c, sig: hmac(`role|${v(c.centralId)}|${v(c.role)}|${v(c.nom)}|${v(c.exp)}`) });

// Le laissez-passer du portail (formule prouvée face au PHP par portail.test.js)
function laissezPasser(id, nom) {
  const charge = Buffer.from(`${id}|${maintenant() + 60}|${nom}`, 'utf8').toString('base64url');
  return charge + '.' + hmac(charge);
}

let port;

// Requête brute (http.request) : aucun cookie, aucune redirection suivie, corps
// envoyé tel quel s'il est déjà du texte (celui de PHP, octet pour octet).
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
const lire = (requete) => brut('/api/famicard/roles?' + requete);
const poser = (corps) => brut('/api/famicard/role', { methode: 'POST', entetes: { 'Content-Type': 'application/json' }, corps });
const entrer = (id, nom, suite = '') => brut('/entrer?j=' + encodeURIComponent(laissezPasser(id, nom)) + suite);
const session = async (id, nom) => String(((await entrer(id, nom)).headers['set-cookie'] || [])[0] || '').split(';')[0];
const etat = (cookie, entetes = {}) => brut('/api/etat', { entetes: { ...(cookie ? { Cookie: cookie } : {}), ...entetes } });
const lignes = async () => (await db.requete('SELECT central_id, role, nom FROM portail_roles ORDER BY central_id')).rows;

before(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  db.setPool(new Pool());
  await db.initSchema(); // la table des rôles naît vide ; l'amorçage est testé plus bas
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  port = serveur.address().port;
});

after(() => serveur.close());

test('PHP portable disponible pour la preuve de compatibilité', { skip: !PHP_OK && 'php.exe absent' }, () => {
  assert.match(lecturePhp(), /^exp=\d{10}&sig=[0-9a-f]{64}$/);
  const corps = JSON.parse(ecriturePhp(248, 'admin', ' Claire D '));
  assert.deepStrictEqual(Object.keys(corps), ['centralId', 'role', 'nom', 'exp', 'sig']);
  assert.strictEqual(corps.centralId, 248); // un entier JSON, pas un texte
  assert.strictEqual(corps.nom, 'Claire D'); // trim() côté PHP, avant de signer
  assert.strictEqual(typeof corps.exp, 'number');
});

test('amorçage : la table vide reçoit FAMIMINMAX_ADMINS en admin, entrées illisibles ignorées', async () => {
  assert.deepStrictEqual(await lignes(), []);
  await amorcerRoles();
  assert.deepStrictEqual(await lignes(), [
    { central_id: 4, role: 'admin', nom: null },
    { central_id: 12, role: 'admin', nom: null },
  ]);
  await amorcerRoles(); // redémarrage : rien ne double, rien ne lève
  assert.strictEqual((await lignes()).length, 2);
});

test('lecture : la forme exacte du contrat (demande signée par PHP)', async () => {
  const rep = await lire(lecture());
  assert.strictEqual(rep.status, 200, rep.texte);
  assert.match(rep.headers['content-type'], /^application\/json/);
  assert.strictEqual(rep.headers['cache-control'], 'no-store');
  assert.deepStrictEqual(rep.data, {
    contrat: 1,
    service: 'famiminmax',
    roles: [
      { cle: 'collegue', libelle: 'Collègue — propose minimums et collections (scan)' },
      { cle: 'admin', libelle: 'Administrateur — imports ERP, validation, exports' },
    ],
    defaut: 'collegue',
    comptes: {
      4: { role: 'admin', compte: 'Famicard n° 4' },
      12: { role: 'admin', compte: 'Famicard n° 12' },
    },
  });
  // Près des cinq minutes d'avance : encore accepté (Famicard en met deux)
  assert.strictEqual((await lire(lecture(290))).status, 200);
});

test('écriture : pose le rôle, le pré-pose pour une fiche jamais venue, idempotente (corps signé par PHP)', async () => {
  // 248 n'est jamais entré : la ligne naît, sa première entrée sera admin
  let rep = await poser(ecriture(248, 'admin', 'Claire D'));
  assert.strictEqual(rep.status, 200, rep.texte);
  assert.deepStrictEqual(rep.data, { ok: true, role: 'admin' });
  rep = await poser(ecriture(248, 'admin', 'Claire D')); // la même, rejouée
  assert.deepStrictEqual(rep.data, { ok: true, role: 'admin' });
  assert.deepStrictEqual((await lignes()).filter((l) => l.central_id === 248), [{ central_id: 248, role: 'admin', nom: 'Claire D' }]);
  // Retour à collegue : la ligne reste (un rôle posé), la lecture le dit
  rep = await poser(ecriture(248, 'collegue', 'Claire D'));
  assert.deepStrictEqual(rep.data, { ok: true, role: 'collegue' });
  assert.deepStrictEqual((await lire(lecture())).data.comptes['248'], { role: 'collegue', compte: 'Claire D' });
  // Nom vide (fiche sans nom) : l'ancien est gardé
  rep = await poser(ecriture(248, 'admin', ''));
  assert.strictEqual(rep.status, 200, rep.texte);
  assert.deepStrictEqual((await lignes()).find((l) => l.central_id === 248), { central_id: 248, role: 'admin', nom: 'Claire D' });
  // Sa première entrée par le portail arrive avec ce rôle
  assert.strictEqual((await entrer(248, 'Claire D', '&vers=admin')).headers.location, '/admin');
});

test('noms accentués, cyrilliques, avec « | », guillemets et barres : la signature PHP passe, le nom est gardé tel quel', async () => {
  // (Un antislash suivi d'une espace : pg-mem le refuse à l'INSERT, Postgres non.)
  const noms = { 301: 'Zoë Dupont-Lefèvre', 302: 'Ана Коваль', 303: 'Jean A|B', 304: 'O’Brien "Bob" C:\\Temp / <b>' };
  for (const [id, nom] of Object.entries(noms)) {
    const rep = await poser(ecriture(Number(id), 'collegue', nom));
    assert.strictEqual(rep.status, 200, `${nom} : ${rep.texte}`);
  }
  const { comptes } = (await lire(lecture())).data;
  for (const [id, nom] of Object.entries(noms)) assert.deepStrictEqual(comptes[id], { role: 'collegue', compte: nom });
});

test('promotion puis rétrogradation : effet immédiat sur /api/etat et /entrer?vers=admin, même session', async () => {
  const kim = await session(5, 'Kim Peeters');
  assert.strictEqual((await etat(kim)).status, 401); // pas de ligne = collegue
  assert.strictEqual((await entrer(5, 'Kim Peeters', '&vers=admin')).headers.location, '/');

  assert.strictEqual((await poser(ecriture(5, 'admin', 'Kim Peeters'))).status, 200);
  assert.strictEqual((await etat(kim)).status, 200); // même cookie, sans repasser par le portail
  assert.strictEqual((await etat(kim, { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.strictEqual((await etat(kim, { 'Sec-Fetch-Site': 'cross-site' })).status, 401); // la règle d'origine tient
  assert.strictEqual((await entrer(5, 'Kim Peeters', '&vers=admin')).headers.location, '/admin');

  assert.strictEqual((await poser(ecriture(5, 'collegue', 'Kim Peeters'))).status, 200);
  assert.strictEqual((await etat(kim)).status, 401);
  assert.strictEqual((await entrer(5, 'Kim Peeters', '&vers=admin')).headers.location, '/');
});

test('rétrograder un admin amorcé tient, même après un redémarrage : FAMIMINMAX_ADMINS n’est plus lu', async () => {
  const jimmy = await session(4, 'Jimmy Hendrickx');
  assert.strictEqual((await etat(jimmy)).status, 200);
  assert.strictEqual((await poser(ecriture(4, 'collegue', 'Jimmy Hendrickx'))).status, 200);
  assert.strictEqual((await etat(jimmy)).status, 401);
  await amorcerRoles(); // redémarrage : 4 est toujours dans FAMIMINMAX_ADMINS
  assert.strictEqual((await etat(jimmy)).status, 401);
  assert.deepStrictEqual((await lignes()).find((l) => l.central_id === 4), { central_id: 4, role: 'collegue', nom: 'Jimmy Hendrickx' });
  // Le code partagé, lui, ne passe pas par la table
  assert.strictEqual((await etat(jimmy, { 'X-Admin-Code': 'test-code' })).status, 200);
  // Et Famicard le rend admin
  assert.strictEqual((await poser(ecriture(4, 'admin', 'Jimmy Hendrickx'))).status, 200);
  assert.strictEqual((await etat(jimmy)).status, 200);
});

test('amorçage : une table déjà remplie (rôle posé par Famicard) n’est pas complétée', async () => {
  const pool = db.getPool();
  const { Pool } = newDb().adapters.createPg();
  db.setPool(new Pool());
  try {
    await db.initSchema();
    await db.requete("INSERT INTO portail_roles (central_id, role, nom) VALUES (248, 'collegue', 'Claire D')");
    await amorcerRoles();
    assert.deepStrictEqual(await lignes(), [{ central_id: 248, role: 'collegue', nom: 'Claire D' }]);
  } finally {
    db.setPool(pool);
  }
});

test('lecture refusée : 403 et { ok: false }, jamais de 500', async () => {
  const exp = maintenant() + 120;
  const sig = hmac(`roles|${exp}`);
  const mauvais = {
    autreSecret: lecture(120, 'pas-le-bon-secret'),
    signeAvecLeSecretDeSession: lectureNode(120, SECRET_SESSION),
    perimee: lecture(-10),
    tropLoin: lecture(400),
    expAutre: `exp=${exp + 1}&sig=${sig}`,
    expNonNumerique: `exp=abc&sig=${hmac('roles|abc')}`,
    expNegatif: `exp=-5&sig=${hmac('roles|-5')}`,
    expDecimal: `exp=${exp}.5&sig=${hmac(`roles|${exp}.5`)}`,
    expAvecPlus: `exp=%2B${exp}&sig=${hmac(`roles|+${exp}`)}`,
    signatureMajuscules: `exp=${exp}&sig=${sig.toUpperCase()}`,
    signature63: `exp=${exp}&sig=${sig.slice(1)}`,
    signature65: `exp=${exp}&sig=${sig}0`,
    signatureNonHex: `exp=${exp}&sig=${'z'.repeat(64)}`,
    signatureVide: `exp=${exp}&sig=`,
    sansSignature: `exp=${exp}`,
    sansExp: `sig=${sig}`,
    rien: '',
    signatureDEcriture: `exp=${exp}&sig=${hmac(`role|4|admin||${exp}`)}`,
    signatureDuLaissezPasser: `exp=${exp}&sig=${laissezPasser(4, 'Jimmy Hendrickx').split('.')[1]}`,
  };
  for (const [cas, requete] of Object.entries(mauvais)) {
    const rep = await lire(requete);
    assert.strictEqual(rep.status, 403, `${cas} : ${rep.texte}`);
    assert.deepStrictEqual(Object.keys(rep.data), ['ok', 'erreur'], cas);
    assert.strictEqual(rep.data.ok, false, cas);
  }
});

test('écriture refusée : 403 (signature, date), 400 (rôle, id, corps), rien d’écrit, jamais de 500', async () => {
  const avant = await lignes();
  const exp = maintenant() + 120;
  const bon = JSON.parse(ecriture(77, 'admin', 'Lou'));
  const cas403 = {
    roleModifie: { ...bon, role: 'collegue' },
    idModifie: { ...bon, centralId: 78 },
    nomModifie: { ...bon, nom: 'Loup' },
    nomAvecEspaces: { ...bon, nom: ' Lou ' }, // la signature porte sur le nom ENVOYÉ, octet pour octet
    expModifie: { ...bon, exp: bon.exp + 1 },
    autreSecret: JSON.parse(ecriture(77, 'admin', 'Lou', 120, 'pas-le-bon-secret')),
    perimee: JSON.parse(ecriture(77, 'admin', 'Lou', -10)),
    tropLoin: JSON.parse(ecriture(77, 'admin', 'Lou', 400)),
    sansSignature: { ...bon, sig: undefined },
    signatureNombre: { ...bon, sig: 12345 },
    signatureTableau: { ...bon, sig: [bon.sig] },
    signatureMajuscules: { ...bon, sig: bon.sig.toUpperCase() },
    signatureCourte: { ...bon, sig: bon.sig.slice(2) },
    signatureDeLecture: { ...bon, sig: hmac(`roles|${bon.exp}`) },
    roleObjet: { ...bon, role: { admin: true } },
    expNonNumerique: signeCorps({ centralId: 77, role: 'admin', nom: 'Lou', exp: 'demain' }),
    expDecimal: signeCorps({ centralId: 77, role: 'admin', nom: 'Lou', exp: exp + 0.5 }),
  };
  for (const [cas, corps] of Object.entries(cas403)) {
    const rep = await poser(corps);
    assert.strictEqual(rep.status, 403, `${cas} : ${rep.texte}`);
    assert.deepStrictEqual(Object.keys(rep.data), ['ok', 'erreur'], cas);
    assert.strictEqual(rep.data.ok, false, cas);
  }
  // Bien signées, mais un rôle ou un id que le service ne connaît pas
  const cas400 = {
    roleInconnu: signeCorps({ centralId: 77, role: 'chef', nom: 'Lou', exp }),
    roleMajuscule: signeCorps({ centralId: 77, role: 'Admin', nom: 'Lou', exp }),
    roleVide: signeCorps({ centralId: 77, role: '', nom: 'Lou', exp }),
    roleDUnAutreService: signeCorps({ centralId: 77, role: 'acheteur', nom: 'Lou', exp }),
    idZero: signeCorps({ centralId: 0, role: 'admin', nom: 'Lou', exp }),
    idNegatif: signeCorps({ centralId: -1, role: 'admin', nom: 'Lou', exp }),
    idTexte: signeCorps({ centralId: 'abc', role: 'admin', nom: 'Lou', exp }),
    idDecimal: signeCorps({ centralId: 1.5, role: 'admin', nom: 'Lou', exp }),
    idHorsBornes: signeCorps({ centralId: 1e10, role: 'admin', nom: 'Lou', exp }),
    idAbsent: signeCorps({ role: 'admin', nom: 'Lou', exp }),
  };
  for (const [cas, corps] of Object.entries(cas400)) {
    const rep = await poser(corps);
    assert.strictEqual(rep.status, 400, `${cas} : ${rep.texte}`);
    assert.strictEqual(rep.data.ok, false, cas);
  }
  for (const corps of ['', 'pas du json', '{', 'null', '[]', '"admin"', '42', 'true', '[{"centralId":77}]']) {
    const rep = await poser(corps);
    assert.strictEqual(rep.status, 400, `${JSON.stringify(corps)} : ${rep.texte}`);
    assert.strictEqual(rep.data.ok, false);
  }
  // Mauvaise méthode : route inconnue, comme ailleurs
  assert.strictEqual((await brut('/api/famicard/role')).status, 404);
  assert.strictEqual((await brut('/api/famicard/roles', { methode: 'POST', corps: '{}' })).status, 404);
  assert.deepStrictEqual(await lignes(), avant); // rien n'a été écrit
});

test('base qui bronche : 503 pour Famicard, « pas admin » pour la session, le code reste valable', async () => {
  const lise = await session(12, 'Lise Martin');
  assert.strictEqual((await etat(lise)).status, 200); // 12, amorcé admin
  const pool = db.getPool();
  db.setPool({
    connect: async () => { throw new Error('connexion perdue (simulée)'); },
    query: async (texte, params) => {
      if (/portail_roles/.test(texte)) throw new Error('connexion perdue (simulée)');
      return pool.query(texte, params);
    },
  });
  try {
    let rep = await lire(lecture());
    assert.strictEqual(rep.status, 503, rep.texte);
    assert.strictEqual(rep.data.ok, false);
    rep = await poser(ecriture(12, 'collegue', 'Lise Martin'));
    assert.strictEqual(rep.status, 503, rep.texte);
    assert.strictEqual(rep.data.ok, false);
    assert.strictEqual((await etat(lise)).status, 401); // dans le doute : pas admin
    assert.strictEqual((await etat(null, { 'X-Admin-Code': 'test-code' })).status, 200);
    rep = await entrer(12, 'Lise Martin', '&vers=admin');
    assert.strictEqual(rep.status, 302);
    assert.strictEqual(rep.headers.location, '/');
    assert.match(String(rep.headers['set-cookie'][0]), /^fmm=/); // la session s'ouvre quand même
    await amorcerRoles(); // au démarrage, un échec est journalisé, il ne lève pas
  } finally {
    db.setPool(pool);
  }
  assert.strictEqual((await etat(lise)).status, 200); // la base revient, le rôle avec elle
  assert.strictEqual((await lignes()).find((l) => l.central_id === 12).role, 'admin'); // rien n'a été écrit
});

test('corps trop gros : refusé sans 500, le serveur reste debout', async () => {
  let rep = null;
  try {
    rep = await poser(JSON.stringify({ centralId: 77, role: 'admin', nom: 'x'.repeat(40 * 1024) }));
  } catch { /* connexion coupée par le serveur : acceptable */ }
  if (rep) assert.strictEqual(rep.status, 413);
  assert.strictEqual((await brut('/api/sante')).status, 200);
  assert.strictEqual((await lignes()).some((l) => l.central_id === 77), false);
});
