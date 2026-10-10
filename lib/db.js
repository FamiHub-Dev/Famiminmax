'use strict';
// Accès Postgres. Le pool peut être injecté (tests pg-mem) via setPool().

const SCHEMA = `
CREATE TABLE IF NOT EXISTS produits (
  code_article TEXT PRIMARY KEY,
  famille TEXT NOT NULL DEFAULT 'Noël',
  ean TEXT,
  description TEXT NOT NULL DEFAULT '',
  stock_min INTEGER NOT NULL DEFAULT 0,
  stock_max INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  vpe INTEGER,
  vk12 INTEGER,
  prix_achat NUMERIC,
  fournisseur TEXT,
  num_commande TEXT,
  actif BOOLEAN NOT NULL DEFAULT TRUE,
  stock_depot INTEGER,
  stock_depot2 INTEGER,
  stock_fdcm INTEGER,
  maj_le TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_produits_ean ON produits(ean);

CREATE TABLE IF NOT EXISTS scans_inconnus (
  code TEXT PRIMARY KEY,
  nb INTEGER NOT NULL DEFAULT 1,
  premier_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  dernier_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS semaines_ventes (
  debut DATE PRIMARY KEY,
  fichier TEXT,
  nb_lignes INTEGER NOT NULL DEFAULT 0,
  importe_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lignes_ventes (
  semaine DATE NOT NULL,
  code_article TEXT NOT NULL,
  famille TEXT NOT NULL DEFAULT 'Noël',
  ean TEXT,
  qte_totale NUMERIC NOT NULL DEFAULT 0,
  qte_fami NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (semaine, code_article)
);
CREATE INDEX IF NOT EXISTS idx_lignes_code ON lignes_ventes(code_article);

CREATE TABLE IF NOT EXISTS propositions (
  code_article TEXT PRIMARY KEY,
  ean TEXT,
  description TEXT,
  min_actuel INTEGER,
  min_propose INTEGER NOT NULL,
  commentaire TEXT,
  auteur TEXT,
  statut TEXT NOT NULL DEFAULT 'a_traiter',
  motif_refus TEXT,
  decide_le TIMESTAMPTZ,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  exporte_le TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS collections_articles (
  code_article TEXT PRIMARY KEY,
  famille TEXT NOT NULL DEFAULT 'Noël',
  ean TEXT,
  collection TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  nom TEXT PRIMARY KEY,
  famille TEXT NOT NULL DEFAULT 'Noël'
);

CREATE TABLE IF NOT EXISTS collegues (
  nom TEXT PRIMARY KEY,
  ajoute_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS photos_articles (
  code_article TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  maj_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS propositions_collection (
  code_article TEXT PRIMARY KEY,
  ean TEXT,
  description TEXT,
  collection_actuelle TEXT,
  collection_proposee TEXT NOT NULL,
  auteur TEXT,
  statut TEXT NOT NULL DEFAULT 'a_traiter',
  motif_refus TEXT,
  decide_le TIMESTAMPTZ,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  exporte_le TIMESTAMPTZ
);
`;

let pool = null;

function setPool(p) { pool = p; }

function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL manquant : renseigne la variable d’environnement (Postgres Railway).');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

// Colonnes ajoutées après la première mise en production : appliquées une à une,
// l'échec « colonne existe déjà » est ignoré.
const MIGRATIONS = [
  'ALTER TABLE produits ADD COLUMN actif BOOLEAN NOT NULL DEFAULT TRUE',
  'ALTER TABLE produits ADD COLUMN stock_depot INTEGER',
  'ALTER TABLE produits ADD COLUMN stock_depot2 INTEGER',
  'ALTER TABLE produits ADD COLUMN stock_fdcm INTEGER',
  "ALTER TABLE propositions ADD COLUMN statut TEXT NOT NULL DEFAULT 'a_traiter'",
  'ALTER TABLE propositions ADD COLUMN motif_refus TEXT',
  'ALTER TABLE propositions ADD COLUMN decide_le TIMESTAMPTZ',
  // Reprise de l'existant : ce qui avait déjà été exporté passe « traitée » (idempotent)
  "UPDATE propositions SET statut = 'traitee' WHERE exporte_le IS NOT NULL AND statut = 'a_traiter'",
  // Validation automatique : plus d'état « à traiter », tout est validé sauf refus explicite
  "UPDATE propositions SET statut = 'validee' WHERE statut = 'a_traiter'",
  "UPDATE propositions_collection SET statut = 'validee' WHERE statut = 'a_traiter'",
  // Multi-familles : les données historiques sont du Noël
  "ALTER TABLE produits ADD COLUMN famille TEXT NOT NULL DEFAULT 'Noël'",
  "ALTER TABLE lignes_ventes ADD COLUMN famille TEXT NOT NULL DEFAULT 'Noël'",
  "ALTER TABLE collections_articles ADD COLUMN famille TEXT NOT NULL DEFAULT 'Noël'",
  "ALTER TABLE collections ADD COLUMN famille TEXT NOT NULL DEFAULT 'Noël'",
];

// Colonnes FACULTATIVES : rien n'en dépend pour fonctionner. Un échec est dit
// dans les journaux et le démarrage continue (là où MIGRATIONS, ci-dessus,
// arrête tout sur une erreur inattendue).
const MIGRATIONS_FACULTATIVES = [
  // Porte du portail : id Famicard de qui a signé (NULL = nom saisi sur un Zebra)
  'ALTER TABLE propositions ADD COLUMN IF NOT EXISTS auteur_central_id INTEGER',
  'ALTER TABLE propositions_collection ADD COLUMN IF NOT EXISTS auteur_central_id INTEGER',
];

async function initSchema() {
  const client = await getPool().connect();
  try {
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
      await client.query(stmt);
    }
    for (const stmt of MIGRATIONS) {
      try {
        await client.query(stmt);
      } catch (e) {
        if (!/existe déjà|already exists|duplicate column/i.test(e.message)) throw e;
      }
    }
    for (const stmt of MIGRATIONS_FACULTATIVES) {
      try {
        await client.query(stmt);
      } catch (e) {
        console.warn('[schéma] migration facultative non appliquée :', stmt, '—', e.message);
      }
    }
  } finally {
    client.release();
  }
}

const requete = (text, params) => getPool().query(text, params);

// Remplace le référentiel produits d'UNE famille (import du fichier minimums).
// Les autres familles ne sont pas touchées.
async function remplacerProduits(articles, famille) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM produits WHERE famille = $1', [famille]);
    const TAILLE = 500;
    for (let i = 0; i < articles.length; i += TAILLE) {
      const lot = articles.slice(i, i + TAILLE);
      const valeurs = [];
      const params = [];
      lot.forEach((a, j) => {
        const b = j * 16;
        valeurs.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15},$${b + 16})`);
        params.push(a.codeArticle, famille, a.ean || null, a.description, a.stockMin, a.stockMax, a.stock,
          a.vpe, a.vk12, a.prixAchat, a.fournisseur || null, a.numCommande || null,
          a.actif !== false, a.stockDepot, a.stockDepot2, a.stockFdcm);
      });
      await client.query(
        `INSERT INTO produits (code_article, famille, ean, description, stock_min, stock_max, stock, vpe, vk12, prix_achat, fournisseur, num_commande, actif, stock_depot, stock_depot2, stock_fdcm)
         VALUES ${valeurs.join(',')}
         ON CONFLICT (code_article) DO UPDATE SET
           famille = EXCLUDED.famille, ean = EXCLUDED.ean, description = EXCLUDED.description, stock_min = EXCLUDED.stock_min,
           stock_max = EXCLUDED.stock_max, stock = EXCLUDED.stock, vpe = EXCLUDED.vpe, vk12 = EXCLUDED.vk12,
           prix_achat = EXCLUDED.prix_achat, fournisseur = EXCLUDED.fournisseur, num_commande = EXCLUDED.num_commande,
           actif = EXCLUDED.actif, stock_depot = EXCLUDED.stock_depot, stock_depot2 = EXCLUDED.stock_depot2, stock_fdcm = EXCLUDED.stock_fdcm`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Remplace les ventes d'une semaine (debut = lundi, 'YYYY-MM-DD') pour UNE famille.
// La semaine reste partagée entre familles : seule la famille importée est remplacée.
async function remplacerVentesSemaine(debut, fichier, lignes, famille) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM lignes_ventes WHERE semaine = $1 AND famille = $2', [debut, famille]);
    await client.query(
      `INSERT INTO semaines_ventes (debut, fichier, nb_lignes) VALUES ($1, $2, $3)
       ON CONFLICT (debut) DO UPDATE SET fichier = EXCLUDED.fichier, nb_lignes = EXCLUDED.nb_lignes, importe_le = now()`,
      [debut, fichier || null, lignes.length]
    );
    const TAILLE = 500;
    for (let i = 0; i < lignes.length; i += TAILLE) {
      const lot = lignes.slice(i, i + TAILLE);
      const valeurs = [];
      const params = [];
      lot.forEach((l, j) => {
        const b = j * 6;
        valeurs.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
        params.push(debut, l.codeArticle, famille, l.ean || null, l.qteTotale, l.qteFami);
      });
      await client.query(
        `INSERT INTO lignes_ventes (semaine, code_article, famille, ean, qte_totale, qte_fami) VALUES ${valeurs.join(',')}
         ON CONFLICT (semaine, code_article) DO UPDATE SET
           famille = EXCLUDED.famille, ean = EXCLUDED.ean, qte_totale = EXCLUDED.qte_totale, qte_fami = EXCLUDED.qte_fami`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Remplace le référentiel collections d'UNE famille (import du fichier collections).
async function remplacerCollections(lignes, collections, famille) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM collections_articles WHERE famille = $1', [famille]);
    await client.query('DELETE FROM collections WHERE famille = $1', [famille]);
    const TAILLE = 500;
    for (let i = 0; i < lignes.length; i += TAILLE) {
      const lot = lignes.slice(i, i + TAILLE);
      const valeurs = [];
      const params = [];
      lot.forEach((l, j) => {
        const b = j * 4;
        valeurs.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
        params.push(l.codeArticle, famille, l.ean || null, l.collection);
      });
      await client.query(
        `INSERT INTO collections_articles (code_article, famille, ean, collection) VALUES ${valeurs.join(',')}
         ON CONFLICT (code_article) DO UPDATE SET
           famille = EXCLUDED.famille, ean = EXCLUDED.ean, collection = EXCLUDED.collection`,
        params
      );
    }
    for (let i = 0; i < collections.length; i += TAILLE) {
      const lot = collections.slice(i, i + TAILLE);
      const valeurs = [];
      const params = [];
      lot.forEach((nom, j) => {
        valeurs.push(`($${j * 2 + 1},$${j * 2 + 2})`);
        params.push(nom, famille);
      });
      await client.query(
        `INSERT INTO collections (nom, famille) VALUES ${valeurs.join(',')}
         ON CONFLICT (nom) DO UPDATE SET famille = EXCLUDED.famille`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Ajoute/actualise les photos (fusion : un fichier par famille peut être importé
// sans effacer les photos des autres familles).
async function upsertPhotos(lignes) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const TAILLE = 500;
    for (let i = 0; i < lignes.length; i += TAILLE) {
      const lot = lignes.slice(i, i + TAILLE);
      const valeurs = [];
      const params = [];
      lot.forEach((l, j) => {
        valeurs.push(`($${j * 2 + 1},$${j * 2 + 2})`);
        params.push(l.codeArticle, l.url);
      });
      await client.query(
        `INSERT INTO photos_articles (code_article, url) VALUES ${valeurs.join(',')}
         ON CONFLICT (code_article) DO UPDATE SET url = EXCLUDED.url, maj_le = now()`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Famille de chaque code article connu du référentiel (bilan d'import photos).
async function famillesPourCodes(codes) {
  const parCode = new Map();
  const TAILLE = 500;
  for (let i = 0; i < codes.length; i += TAILLE) {
    const lot = codes.slice(i, i + TAILLE);
    const r = await requete(
      `SELECT code_article, famille FROM produits WHERE code_article IN (${lot.map((_, j) => '$' + (j + 1)).join(',')})`,
      lot
    );
    r.rows.forEach((x) => parCode.set(x.code_article, x.famille));
  }
  return parCode;
}

module.exports = { setPool, getPool, initSchema, requete, remplacerProduits, remplacerVentesSemaine, remplacerCollections, upsertPhotos, famillesPourCodes };
