'use strict';
// E2E complet sur base pg-mem (pas besoin de Postgres local) :
// imports (minimums / ventes / collections) -> scan -> propositions min & collection
// -> circuit acheteur (valider / refuser / rouvrir) -> alertes -> exports Excel.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { newDb } = require('pg-mem');

process.env.ADMIN_CODE = 'test-code';

const db = require('../lib/db');
const { serveur } = require('../server');

let base; // http://127.0.0.1:PORT
const ADMIN = { 'X-Admin-Code': 'test-code' };
const JSON_H = { 'Content-Type': 'application/json' };
const F_NOEL = encodeURIComponent('Noël');
const F_AUT = encodeURIComponent('Automne');

async function fabriquerMinimums() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Export');
  ws.addRow(['Article', 'Description', 'VK-12', 'Stock (de marchandise)', 'Minimale Stock', 'Maximale Stock',
    'Récolte', 'VPE', 'PA', 'Fournisseur', 'N°decommande.', 'EAN barcode', 'Actief AK', 'FDepot', 'FDepot2', 'FDCM']);
  // Doublon de code article (cas réel dans Beta4) : la dernière ligne doit gagner
  ws.addRow(['57913', 'Goudspray 150ml (ancien)', '248', '124', '96', '132', '0', '12', '1.16', 'Goodmark Europe NV', '022280', '5410764216374', 'True', '0', '0', '0']);
  ws.addRow(['57913', 'Goudspray 150ml', '248', '124', '120', '132', '0', '12', '1.16', 'Goodmark Europe NV', '022280', '5410764216374', 'True', '687', '0', '3888']);
  ws.addRow(['61702', 'Gazebo Lemax', '9', '5', '6', '12', '0', '1', '7.27', 'Lemax BV', 'L-99', '0728162041609', 'False', '0', '0', '0']);
  ws.addRow(['99001', 'Article sans EAN', '0', '2', '0', '0', '0', '1', '2', 'Divers', '', '', 'True', '', '', '']);
  // EAN écrit en cellule numérique (cas réel possible)
  ws.addRow(['99002', 'EAN numérique', 3, 7, 4, 8, 0, 1, 1.5, 'Divers', '', 5412345678908, 'True', 5, 0, 12]);
  // Inactif mais avec du stock dépôt : la proposition doit rester possible
  ws.addRow(['99003', 'Inactif avec stock dépôt', '0', '0', '0', '0', '0', '1', '1', 'Divers', '', '5410999999990', 'False', '0', '0', '50']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function fabriquerVentes(qteGoudspray) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Feuil1');
  ws.addRow(['Artikelnummer', 'EANBarcode', 'Omschrijving artikel', 'Aantal', 'Fami (#)']);
  ws.addRow(['57913', '5410764216374', 'Goudspray 150ml', String(qteGoudspray), qteGoudspray + ',00']);
  ws.addRow(['61702', '0728162041609', 'Gazebo Lemax', '3', '2,00']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function fabriquerCollections() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Feuil1');
  ws.addRow(['N° art', 'Marque', 'Collectie', 'Type', 'Description', 'Code EAN']);
  ws.addRow(['57913', '', 'Lemax26-03', '', 'Goudspray 150ml', '5410764216374']);
  ws.addRow(['99002', '', 'SugarCrush26-06', '', 'EAN numérique', '5412345678908']);
  ws.addRow(['61702', '', '', '', 'Gazebo Lemax', '0728162041609']); // sans collection
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Fixtures de la famille Automne (articles disjoints de Noël)
async function fabriquerMinimumsAutomne() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Export');
  ws.addRow(['Article', 'Description', 'VK-12', 'Stock (de marchandise)', 'Minimale Stock', 'Maximale Stock',
    'Récolte', 'VPE', 'PA', 'Fournisseur', 'N°decommande.', 'EAN barcode', 'Actief AK', 'FDepot', 'FDepot2', 'FDCM']);
  ws.addRow(['80001', 'Courge décorative', '30', '9', '6', '10', '0', '2', '0.5', 'Pompoen BV', 'P-1', '5400999000016', 'True', '40', '0', '0']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function fabriquerVentesAutomne(qte) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Feuil1');
  ws.addRow(['Artikelnummer', 'EANBarcode', 'Omschrijving artikel', 'Aantal', 'Fami (#)']);
  ws.addRow(['80001', '5400999000016', 'Courge décorative', String(qte), qte + ',00']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function fabriquerPhotos() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Feuil1');
  ws.addRow(['Artikelnummer', 'Lien photo']);
  ws.addRow(['57913', 'https://photos.famiflora.be/goudspray.jpg']);
  // Cellule « lien hypertexte » Excel : l'URL est à côté du texte affiché
  ws.addRow(['99002', { text: 'voir photo', hyperlink: 'https://photos.famiflora.be/99002.jpg' }]);
  ws.addRow(['99001', 'pas-un-lien']);
  // Article Automne dans le même fichier (toutes familles confondues) + lien sans https://
  ws.addRow(['80001', 'www.photos.famiflora.be/courge.jpg']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function fabriquerCollectionsAutomne() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Feuil1');
  ws.addRow(['N° art', 'Marque', 'Collectie', 'Type', 'Description', 'Code EAN']);
  ws.addRow(['80001', '', 'Automne26-01', '', 'Courge décorative', '5400999000016']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function api(chemin, options) {
  return fetch(base + chemin, options);
}
async function fiche(code) {
  return (await api('/api/produit?code=' + code)).json();
}
async function decider(type, codeArticle, decision, motif) {
  return api('/api/proposition-decision', {
    method: 'POST', headers: { ...ADMIN, ...JSON_H },
    body: JSON.stringify({ type, codeArticle, decision, motif }),
  });
}

before(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  db.setPool(new Pool());
  await db.initSchema();
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${serveur.address().port}`;
});

after(() => serveur.close());

test('les routes admin exigent le code', async () => {
  assert.strictEqual((await api('/api/etat')).status, 401);
  assert.strictEqual((await api('/api/sans-minimum')).status, 401);
  assert.strictEqual((await api('/api/proposition-decision', { method: 'POST' })).status, 401);
});

test('import du fichier minimums', async () => {
  const rep = await api('/api/import/minimums?famille=' + F_NOEL, { method: 'POST', headers: ADMIN, body: await fabriquerMinimums() });
  const data = await rep.json();
  assert.strictEqual(rep.status, 200, JSON.stringify(data));
  assert.strictEqual(data.nbArticles, 5); // le doublon 57913 est dédupliqué
  assert.strictEqual(data.nbAvecMin, 3);
  assert.ok(data.avertissements.some((a) => /doublon/.test(a)), 'avertissement doublons attendu');
  assert.ok(data.avertissements.some((a) => /sans EAN/.test(a)), 'avertissement sans EAN attendu');
});

test('import des ventes de deux semaines', async () => {
  for (const [lundi, qte] of [['2026-09-14', 18], ['2026-09-21', 25]]) {
    const rep = await api(`/api/import/ventes?semaine=${lundi}&famille=${F_NOEL}&fichier=test.xlsx`,
      { method: 'POST', headers: ADMIN, body: await fabriquerVentes(qte) });
    assert.strictEqual(rep.status, 200);
  }
  // Réimport de la même semaine : remplace, pas de doublon
  const rep = await api(`/api/import/ventes?semaine=2026-09-21&famille=${F_NOEL}&fichier=test2.xlsx`,
    { method: 'POST', headers: ADMIN, body: await fabriquerVentes(30) });
  assert.strictEqual(rep.status, 200);
});

test('import du fichier collections', async () => {
  const rep = await api('/api/import/collections?famille=' + F_NOEL, { method: 'POST', headers: ADMIN, body: await fabriquerCollections() });
  const data = await rep.json();
  assert.strictEqual(rep.status, 200, JSON.stringify(data));
  assert.strictEqual(data.nbArticles, 2); // seuls les articles avec collection
  assert.strictEqual(data.nbCollections, 2);
  const { collections } = await (await api('/api/collections')).json();
  assert.deepStrictEqual(collections, ['Lemax26-03', 'SugarCrush26-06']);
});

test('références sans minimum avec du stock magasin (onglet admin)', async () => {
  const { refs } = await (await api('/api/sans-minimum', { headers: ADMIN })).json();
  // Seul 99001 est actif, sans minimum ET avec du stock magasin : 57913 et
  // 99002 ont un minimum, 61702 et 99003 sont inactifs (99003 à stock nul).
  assert.deepStrictEqual(refs.map((r) => r.codeArticle), ['99001']);
  assert.strictEqual(refs[0].famille, 'Noël');
  assert.strictEqual(refs[0].stock, 2);
  assert.strictEqual(refs[0].collection, null); // pas de collection renseignée
  assert.strictEqual(refs[0].stockDepots, 0);
});

test('scan par EAN : fiche produit + ventes + collection', async () => {
  const data = await fiche('5410764216374');
  assert.strictEqual(data.produit.codeArticle, '57913');
  assert.strictEqual(data.produit.famille, 'Noël');
  assert.strictEqual(data.produit.stockMin, 120);
  assert.strictEqual(data.produit.vk12, 248);
  assert.strictEqual(data.produit.actif, true);
  assert.strictEqual(data.produit.stockDepot, 687);
  assert.strictEqual(data.produit.stockFdcm, 3888);
  assert.strictEqual(data.collection, 'Lemax26-03');
  assert.deepStrictEqual(data.ventes.map((v) => v.qteFami), [18, 30]);
  assert.strictEqual(data.proposition, null);
  assert.strictEqual(data.propositionCollection, null);
});

test('scan UPC-A 12 chiffres retrouve l’EAN-13 à zéro de tête', async () => {
  const data = await fiche('728162041609');
  assert.strictEqual(data.produit.codeArticle, '61702');
  assert.strictEqual(data.produit.actif, false);
  assert.strictEqual(data.collection, null); // pas de collection renseignée
});

test('les scans introuvables sont journalisés puis vidables', async () => {
  await api('/api/scans-inconnus-vider', { method: 'POST', headers: ADMIN });
  await api('/api/produit?code=5400924479374');
  await api('/api/produit?code=5400924479374');
  await api('/api/produit?code=1112223334445');
  let { scans } = await (await api('/api/scans-inconnus', { headers: ADMIN })).json();
  assert.strictEqual(scans.length, 2);
  assert.strictEqual(scans.find((s) => s.code === '5400924479374').nb, 2);
  await api('/api/scans-inconnus-vider', { method: 'POST', headers: ADMIN });
  ({ scans } = await (await api('/api/scans-inconnus', { headers: ADMIN })).json());
  assert.strictEqual(scans.length, 0);
});

test('proposition min : circuit complet avec alertes', async () => {
  // 1. Proposition douteuse : min 10 (ventes moy. 24/sem, 4575 en dépôt, actuel 120, VPE 12)
  let rep = await api('/api/proposition', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '57913', minPropose: 10, commentaire: 'Trop haut', auteur: 'Jimmy' }),
  });
  assert.strictEqual(rep.status, 200);
  let f = await fiche('57913');
  assert.strictEqual(f.proposition.statut, 'validee'); // validée d'office

  let { propositions } = await (await api('/api/propositions', { headers: ADMIN })).json();
  assert.strictEqual(propositions.length, 1);
  assert.strictEqual(propositions[0].ventesMoy, 24); // (18 + 30) / 2 semaines
  assert.strictEqual(propositions[0].stockDepots, 4575); // 687 + 0 + 3888
  assert.strictEqual(propositions[0].minRayon, 6); // 10 − VPE 12 ≤ 0 : ½ VPE
  assert.strictEqual(propositions[0].maxRayon, 18); // 1,5 VPE
  assert.deepStrictEqual(propositions[0].alertes.map((a) => a.code).sort(),
    ['depot', 'variation', 'ventes', 'vpe']);

  // 2. La dernière proposition écrase : min 108 (plus raisonnable, reste l'alerte dépôt)
  rep = await api('/api/proposition', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '57913', minPropose: 108, auteur: 'Kim' }),
  });
  assert.strictEqual(rep.status, 200);
  ({ propositions } = await (await api('/api/propositions', { headers: ADMIN })).json());
  assert.strictEqual(propositions.length, 1);
  assert.strictEqual(propositions[0].minPropose, 108);
  assert.strictEqual(propositions[0].auteur, 'Kim');
  assert.strictEqual(propositions[0].minRayon, 96); // 108 − VPE 12
  assert.strictEqual(propositions[0].maxRayon, 108); // max = proposition
  assert.deepStrictEqual(propositions[0].alertes.map((a) => a.code), ['depot']);
});

test('proposition invalide refusée', async () => {
  const rep = await api('/api/proposition', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '57913', minPropose: -3 }),
  });
  assert.strictEqual(rep.status, 400);
});

test('refus avec motif, revalidation, puis nouvelle proposition', async () => {
  // Refus sans motif : rejeté ; décision inconnue : rejetée
  assert.strictEqual((await decider('min', '57913', 'refusee', '')).status, 400);
  assert.strictEqual((await decider('min', '57913', 'a_traiter')).status, 400);

  assert.strictEqual((await decider('min', '57913', 'refusee', 'Colisage imposé par le fournisseur')).status, 200);
  let f = await fiche('57913');
  assert.strictEqual(f.proposition.statut, 'refusee');
  assert.strictEqual(f.proposition.motifRefus, 'Colisage imposé par le fournisseur');

  // L'acheteur peut revenir sur son refus
  assert.strictEqual((await decider('min', '57913', 'validee')).status, 200);
  assert.strictEqual((await fiche('57913')).proposition.statut, 'validee');

  // Et le collègue peut reproposer : la dernière écrase, validée d'office
  const rep = await api('/api/proposition', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '57913', minPropose: 96, auteur: 'Kim' }),
  });
  assert.strictEqual(rep.status, 200);
  f = await fiche('57913');
  assert.strictEqual(f.proposition.statut, 'validee');
  assert.strictEqual(f.proposition.motifRefus, null);
});

test('export ERP : la proposition validée d’office passe traitée', async () => {
  const etat = await (await api('/api/etat', { headers: ADMIN })).json();
  assert.strictEqual(etat.propositions.aTraiter, 0);
  assert.strictEqual(etat.propositions.validees, 1);

  const rep = await api('/api/export?type=min&mode=validees', { headers: ADMIN });
  assert.strictEqual(rep.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await rep.arrayBuffer()));
  const ws = wb.getWorksheet('Adaptations');
  assert.strictEqual(ws.rowCount, 2);
  assert.deepStrictEqual(ws.getRow(1).values.slice(1, 10),
    ['artikelnummer', 'minimale voorraad', 'Omschrijving', 'Magazijn', 'eanbarcode',
      'BestelNr.', 'afname', 'maximale voorraad', 'gereserveerde voorraad']);
  const ligne = ws.getRow(2);
  assert.strictEqual(ligne.getCell(1).value, '57913');
  assert.strictEqual(ligne.getCell(2).value, 84); // min = proposition 96 − VPE 12
  assert.strictEqual(ligne.getCell(4).value, 'Fami');
  assert.strictEqual(ligne.getCell(6).value, '022280');
  assert.strictEqual(ligne.getCell(7).value, 12);
  assert.strictEqual(ligne.getCell(8).value, 96); // max = proposition
  assert.strictEqual(ligne.getCell(10).value, 96); // Proposition (vue d'ensemble)
  assert.strictEqual(ligne.getCell(13).value, 4575); // Stock dépôts : 687 + 0 + 3888
  assert.strictEqual(ligne.getCell(17).value, 'Goodmark Europe NV'); // Fournisseur

  const f = await fiche('57913');
  assert.strictEqual(f.proposition.statut, 'traitee');
  // Plus rien de validé à exporter, mais l'historique reste re-téléchargeable
  assert.strictEqual((await api('/api/export?type=min&mode=validees', { headers: ADMIN })).status, 404);
  assert.strictEqual((await api('/api/export?type=min&mode=toutes', { headers: ADMIN })).status, 200);
});

test('proposition de collection : liste fermée, circuit et export', async () => {
  // Collection inconnue : rejetée
  let rep = await api('/api/proposition-collection', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '57913', collectionProposee: 'NImporteQuoi26-01', auteur: 'Jimmy' }),
  });
  assert.strictEqual(rep.status, 400);

  rep = await api('/api/proposition-collection', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '57913', collectionProposee: 'SugarCrush26-06', auteur: 'Jimmy' }),
  });
  assert.strictEqual(rep.status, 200, JSON.stringify(await rep.json()));

  const f = await fiche('57913');
  assert.strictEqual(f.propositionCollection.statut, 'validee'); // validée d'office
  assert.strictEqual(f.propositionCollection.collectionProposee, 'SugarCrush26-06');
  assert.strictEqual(f.propositionCollection.collectionActuelle, 'Lemax26-03');

  const { propositions } = await (await api('/api/propositions', { headers: ADMIN })).json();
  const coll = propositions.find((p) => p.type === 'collection');
  assert.ok(coll, 'la proposition de collection doit être dans la liste admin');
  assert.strictEqual(coll.statut, 'validee');

  const exp = await api('/api/export?type=collection&mode=validees', { headers: ADMIN });
  assert.strictEqual(exp.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await exp.arrayBuffer()));
  const ws = wb.getWorksheet('Collections');
  assert.strictEqual(ws.rowCount, 2);
  assert.strictEqual(ws.getRow(2).getCell(1).value, '57913');
  assert.strictEqual(ws.getRow(2).getCell(4).value, 'Lemax26-03');
  assert.strictEqual(ws.getRow(2).getCell(5).value, 'SugarCrush26-06');

  // Feuilles prêtes à importer dans Beco : collection et tag par n° article
  const wsColl = wb.getWorksheet('Import collections');
  assert.strictEqual(wsColl.rowCount, 2);
  assert.strictEqual(wsColl.getRow(2).getCell(1).value, '57913');
  assert.strictEqual(wsColl.getRow(2).getCell(2).value, 'SugarCrush26-06');
  const wsTags = wb.getWorksheet('Import tags');
  assert.strictEqual(wsTags.rowCount, 2);
  assert.strictEqual(wsTags.getRow(2).getCell(1).value, '57913');
  assert.strictEqual(wsTags.getRow(2).getCell(2).value, 'Lemax26'); // tag initial (Lemax26-03)
  assert.strictEqual(wsTags.getRow(2).getCell(3).value, 'SugarCrush26'); // nouveau tag

  assert.strictEqual((await fiche('57913')).propositionCollection.statut, 'traitee');
});

test('feuille Import tags : seulement les articles dont le tag change', async () => {
  const { genererExportCollections } = require('../lib/export');
  const buf = await genererExportCollections([
    { code_article: '11111', collection_actuelle: 'Lemax26-03', collection_proposee: 'Lemax26-05' }, // même tag
    { code_article: '22222', collection_actuelle: 'Lemax26-03', collection_proposee: 'SugarCrush26-06' },
    { code_article: '33333', collection_actuelle: 'SugarCrush26-06', collection_proposee: 'Emballages' }, // plus de tag
  ]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  // Les 3 articles vont dans « Import collections »...
  const wsColl = wb.getWorksheet('Import collections');
  assert.strictEqual(wsColl.rowCount, 4);
  // ... mais 11111 (Lemax26 -> Lemax26) est exclu d'« Import tags »
  const wsTags = wb.getWorksheet('Import tags');
  assert.strictEqual(wsTags.rowCount, 3);
  assert.strictEqual(wsTags.getRow(2).getCell(1).value, '22222');
  assert.strictEqual(wsTags.getRow(2).getCell(2).value, 'Lemax26');
  assert.strictEqual(wsTags.getRow(2).getCell(3).value, 'SugarCrush26');
  assert.strictEqual(wsTags.getRow(3).getCell(1).value, '33333');
  assert.strictEqual(wsTags.getRow(3).getCell(2).value, 'SugarCrush26');
  assert.ok(!wsTags.getRow(3).getCell(3).value); // aucun tag ne correspond : cellule vide
});

test('calcul min/max rayon depuis la proposition et le VPE', () => {
  const { calculerMinMax } = require('../lib/minmax');
  assert.deepStrictEqual(calculerMinMax(96, 12), { min: 84, max: 96 });
  assert.deepStrictEqual(calculerMinMax(12, 12), { min: 6, max: 18 }); // proposition − VPE = 0
  assert.deepStrictEqual(calculerMinMax(10, 12), { min: 6, max: 18 }); // proposition − VPE < 0
  assert.deepStrictEqual(calculerMinMax(4, 5), { min: 3, max: 8 }); // ½ et 1,5 VPE arrondis au supérieur
  assert.deepStrictEqual(calculerMinMax(10, null), { min: 9, max: 10 }); // VPE absent : traité comme 1
  assert.deepStrictEqual(calculerMinMax(1, 1), { min: 1, max: 2 });
});

test('tag déduit de la collection (variantes réelles des exports ERP)', () => {
  const { tagPourCollection } = require('../lib/export');
  assert.strictEqual(tagPourCollection('SugarCrush26-06'), 'SugarCrush26');
  assert.strictEqual(tagPourCollection('BouleNoël26-04'), 'BouleNoël26');
  assert.strictEqual(tagPourCollection('Book&Bells26-Podium'), 'Book&Bells26');
  assert.strictEqual(tagPourCollection('Textile/Cadeaux26-12'), 'Textile/Cadeaux26');
  // Variantes sans « 26 » ou avec millésime complet
  assert.strictEqual(tagPourCollection('Sapins artificiels'), 'Sapins artificiels26');
  assert.strictEqual(tagPourCollection('Sapins artificiels26-00'), 'Sapins artificiels26');
  assert.strictEqual(tagPourCollection('Art de la table'), 'Art de la table26');
  assert.strictEqual(tagPourCollection('Fleurs Noël 2026'), 'Fleurs Noël26');
  assert.strictEqual(tagPourCollection('Taps Noel26-01'), 'Taps Noel26');
  // Aucun tag ne correspond : cellule vide (surlignée dans l'export)
  assert.strictEqual(tagPourCollection('Emballages'), '');
  assert.strictEqual(tagPourCollection('Zone - SPEL - 09'), '');
  assert.strictEqual(tagPourCollection('textile'), '');
  assert.strictEqual(tagPourCollection(''), '');
});

test('réimport des minimums : propositions et collections survivent', async () => {
  const rep = await api('/api/import/minimums?famille=' + F_NOEL, { method: 'POST', headers: ADMIN, body: await fabriquerMinimums() });
  assert.strictEqual(rep.status, 200);
  const etat = await (await api('/api/etat', { headers: ADMIN })).json();
  assert.strictEqual(etat.produits.nb, 5);
  assert.strictEqual(etat.propositions.total, 2); // 1 min + 1 collection, traitées
  assert.strictEqual(etat.collections.nbArticles, 2);
  assert.strictEqual((await fiche('57913')).collection, 'Lemax26-03');
});

test('suppression des deux types de propositions', async () => {
  assert.strictEqual((await api('/api/proposition-suppr?type=min&codeArticle=57913', { method: 'POST', headers: ADMIN })).status, 200);
  assert.strictEqual((await api('/api/proposition-suppr?type=collection&codeArticle=57913', { method: 'POST', headers: ADMIN })).status, 200);
  const { propositions } = await (await api('/api/propositions', { headers: ADMIN })).json();
  assert.strictEqual(propositions.length, 0);
});

test('proposition bloquée pour un article inactif sans stock dépôt', async () => {
  // 61702 : inactif, dépôts 0/0/0 -> refusé
  const ko = await api('/api/proposition', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '61702', minPropose: 10 }),
  });
  assert.strictEqual(ko.status, 409);
  assert.match((await ko.json()).erreur, /inactif sans stock dépôt/);

  // 99003 : inactif mais 50 en FDCM -> autorisé
  const ok = await api('/api/proposition', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '99003', minPropose: 4, auteur: 'Test' }),
  });
  assert.strictEqual(ok.status, 200, JSON.stringify(await ok.json()));
  await api('/api/proposition-suppr?type=min&codeArticle=99003', { method: 'POST', headers: ADMIN });
});

test('décision sur une proposition inexistante : 404', async () => {
  assert.strictEqual((await decider('min', '00000', 'validee')).status, 404);
});

test('gestion des collègues (identification Zebra)', async () => {
  // L'ajout exige le code admin ; la lecture est publique (les Zebra en ont besoin)
  const sansCode = await api('/api/collegues-ajout', { method: 'POST', headers: JSON_H, body: JSON.stringify({ nom: 'Kim' }) });
  assert.strictEqual(sansCode.status, 401);

  for (const nom of ['Kim', 'Jimmy', 'Kim']) {
    const rep = await api('/api/collegues-ajout', {
      method: 'POST', headers: { ...ADMIN, ...JSON_H }, body: JSON.stringify({ nom }),
    });
    assert.strictEqual(rep.status, 200);
  }
  let { collegues } = await (await api('/api/collegues')).json();
  assert.deepStrictEqual(collegues, ['Jimmy', 'Kim']); // dédupliqué, trié

  await api('/api/collegues-suppr?nom=Kim', { method: 'POST', headers: ADMIN });
  ({ collegues } = await (await api('/api/collegues')).json());
  assert.deepStrictEqual(collegues, ['Jimmy']);
});

test('multi-familles : importer l’Automne ne touche pas Noël', async () => {
  // La famille est obligatoire sur les imports
  const sansFam = await api('/api/import/minimums', { method: 'POST', headers: ADMIN, body: await fabriquerMinimumsAutomne() });
  assert.strictEqual(sansFam.status, 400);

  let rep = await api('/api/import/minimums?famille=' + F_AUT, { method: 'POST', headers: ADMIN, body: await fabriquerMinimumsAutomne() });
  assert.strictEqual(rep.status, 200, JSON.stringify(await rep.json()));

  // Noël intact, l'Automne s'ajoute
  const etat = await (await api('/api/etat', { headers: ADMIN })).json();
  assert.strictEqual(etat.produits.nb, 6);
  assert.deepStrictEqual(etat.produits.parFamille, [
    { famille: 'Automne', nb: 1 },
    { famille: 'Noël', nb: 5 },
  ]);
  assert.strictEqual((await fiche('5410764216374')).produit.famille, 'Noël');
  assert.strictEqual((await fiche('5400999000016')).produit.famille, 'Automne');

  // Ventes Automne sur une semaine déjà importée pour Noël : cohabitation
  rep = await api('/api/import/ventes?semaine=2026-09-21&famille=' + F_AUT,
    { method: 'POST', headers: ADMIN, body: await fabriquerVentesAutomne(7) });
  assert.strictEqual(rep.status, 200);
  assert.deepStrictEqual((await fiche('5400999000016')).ventes.map((v) => v.qteFami), [0, 7]);
  assert.deepStrictEqual((await fiche('5410764216374')).ventes.map((v) => v.qteFami), [18, 30]);

  // Réimporter l'Automne pour la même semaine remplace l'Automne seul
  rep = await api('/api/import/ventes?semaine=2026-09-21&famille=' + F_AUT,
    { method: 'POST', headers: ADMIN, body: await fabriquerVentesAutomne(9) });
  assert.strictEqual(rep.status, 200);
  assert.deepStrictEqual((await fiche('5400999000016')).ventes.map((v) => v.qteFami), [0, 9]);
  assert.deepStrictEqual((await fiche('5410764216374')).ventes.map((v) => v.qteFami), [18, 30]);

  // L'API garde son filtre famille optionnel (le sélecteur du scan, lui, charge tout)
  rep = await api('/api/import/collections?famille=' + F_AUT,
    { method: 'POST', headers: ADMIN, body: await fabriquerCollectionsAutomne() });
  assert.strictEqual(rep.status, 200);
  assert.deepStrictEqual((await (await api('/api/collections?famille=' + F_AUT)).json()).collections, ['Automne26-01']);
  assert.deepStrictEqual((await (await api('/api/collections?famille=' + F_NOEL)).json()).collections, ['Lemax26-03', 'SugarCrush26-06']);
  assert.strictEqual((await fiche('5400999000016')).collection, 'Automne26-01');

  // Les familles connues alimentent les listes de choix de l'admin
  assert.deepStrictEqual((await (await api('/api/familles')).json()).familles, ['Automne', 'Noël']);
});

test('photos : import et lien dans la liste des propositions', async () => {
  const rep = await api('/api/import/photos', { method: 'POST', headers: ADMIN, body: await fabriquerPhotos() });
  const data = await rep.json();
  assert.strictEqual(rep.status, 200, JSON.stringify(data));
  assert.strictEqual(data.nbPhotos, 3); // la ligne sans lien valide est ignorée
  assert.ok(data.avertissements.some((a) => /sans lien valide/.test(a)));
  // Un même fichier mélange Noël et Automne : le bilan le montre
  assert.deepStrictEqual(data.parFamille, [{ famille: 'Automne', nb: 1 }, { famille: 'Noël', nb: 2 }]);
  assert.strictEqual(data.nbInconnus, 0);

  await api('/api/proposition', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '57913', minPropose: 108, auteur: 'Kim' }),
  });
  const { propositions } = await (await api('/api/propositions', { headers: ADMIN })).json();
  const p = propositions.find((x) => x.type === 'min' && x.codeArticle === '57913');
  assert.strictEqual(p.photo, 'https://photos.famiflora.be/goudspray.jpg');
  await api('/api/proposition-suppr?type=min&codeArticle=57913', { method: 'POST', headers: ADMIN });
});

test('photos : fichier fournisseur (titre au-dessus, entêtes en ligne 3, lien www)', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Photos automne');
  ws.addRow(['Photos articles automne 2026']);
  ws.addRow([]);
  ws.addRow(['Art. nr', 'Afbeelding']);
  ws.addRow(['80001', 'www.photos.famiflora.be/courge-v2.jpg']);
  ws.addRow(['00000', 'https://photos.famiflora.be/inconnu.jpg']); // hors référentiel
  const rep = await api('/api/import/photos', { method: 'POST', headers: ADMIN, body: Buffer.from(await wb.xlsx.writeBuffer()) });
  const data = await rep.json();
  assert.strictEqual(rep.status, 200, JSON.stringify(data));
  assert.strictEqual(data.nbPhotos, 2);
  assert.deepStrictEqual(data.parFamille, [{ famille: 'Automne', nb: 1 }]);
  assert.strictEqual(data.nbInconnus, 1);
  const { rows } = await db.requete("SELECT url FROM photos_articles WHERE code_article = '80001'");
  assert.strictEqual(rows[0].url, 'https://www.photos.famiflora.be/courge-v2.jpg');
});

test('le nom est obligatoire pour proposer', async () => {
  const sansNomMin = await api('/api/proposition', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '57913', minPropose: 100 }),
  });
  assert.strictEqual(sansNomMin.status, 400);
  assert.match((await sansNomMin.json()).erreur, /votre nom/);

  const sansNomColl = await api('/api/proposition-collection', {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({ codeArticle: '57913', collectionProposee: 'Lemax26-03' }),
  });
  assert.strictEqual(sansNomColl.status, 400);
  assert.match((await sansNomColl.json()).erreur, /votre nom/);
});
