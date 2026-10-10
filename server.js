'use strict';
// Famiminmax — serveur HTTP (Node pur, style Famipresta/cirque).
// Pages statiques dans /public, API JSON sous /api/*.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./lib/db');
const { parserMinimums, parserVentes, parserCollections, parserPhotos, candidatsScan } = require('./lib/parseurs');
const { genererExportPropositions, genererExportCollections } = require('./lib/export');

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || '';
const MAX_UPLOAD = 30 * 1024 * 1024;

// Porte du portail (voir « Porte du portail » plus bas). Sans FAMIMINMAX_SECRET,
// /entrer répond 503 et rien d'autre ne change.
const PORTAIL_SECRET = process.env.FAMIMINMAX_SECRET || '';
// Secret DISTINCT pour nos propres cookies : une fuite du secret partagé avec le
// portail ne doit pas suffire à fabriquer une session.
const SESSION_SECRET = process.env.FAMIMINMAX_SESSION_SECRET || '';
const SESSION_DUREE = 8 * 3600; // secondes, comme FamiPresta
const FAMIPORTAIL_URL = (process.env.FAMIPORTAIL_URL || 'https://famiportail.famiformation.com').replace(/\/+$/, '');
// Ids Famicard admis dans l'administration par le portail, sans le code (ex. « 4 »).
const ADMINS_PORTAIL = new Set((process.env.FAMIMINMAX_ADMINS || '').split(',').map((s) => s.trim()).filter(Boolean));

// Seuils des alertes de fiabilité (surchargeables par variables d'environnement).
const SEUILS = {
  couvertureSemaines: Number(process.env.SEUIL_COUVERTURE_SEMAINES) || 1,
  ratioDepot: Number(process.env.SEUIL_RATIO_DEPOT) || 5,
  depotMin: Number(process.env.SEUIL_DEPOT_MIN) || 24,
  variation: Number(process.env.SEUIL_VARIATION) || 5,
};


const MIMES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function lireCorps(req, limite = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    let taille = 0;
    req.on('data', (c) => {
      taille += c.length;
      if (taille > limite) {
        reject(Object.assign(new Error('Fichier trop volumineux.'), { code: 413 }));
        req.destroy();
        return;
      }
      morceaux.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(morceaux)));
    req.on('error', reject);
  });
}

function estAdmin(req, url) {
  if (!ADMIN_CODE) return true; // pas de code configuré = accès libre (à éviter en prod)
  const code = req.headers['x-admin-code'] || url.searchParams.get('code') || '';
  if (code === ADMIN_CODE) return true;
  // Ou une session ouverte par le portail, pour un id listé dans FAMIMINMAX_ADMINS.
  // Jamais depuis un autre site : /api/export est un GET qui change l'état, et le
  // cookie (SameSite=Lax) suivrait un simple lien. Le code, lui, voyage en
  // en-tête et n'a pas ce souci.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const qui = lireSession(req);
  return !!qui && ADMINS_PORTAIL.has(qui.id);
}

// --- Porte du portail -------------------------------------------------------
// Famicard POSSÈDE la personne, Famiportail l'AUTHENTIFIE : ici on vérifie une
// signature, rien d'autre (même contrat que FamiTask et FamiPresta). Le portail
// signe « id|expiration|nom » avec FAMIMINMAX_SECRET et redirige vers /entrer ;
// on échange ce laissez-passer d'une minute contre une session de huit heures,
// signée avec NOTRE secret.
//
// ⚠️ CETTE PORTE S'AJOUTE, ELLE NE FERME RIEN. Sans session portail, la page
// scan des Zebra (nom saisi sur l'appareil) et le code admin marchent comme avant.

const signe = (charge, secret) => crypto.createHmac('sha256', secret).update(charge).digest('hex');

// Vérifie un jeton « charge.signature » et rend { id, nom, exp }, ou null. Même forme
// pour le laissez-passer du portail et pour notre cookie : seuls le secret et la
// durée changent. Un jeton abîmé est un refus, jamais une erreur 500.
function ouvreJeton(jeton, secret) {
  if (!secret) return null;
  const t = String(jeton || '');
  const i = t.lastIndexOf('.');
  if (i < 1) return null;
  const sig = t.slice(i + 1);
  // Format vérifié AVANT la comparaison : timingSafeEqual lève sur deux tampons
  // de longueurs différentes, et l'exception donnerait un 500.
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(signe(t.slice(0, i), secret), 'hex'))) return null;
  let brut;
  try { brut = Buffer.from(t.slice(0, i), 'base64url').toString('utf8'); } catch { return null; }
  const [id, exp, ...reste] = brut.split('|');
  if (!/^\d+$/.test(id || '') || !/^\d+$/.test(exp || '')) return null;
  if (Number(exp) * 1000 < Date.now()) return null; // périmé
  return { id, nom: reste.join('|').trim(), exp: Number(exp) }; // le nom est « tout le reste » : il peut contenir un « | »
}

// Derrière le proxy https de Railway : le cookie part avec « Secure ».
const enHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// Pose la session : même forme de jeton, notre secret, huit heures.
function poseSession(req, res, qui) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DUREE;
  const charge = Buffer.from([qui.id, exp, qui.nom].join('|'), 'utf8').toString('base64url');
  res.setHeader('Set-Cookie', `fmm=${charge}.${signe(charge, SESSION_SECRET)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DUREE}` +
    (enHttps(req) ? '; Secure' : ''));
}

// Qui est arrivé par le portail, ou null : Zebra en libre-service, session
// expirée ou cookie abîmé, c'est le comportement d'avant.
function lireSession(req) {
  const trouve = /(?:^|;\s*)fmm=([^;\s]+)/.exec(String(req.headers.cookie || ''));
  if (!trouve) return null;
  try { return ouvreJeton(decodeURIComponent(trouve[1]), SESSION_SECRET); } catch { return null; }
}

// Traçabilité : l'id Famicard de qui a signé (NULL pour un nom saisi sur un
// Zebra). Écrit à part, APRÈS la proposition : si la colonne manquait, la
// proposition est déjà enregistrée et rien ne casse. « AND auteur » : si un
// collègue a écrasé la même proposition entre-temps, on ne lui colle pas l'id
// de l'autre.
async function noterAuteurId(table, codeArticle, auteur, qui) {
  try {
    await db.requete(`UPDATE ${table} SET auteur_central_id = $1 WHERE code_article = $2 AND auteur = $3`,
      [qui ? qui.id : null, codeArticle, auteur]);
  } catch (e) {
    console.error(`[portail] auteur_central_id non noté (${table}) :`, e.message);
  }
}

// Famille obligatoire sur les imports (« Noël », « Automne »…) : chaque fichier
// ERP ne couvre qu'une famille et son import ne remplace que la sienne.
function lireFamille(url) {
  return (url.searchParams.get('famille') || '').trim().slice(0, 40);
}

function dateISO(d) {
  if (d == null) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// --- Handlers API -----------------------------------------------------------

async function apiProduit(req, res, url) {
  const brut = (url.searchParams.get('code') || '').trim();
  if (!brut) return json(res, 400, { erreur: 'Paramètre "code" manquant.' });

  // Le même champ accepte l'EAN du produit ou le numéro d'article de l'étiquette
  // rayon (variantes avec/sans zéros de tête comprises).
  const candidats = candidatsScan(brut);
  const placeholders = candidats.map((_, i) => `$${i + 1}`).join(',');
  const r = await db.requete(
    `SELECT * FROM produits WHERE ean IN (${placeholders}) OR code_article IN (${placeholders}) LIMIT 6`,
    candidats
  );
  if (!r.rows.length) {
    // Journal des codes scannés introuvables : visible dans l'admin pour
    // compléter le référentiel (articles à plusieurs codes-barres, etc.).
    await db.requete(
      `INSERT INTO scans_inconnus (code) VALUES ($1)
       ON CONFLICT (code) DO UPDATE SET nb = scans_inconnus.nb + 1, dernier_le = now()`,
      [brut.slice(0, 40)]
    );
    return json(res, 404, {
      erreur: `Aucun produit trouvé pour « ${brut} ». Le code est enregistré pour analyse (certains articles ont plusieurs codes-barres et l'export ERP n'en reprend qu'un).`,
    });
  }
  if (r.rows.length > 1) {
    return json(res, 200, {
      choix: r.rows.map((p) => ({ codeArticle: p.code_article, ean: p.ean, description: p.description })),
    });
  }

  const p = r.rows[0];
  const ventes = await db.requete(
    `SELECT s.debut, s.nb_lignes, l.qte_totale, l.qte_fami
       FROM semaines_ventes s
       LEFT JOIN lignes_ventes l ON l.semaine = s.debut AND l.code_article = $1
      ORDER BY s.debut DESC
      LIMIT 5`,
    [p.code_article]
  );
  const prop = await db.requete('SELECT * FROM propositions WHERE code_article = $1', [p.code_article]);
  const coll = await db.requete('SELECT collection FROM collections_articles WHERE code_article = $1', [p.code_article]);
  const propColl = await db.requete('SELECT * FROM propositions_collection WHERE code_article = $1', [p.code_article]);

  json(res, 200, {
    produit: {
      codeArticle: p.code_article,
      famille: p.famille,
      ean: p.ean,
      description: p.description,
      stockMin: p.stock_min,
      stockMax: p.stock_max,
      stock: p.stock,
      vpe: p.vpe,
      vk12: p.vk12,
      fournisseur: p.fournisseur,
      numCommande: p.num_commande,
      actif: p.actif !== false,
      stockDepot: p.stock_depot,
      stockDepot2: p.stock_depot2,
      stockFdcm: p.stock_fdcm,
      majLe: p.maj_le,
    },
    ventes: ventes.rows
      .map((v) => ({
        semaine: dateISO(v.debut),
        qteTotale: v.qte_totale == null ? 0 : Number(v.qte_totale),
        qteFami: v.qte_fami == null ? 0 : Number(v.qte_fami),
      }))
      .reverse(),
    collection: coll.rows.length ? coll.rows[0].collection : null,
    proposition: prop.rows.length
      ? {
          minPropose: prop.rows[0].min_propose,
          minActuel: prop.rows[0].min_actuel,
          commentaire: prop.rows[0].commentaire,
          auteur: prop.rows[0].auteur,
          majLe: prop.rows[0].maj_le,
          statut: prop.rows[0].statut,
          motifRefus: prop.rows[0].motif_refus,
        }
      : null,
    propositionCollection: propColl.rows.length
      ? {
          collectionProposee: propColl.rows[0].collection_proposee,
          collectionActuelle: propColl.rows[0].collection_actuelle,
          auteur: propColl.rows[0].auteur,
          majLe: propColl.rows[0].maj_le,
          statut: propColl.rows[0].statut,
          motifRefus: propColl.rows[0].motif_refus,
        }
      : null,
  });
}

async function apiProposer(req, res) {
  let corps;
  try {
    corps = JSON.parse((await lireCorps(req, 64 * 1024)).toString('utf8'));
  } catch {
    return json(res, 400, { erreur: 'Corps JSON invalide.' });
  }
  const codeArticle = String(corps.codeArticle || '').trim();
  const minPropose = Number(corps.minPropose);
  if (!codeArticle) return json(res, 400, { erreur: 'codeArticle manquant.' });
  if (!Number.isInteger(minPropose) || minPropose < 0 || minPropose > 100000) {
    return json(res, 400, { erreur: 'Le minimum proposé doit être un entier entre 0 et 100 000.' });
  }

  const r = await db.requete('SELECT * FROM produits WHERE code_article = $1', [codeArticle]);
  if (!r.rows.length) return json(res, 404, { erreur: 'Produit inconnu.' });
  const p = r.rows[0];

  // Règle métier : pas de proposition pour un article inactif sans stock dépôt
  // (article en fin de vie, adapter son minimum n'a pas de sens).
  const stockDepots = (p.stock_depot || 0) + (p.stock_depot2 || 0) + (p.stock_fdcm || 0);
  if (p.actif === false && stockDepots === 0) {
    return json(res, 409, { erreur: 'Article inactif sans stock dépôt : proposition désactivée.' });
  }

  const commentaire = String(corps.commentaire || '').trim().slice(0, 500) || null;
  // Arrivé par le portail : le nom vient du laissez-passer signé, pas du
  // navigateur. Sinon (Zebra en libre-service) : le nom saisi, comme avant.
  const qui = lireSession(req);
  const auteur = qui ? qui.nom.slice(0, 80) : String(corps.auteur || '').trim().slice(0, 80);
  if (!auteur) return json(res, 400, { erreur: 'Indiquez votre nom pour envoyer la proposition.' });

  // Une seule proposition par produit : la dernière écrase la précédente.
  // Validée d'office — l'acheteur n'intervient que pour refuser.
  await db.requete(
    `INSERT INTO propositions (code_article, ean, description, min_actuel, min_propose, commentaire, auteur, statut)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'validee')
     ON CONFLICT (code_article) DO UPDATE SET
       ean = EXCLUDED.ean, description = EXCLUDED.description, min_actuel = EXCLUDED.min_actuel,
       min_propose = EXCLUDED.min_propose, commentaire = EXCLUDED.commentaire, auteur = EXCLUDED.auteur,
       statut = 'validee', motif_refus = NULL, decide_le = NULL,
       maj_le = now(), exporte_le = NULL`,
    [codeArticle, p.ean, p.description, p.stock_min, minPropose, commentaire, auteur]
  );
  await noterAuteurId('propositions', codeArticle, auteur, qui);
  json(res, 200, { ok: true });
}

async function apiProposerCollection(req, res) {
  let corps;
  try {
    corps = JSON.parse((await lireCorps(req, 64 * 1024)).toString('utf8'));
  } catch {
    return json(res, 400, { erreur: 'Corps JSON invalide.' });
  }
  const codeArticle = String(corps.codeArticle || '').trim();
  const collectionProposee = String(corps.collectionProposee || '').trim();
  if (!codeArticle) return json(res, 400, { erreur: 'codeArticle manquant.' });
  if (!collectionProposee) return json(res, 400, { erreur: 'Choisissez une collection.' });

  const r = await db.requete('SELECT * FROM produits WHERE code_article = $1', [codeArticle]);
  if (!r.rows.length) return json(res, 404, { erreur: 'Produit inconnu.' });
  const p = r.rows[0];

  const connue = await db.requete('SELECT 1 FROM collections WHERE nom = $1', [collectionProposee]);
  if (!connue.rows.length) {
    return json(res, 400, { erreur: `Collection inconnue : « ${collectionProposee} ». Choisissez-la dans la liste.` });
  }
  const actuelle = await db.requete('SELECT collection FROM collections_articles WHERE code_article = $1', [codeArticle]);

  const qui = lireSession(req); // même règle que pour le minimum
  const auteur = qui ? qui.nom.slice(0, 80) : String(corps.auteur || '').trim().slice(0, 80);
  if (!auteur) return json(res, 400, { erreur: 'Indiquez votre nom pour envoyer la proposition.' });
  await db.requete(
    `INSERT INTO propositions_collection (code_article, ean, description, collection_actuelle, collection_proposee, auteur, statut)
     VALUES ($1, $2, $3, $4, $5, $6, 'validee')
     ON CONFLICT (code_article) DO UPDATE SET
       ean = EXCLUDED.ean, description = EXCLUDED.description,
       collection_actuelle = EXCLUDED.collection_actuelle, collection_proposee = EXCLUDED.collection_proposee,
       auteur = EXCLUDED.auteur, statut = 'validee', motif_refus = NULL, decide_le = NULL,
       maj_le = now(), exporte_le = NULL`,
    [codeArticle, p.ean, p.description, actuelle.rows.length ? actuelle.rows[0].collection : null, collectionProposee, auteur]
  );
  await noterAuteurId('propositions_collection', codeArticle, auteur, qui);
  json(res, 200, { ok: true });
}

// Décision de l'acheteur : refuser (motif obligatoire) ou revalider (rouvrir un refus).
// Les propositions sont validées d'office à la création.
async function apiDecision(req, res) {
  let corps;
  try {
    corps = JSON.parse((await lireCorps(req, 64 * 1024)).toString('utf8'));
  } catch {
    return json(res, 400, { erreur: 'Corps JSON invalide.' });
  }
  const table = corps.type === 'collection' ? 'propositions_collection' : 'propositions';
  const codeArticle = String(corps.codeArticle || '').trim();
  const decision = String(corps.decision || '');
  const motif = String(corps.motif || '').trim().slice(0, 300);
  if (!codeArticle) return json(res, 400, { erreur: 'codeArticle manquant.' });
  if (!['validee', 'refusee'].includes(decision)) {
    return json(res, 400, { erreur: 'Décision invalide (validee / refusee).' });
  }
  if (decision === 'refusee' && !motif) {
    return json(res, 400, { erreur: 'Le motif est obligatoire pour un refus.' });
  }

  const r = await db.requete(
    `UPDATE ${table}
        SET statut = $1,
            motif_refus = $2,
            decide_le = now()
      WHERE code_article = $3`,
    [decision, decision === 'refusee' ? motif : null, codeArticle]
  );
  if (!r.rowCount) return json(res, 404, { erreur: 'Proposition introuvable.' });
  json(res, 200, { ok: true });
}

// Ventes Fami moyennes par semaine (sur les 5 dernières semaines importées).
async function ventesMoyennes() {
  const semaines = await db.requete('SELECT debut FROM semaines_ventes ORDER BY debut DESC LIMIT 5');
  if (!semaines.rows.length) return { nbSemaines: 0, parCode: new Map() };
  const placeholders = semaines.rows.map((_, i) => `$${i + 1}`).join(',');
  const r = await db.requete(
    `SELECT code_article, SUM(qte_fami) AS tot FROM lignes_ventes
      WHERE semaine IN (${placeholders}) GROUP BY code_article`,
    semaines.rows.map((s) => s.debut)
  );
  const parCode = new Map();
  for (const l of r.rows) parCode.set(l.code_article, Number(l.tot) / semaines.rows.length);
  return { nbSemaines: semaines.rows.length, parCode };
}

// Drapeaux de fiabilité d'une proposition de minimum, pour l'acheteur.
function calculerAlertes(x, ventesMoy) {
  const alertes = [];
  const min = x.min_propose;
  if (ventesMoy != null && ventesMoy > 0 && min < SEUILS.couvertureSemaines * ventesMoy) {
    alertes.push({ code: 'ventes', detail: `Min ${min} < ventes moyennes ${Math.round(ventesMoy * 10) / 10}/sem` });
  }
  const depot = (x.stock_depot || 0) + (x.stock_depot2 || 0) + (x.stock_fdcm || 0);
  if (depot >= SEUILS.depotMin && depot >= SEUILS.ratioDepot * min) {
    alertes.push({ code: 'depot', detail: `${depot} pièces en dépôt pour un min de ${min}` });
  }
  if (x.min_actuel > 0 && (min >= SEUILS.variation * x.min_actuel || min * SEUILS.variation <= x.min_actuel)) {
    alertes.push({ code: 'variation', detail: `Passage de ${x.min_actuel} à ${min}` });
  }
  if (x.vpe > 1 && min % x.vpe !== 0) {
    alertes.push({ code: 'vpe', detail: `${min} n'est pas un multiple du VPE (${x.vpe})` });
  }
  return alertes;
}

async function apiPropositions(req, res) {
  const mins = await db.requete(
    `SELECT pr.*, p.fournisseur, p.famille, p.vpe, p.stock_depot, p.stock_depot2, p.stock_fdcm, ph.url AS photo
       FROM propositions pr
       LEFT JOIN produits p ON p.code_article = pr.code_article
       LEFT JOIN photos_articles ph ON ph.code_article = pr.code_article
      ORDER BY pr.maj_le DESC`
  );
  const colls = await db.requete(
    `SELECT pr.*, p.fournisseur, p.famille, p.stock_depot, p.stock_depot2, p.stock_fdcm, ph.url AS photo
       FROM propositions_collection pr
       LEFT JOIN produits p ON p.code_article = pr.code_article
       LEFT JOIN photos_articles ph ON ph.code_article = pr.code_article
      ORDER BY pr.maj_le DESC`
  );
  const { parCode } = await ventesMoyennes();
  const arrondi = (v) => Math.round(v * 10) / 10;
  const depots = (x) => (x.stock_depot || 0) + (x.stock_depot2 || 0) + (x.stock_fdcm || 0);

  const liste = [
    ...mins.rows.map((x) => ({
      type: 'min',
      codeArticle: x.code_article,
      famille: x.famille,
      ean: x.ean,
      description: x.description,
      fournisseur: x.fournisseur,
      photo: x.photo,
      minActuel: x.min_actuel,
      minPropose: x.min_propose,
      commentaire: x.commentaire,
      auteur: x.auteur,
      majLe: x.maj_le,
      statut: x.statut,
      motifRefus: x.motif_refus,
      ventesMoy: arrondi(parCode.get(x.code_article) || 0),
      stockDepots: depots(x),
      alertes: x.statut === 'a_traiter' || x.statut === 'validee' ? calculerAlertes(x, parCode.get(x.code_article)) : [],
    })),
    ...colls.rows.map((x) => ({
      type: 'collection',
      codeArticle: x.code_article,
      famille: x.famille,
      ean: x.ean,
      description: x.description,
      fournisseur: x.fournisseur,
      photo: x.photo,
      collectionActuelle: x.collection_actuelle,
      collectionProposee: x.collection_proposee,
      auteur: x.auteur,
      majLe: x.maj_le,
      statut: x.statut,
      motifRefus: x.motif_refus,
      ventesMoy: arrondi(parCode.get(x.code_article) || 0),
      stockDepots: depots(x),
      alertes: [],
    })),
  ].sort((a, b) => new Date(b.majLe) - new Date(a.majLe));

  json(res, 200, { propositions: liste });
}

async function apiSupprimerProposition(req, res, url) {
  const code = (url.searchParams.get('codeArticle') || '').trim();
  const table = url.searchParams.get('type') === 'collection' ? 'propositions_collection' : 'propositions';
  if (!code) return json(res, 400, { erreur: 'codeArticle manquant.' });
  await db.requete(`DELETE FROM ${table} WHERE code_article = $1`, [code]);
  json(res, 200, { ok: true });
}

async function apiImportMinimums(req, res, url) {
  const famille = lireFamille(url);
  if (!famille) return json(res, 400, { erreur: 'Paramètre "famille" manquant (ex. Noël, Automne).' });
  const buffer = await lireCorps(req);
  if (!buffer.length) return json(res, 400, { erreur: 'Fichier vide.' });
  const { articles, avertissements } = await parserMinimums(buffer);
  await db.remplacerProduits(articles, famille);
  json(res, 200, {
    ok: true,
    famille,
    nbArticles: articles.length,
    nbAvecMin: articles.filter((a) => a.stockMin > 0).length,
    avertissements,
  });
}

async function apiImportVentes(req, res, url) {
  const famille = lireFamille(url);
  if (!famille) return json(res, 400, { erreur: 'Paramètre "famille" manquant (ex. Noël, Automne).' });
  const semaine = url.searchParams.get('semaine') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(semaine)) {
    return json(res, 400, { erreur: 'Paramètre "semaine" attendu au format YYYY-MM-DD (lundi de la semaine).' });
  }
  const fichier = url.searchParams.get('fichier') || null;
  const buffer = await lireCorps(req);
  if (!buffer.length) return json(res, 400, { erreur: 'Fichier vide.' });
  const { lignes, avertissements } = await parserVentes(buffer);
  await db.remplacerVentesSemaine(semaine, fichier, lignes, famille);
  json(res, 200, {
    ok: true,
    semaine,
    famille,
    nbLignes: lignes.length,
    nbPieces: Math.round(lignes.reduce((s, l) => s + l.qteTotale, 0)),
    avertissements,
  });
}

async function apiImportCollections(req, res, url) {
  const famille = lireFamille(url);
  if (!famille) return json(res, 400, { erreur: 'Paramètre "famille" manquant (ex. Noël, Automne).' });
  const buffer = await lireCorps(req);
  if (!buffer.length) return json(res, 400, { erreur: 'Fichier vide.' });
  const { lignes, collections, avertissements } = await parserCollections(buffer);
  await db.remplacerCollections(lignes, collections, famille);
  json(res, 200, { ok: true, famille, nbArticles: lignes.length, nbCollections: collections.length, avertissements });
}

async function apiImportPhotos(req, res) {
  const buffer = await lireCorps(req);
  if (!buffer.length) return json(res, 400, { erreur: 'Fichier vide.' });
  const { lignes, avertissements } = await parserPhotos(buffer);
  await db.upsertPhotos(lignes);
  // Bilan par famille : un même fichier peut mélanger Noël, Automne…
  const familles = await db.famillesPourCodes(lignes.map((l) => l.codeArticle));
  const compte = new Map();
  let nbInconnus = 0;
  for (const l of lignes) {
    const fam = familles.get(l.codeArticle);
    if (fam == null) { nbInconnus++; continue; }
    compte.set(fam, (compte.get(fam) || 0) + 1);
  }
  const parFamille = [...compte.entries()]
    .map(([famille, nb]) => ({ famille, nb }))
    .sort((a, b) => a.famille.localeCompare(b.famille, 'fr'));
  json(res, 200, { ok: true, nbPhotos: lignes.length, parFamille, nbInconnus, avertissements });
}

async function apiCollections(req, res, url) {
  const famille = lireFamille(url);
  const r = famille
    ? await db.requete('SELECT nom FROM collections WHERE famille = $1 ORDER BY nom', [famille])
    : await db.requete('SELECT nom FROM collections ORDER BY nom');
  json(res, 200, { collections: r.rows.map((x) => x.nom) });
}

// Familles connues (pour les listes de choix de l'admin).
async function apiFamilles(req, res) {
  const r = await db.requete('SELECT DISTINCT famille FROM produits ORDER BY famille');
  json(res, 200, { familles: r.rows.map((x) => x.famille) });
}

// Liste des collègues pour l'identification sur les Zebra (gérée dans l'admin).
async function apiCollegues(req, res) {
  const r = await db.requete('SELECT nom FROM collegues ORDER BY nom');
  json(res, 200, { collegues: r.rows.map((x) => x.nom) });
}

async function apiCollegueAjout(req, res) {
  let corps;
  try {
    corps = JSON.parse((await lireCorps(req, 16 * 1024)).toString('utf8'));
  } catch {
    return json(res, 400, { erreur: 'Corps JSON invalide.' });
  }
  const nom = String(corps.nom || '').trim().slice(0, 60);
  if (!nom) return json(res, 400, { erreur: 'Nom manquant.' });
  await db.requete('INSERT INTO collegues (nom) VALUES ($1) ON CONFLICT (nom) DO NOTHING', [nom]);
  json(res, 200, { ok: true });
}

async function apiCollegueSuppr(req, res, url) {
  const nom = (url.searchParams.get('nom') || '').trim();
  if (!nom) return json(res, 400, { erreur: 'Nom manquant.' });
  await db.requete('DELETE FROM collegues WHERE nom = $1', [nom]);
  json(res, 200, { ok: true });
}

async function apiScansInconnus(req, res) {
  const r = await db.requete('SELECT * FROM scans_inconnus ORDER BY dernier_le DESC LIMIT 100');
  json(res, 200, {
    scans: r.rows.map((s) => ({ code: s.code, nb: s.nb, premierLe: s.premier_le, dernierLe: s.dernier_le })),
  });
}

async function apiScansVider(req, res) {
  await db.requete('DELETE FROM scans_inconnus');
  json(res, 200, { ok: true });
}

async function apiEtat(req, res) {
  const prod = await db.requete('SELECT COUNT(*)::int AS nb, MAX(maj_le) AS maj FROM produits');
  const prodFam = await db.requete('SELECT famille, COUNT(*)::int AS nb FROM produits GROUP BY famille ORDER BY famille');
  const sem = await db.requete('SELECT debut, nb_lignes, importe_le FROM semaines_ventes ORDER BY debut DESC LIMIT 8');
  const semFam = await db.requete('SELECT semaine, famille, COUNT(*)::int AS nb FROM lignes_ventes GROUP BY semaine, famille');
  const coll = await db.requete('SELECT COUNT(*)::int AS nb FROM collections_articles');
  const compte = async (table) => (await db.requete(
    `SELECT COUNT(*)::int AS total,
            SUM(CASE WHEN statut = 'a_traiter' THEN 1 ELSE 0 END)::int AS a_traiter,
            SUM(CASE WHEN statut = 'validee' THEN 1 ELSE 0 END)::int AS validees
       FROM ${table}`
  )).rows[0];
  const pMin = await compte('propositions');
  const pColl = await compte('propositions_collection');
  json(res, 200, {
    produits: {
      nb: prod.rows[0].nb,
      majLe: prod.rows[0].maj,
      parFamille: prodFam.rows.map((x) => ({ famille: x.famille, nb: x.nb })),
    },
    semaines: sem.rows.map((s) => ({
      debut: dateISO(s.debut),
      nbLignes: s.nb_lignes,
      importeLe: s.importe_le,
      parFamille: semFam.rows
        .filter((x) => dateISO(x.semaine) === dateISO(s.debut))
        .map((x) => ({ famille: x.famille, nb: x.nb })),
    })),
    collections: { nbArticles: coll.rows[0].nb },
    propositions: {
      total: (pMin.total || 0) + (pColl.total || 0),
      aTraiter: (pMin.a_traiter || 0) + (pColl.a_traiter || 0),
      validees: (pMin.validees || 0) + (pColl.validees || 0),
    },
  });
}

// Export Excel : seules les propositions VALIDÉES sortent (mode par défaut),
// et passent alors « traitée ». mode=toutes re-télécharge validées + traitées.
async function apiExport(req, res, url) {
  const type = url.searchParams.get('type') === 'collection' ? 'collection' : 'min';
  const mode = url.searchParams.get('mode') === 'toutes' ? 'toutes' : 'validees';
  const table = type === 'collection' ? 'propositions_collection' : 'propositions';
  const filtre = mode === 'validees' ? "WHERE pr.statut = 'validee'" : "WHERE pr.statut IN ('validee', 'traitee')";
  const r = await db.requete(
    `SELECT pr.*, p.fournisseur, p.num_commande, p.vpe, p.stock_max, p.famille
       FROM ${table} pr LEFT JOIN produits p ON p.code_article = pr.code_article
      ${filtre}
      ORDER BY pr.maj_le DESC`
  );
  if (!r.rows.length) {
    return json(res, 404, {
      erreur: mode === 'validees'
        ? 'Aucune proposition validée à exporter. Validez d’abord les propositions à traiter.'
        : 'Aucune proposition validée ou traitée.',
    });
  }

  const buffer = type === 'collection'
    ? await genererExportCollections(r.rows)
    : await genererExportPropositions(r.rows);
  await db.requete(`UPDATE ${table} SET statut = 'traitee', exporte_le = now() WHERE statut = 'validee'`);
  const nom = `${type === 'collection' ? 'collections' : 'adaptations-minimums'}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${nom}"`,
    'Content-Length': buffer.length,
  });
  res.end(buffer);
}

// --- Routage ----------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public');

function servirStatique(res, fichier) {
  const cible = path.join(PUBLIC_DIR, fichier);
  if (!cible.startsWith(PUBLIC_DIR) || !fs.existsSync(cible) || !fs.statSync(cible).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Introuvable');
  }
  const ext = path.extname(cible);
  res.writeHead(200, {
    'Content-Type': MIMES[ext] || 'application/octet-stream',
    // Les pages HTML doivent être revalidées à chaque visite, sinon les TC26
    // gardent l'ancienne version après un déploiement.
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(cible).pipe(res);
}

const serveur = http.createServer(async (req, res) => {
  // Hors du try, une adresse illisible (en-tête Host malformé…) levait une
  // exception non rattrapée qui arrêtait tout le serveur : on répond 400.
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Requête invalide'); }
  const route = `${req.method} ${url.pathname}`;

  try {
    // --- Porte du portail : l'entrée et la sortie ---
    // Un laissez-passer périmé, mal signé ou fabriqué ne dit pas lequel des
    // trois : retour à la page scan avec un motif, elle propose de repasser par
    // Famiportail.
    if (url.pathname === '/entrer') {
      if (!PORTAIL_SECRET || !SESSION_SECRET) {
        // Sans secret, on ne signe rien : un message clair plutôt qu'un refus
        // que personne ne saurait expliquer.
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(`Famiminmax n'est pas encore relié au portail : ${PORTAIL_SECRET ? 'FAMIMINMAX_SESSION_SECRET' : 'FAMIMINMAX_SECRET'} manque sur ce service.`);
      }
      const venu = ouvreJeton(url.searchParams.get('j'), PORTAIL_SECRET);
      if (!venu) {
        res.writeHead(302, { Location: '/?acces=refuse', 'Cache-Control': 'no-store' });
        return res.end();
      }
      // Une fiche Famicard sans prénom ni nom bloquerait les propositions (nom
      // obligatoire) : on signe alors avec l'id.
      const nom = venu.nom.slice(0, 80) || `Famicard n° ${venu.id}`;
      poseSession(req, res, { id: venu.id, nom });
      const versAdmin = url.searchParams.get('vers') === 'admin' && ADMINS_PORTAIL.has(venu.id);
      res.writeHead(302, { Location: versAdmin ? '/admin' : '/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    // « Changer d'utilisateur » sur un Zebra partagé : la session portail se
    // ferme, la page scan revient à l'identification sur l'appareil.
    if (url.pathname === '/sortir') {
      res.writeHead(302, {
        'Set-Cookie': 'fmm=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (enHttps(req) ? '; Secure' : ''),
        Location: '/',
        'Cache-Control': 'no-store',
      });
      return res.end();
    }

    if (url.pathname.startsWith('/api/')) {
      const ADMIN_ROUTES = ['/api/propositions', '/api/proposition-suppr', '/api/proposition-decision',
        '/api/import/minimums', '/api/import/ventes', '/api/import/collections',
        '/api/etat', '/api/export', '/api/scans-inconnus', '/api/scans-inconnus-vider',
        '/api/collegues-ajout', '/api/collegues-suppr', '/api/import/photos'];
      if (ADMIN_ROUTES.includes(url.pathname) && !estAdmin(req, url)) {
        return json(res, 401, { erreur: 'Code d’accès admin invalide.' });
      }
      if (route === 'GET /api/sante') {
        return json(res, 200, {
          ok: true,
          version: (process.env.RAILWAY_GIT_COMMIT_SHA || 'dev').slice(0, 7),
        });
      }
      // Qui est arrivé par le portail (public : sans session, { portail: false }).
      // resteMs : la durée qui reste, pas l'heure de fin (l'horloge d'un Zebra
      // peut être fausse) ; la page oublie le nom une fois la session échue.
      if (route === 'GET /api/moi') {
        const qui = lireSession(req);
        return json(res, 200, qui
          ? { portail: true, nom: qui.nom, centralId: Number(qui.id), portailUrl: FAMIPORTAIL_URL,
              resteMs: Math.max(0, qui.exp * 1000 - Date.now()) }
          : { portail: false });
      }
      if (route === 'GET /api/produit') return await apiProduit(req, res, url);
      if (route === 'POST /api/proposition') return await apiProposer(req, res);
      if (route === 'POST /api/proposition-collection') return await apiProposerCollection(req, res);
      if (route === 'GET /api/collections') return await apiCollections(req, res, url);
      if (route === 'GET /api/familles') return await apiFamilles(req, res);
      if (route === 'GET /api/collegues') return await apiCollegues(req, res);
      if (route === 'POST /api/collegues-ajout') return await apiCollegueAjout(req, res);
      if (route === 'POST /api/collegues-suppr') return await apiCollegueSuppr(req, res, url);
      if (route === 'GET /api/propositions') return await apiPropositions(req, res);
      if (route === 'POST /api/proposition-suppr') return await apiSupprimerProposition(req, res, url);
      if (route === 'POST /api/proposition-decision') return await apiDecision(req, res);
      if (route === 'POST /api/import/minimums') return await apiImportMinimums(req, res, url);
      if (route === 'POST /api/import/ventes') return await apiImportVentes(req, res, url);
      if (route === 'POST /api/import/collections') return await apiImportCollections(req, res, url);
      if (route === 'POST /api/import/photos') return await apiImportPhotos(req, res);
      if (route === 'GET /api/etat') return await apiEtat(req, res);
      if (route === 'GET /api/scans-inconnus') return await apiScansInconnus(req, res);
      if (route === 'POST /api/scans-inconnus-vider') return await apiScansVider(req, res);
      if (route === 'GET /api/export') return await apiExport(req, res, url);
      return json(res, 404, { erreur: 'Route inconnue.' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { erreur: 'Méthode non autorisée.' });
    }
    if (url.pathname === '/') return servirStatique(res, 'index.html');
    if (url.pathname === '/admin') return servirStatique(res, 'admin.html');
    return servirStatique(res, url.pathname.slice(1));
  } catch (e) {
    const code = e.code === 413 ? 413 : 500;
    console.error(`[erreur] ${route} :`, e.message);
    json(res, code, { erreur: e.message || 'Erreur interne.' });
  }
});

async function demarrer() {
  await db.initSchema();
  serveur.listen(PORT, () => {
    console.log(`Famiminmax en écoute sur le port ${PORT}`);
    if (!ADMIN_CODE) console.warn('⚠ ADMIN_CODE non défini : les pages admin sont accessibles sans code.');
    if (PORTAIL_SECRET && !SESSION_SECRET) console.warn('⚠ FAMIMINMAX_SESSION_SECRET manque : /entrer répond 503.');
    if (PORTAIL_SECRET && PORTAIL_SECRET === SESSION_SECRET) console.warn('⚠ FAMIMINMAX_SESSION_SECRET doit différer de FAMIMINMAX_SECRET.');
  });
}

if (require.main === module) {
  demarrer().catch((e) => {
    console.error('Démarrage impossible :', e);
    process.exit(1);
  });
}

module.exports = { serveur, demarrer };
