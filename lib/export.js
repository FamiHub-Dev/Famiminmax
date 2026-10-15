'use strict';
// Génération du fichier Excel des propositions d'adaptation.
// Les 9 premières colonnes suivent le format d'import de l'ERP (intitulés exacts) ;
// « minimale/maximale voorraad » portent le min/max calculés depuis la proposition
// (voir lib/minmax.js). Les colonnes suivantes sont informatives (« vue d'ensemble »).

const ExcelJS = require('exceljs');
const { calculerMinMax } = require('./minmax');

const VERT_FONCE = 'FF245D39';
const VERT_CLAIR = 'FFE6F0D7';
const ORANGE_CLAIR = 'FFFCE8CC';
const MAGAZIJN = 'Fami';

// Tags ERP liés aux collections (critère séparé dans Beco : quand la
// collection d'un article change, son tag doit suivre).
const TAGS = [
  'Village26', 'Textile/Cadeaux26', 'SugarCrush26', 'Sapins artificiels26',
  'Neige26', 'MerryMushroom26', 'LumièreNoël26', 'Lemax26', 'Fluffy-Pilou26',
  'Fleurs Noël26', 'DisneyParade26', 'Catwalk26', 'BouleNoël26', 'Book&Bells26',
  'Art de la table26', 'Taps Noel26',
];

function normaliser(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '').toLowerCase();
}

// Tag correspondant à une collection : « SugarCrush26-06 » → « SugarCrush26 ».
// Tolère les variantes vues dans les exports ERP (« Sapins artificiels » sans 26,
// « Fleurs Noël 2026 », suffixe « -Podium »...). Renvoie '' si aucun tag ne colle
// (ex. « Emballages », « Zone - SPEL - 09 ») : à traiter à la main dans Beco.
function tagPourCollection(collection) {
  const col = normaliser(collection || '');
  if (!col) return '';
  let meilleur = '';
  let longueurMax = 0;
  for (const tag of TAGS) {
    const racine = normaliser(tag).replace(/26$/, '');
    if (!col.startsWith(racine)) continue;
    const reste = col.slice(racine.length);
    if (!/^((20)?26)?(-.*)?$/.test(reste)) continue;
    if (racine.length > longueurMax) { meilleur = tag; longueurMax = racine.length; }
  }
  return meilleur;
}

async function genererExportPropositions(propositions) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Famiminmax';
  const ws = wb.addWorksheet('Adaptations');

  ws.columns = [
    // --- Format ERP ---
    { header: 'artikelnummer', key: 'artikelnummer', width: 14 },
    { header: 'minimale voorraad', key: 'minimale_voorraad', width: 16 },
    { header: 'Omschrijving', key: 'omschrijving', width: 36 },
    { header: 'Magazijn', key: 'magazijn', width: 10 },
    { header: 'eanbarcode', key: 'eanbarcode', width: 16 },
    { header: 'BestelNr.', key: 'bestelnr', width: 14 },
    { header: 'afname', key: 'afname', width: 8 },
    { header: 'maximale voorraad', key: 'maximale_voorraad', width: 16 },
    { header: 'gereserveerde voorraad', key: 'gereserveerde_voorraad', width: 20 },
    // --- Vue d'ensemble ---
    { header: 'Proposition', key: 'proposition', width: 11 },
    { header: 'Min actuel', key: 'min_actuel', width: 11 },
    { header: 'Écart', key: 'ecart', width: 8 },
    { header: 'Stock dépôts', key: 'stock_depots', width: 12 },
    { header: 'Commentaire', key: 'commentaire', width: 40 },
    { header: 'Auteur', key: 'auteur', width: 16 },
    { header: 'Proposé le', key: 'maj_le', width: 18 },
    { header: 'Fournisseur', key: 'fournisseur', width: 26 },
    { header: 'Famille', key: 'famille', width: 12 },
  ];

  const entete = ws.getRow(1);
  entete.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  entete.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT_FONCE } };

  propositions.forEach((p, i) => {
    const minMax = calculerMinMax(p.min_propose, p.vpe);
    const row = ws.addRow({
      artikelnummer: p.code_article,
      minimale_voorraad: minMax.min,
      omschrijving: p.description || '',
      magazijn: MAGAZIJN,
      eanbarcode: p.ean || '',
      bestelnr: p.num_commande || '',
      afname: p.vpe == null ? '' : p.vpe,
      maximale_voorraad: minMax.max,
      gereserveerde_voorraad: 0,
      proposition: p.min_propose,
      min_actuel: p.min_actuel,
      ecart: p.min_propose - (p.min_actuel || 0),
      stock_depots: (p.stock_depot || 0) + (p.stock_depot2 || 0) + (p.stock_fdcm || 0),
      commentaire: p.commentaire || '',
      auteur: p.auteur || '',
      maj_le: p.maj_le ? new Date(p.maj_le) : null,
      fournisseur: p.fournisseur || '',
      famille: p.famille || '',
    });
    if (i % 2 === 1) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT_CLAIR } };
    }
    row.getCell('artikelnummer').numFmt = '@';
    row.getCell('eanbarcode').numFmt = '@';
    row.getCell('maj_le').numFmt = 'dd/mm/yyyy hh:mm';
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Export des propositions de collection : une feuille « vue d'ensemble »
// puis deux feuilles prêtes à importer dans Beco — « Import collections »
// (n° article + collection cible) et « Import tags », limitée aux articles
// dont le tag change, avec le tag initial (déduit de la collection actuelle)
// et le nouveau (cellule vide surlignée quand aucun tag ne correspond).
async function genererExportCollections(propositions) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Famiminmax';
  const ws = wb.addWorksheet('Collections');

  ws.columns = [
    { header: 'N° art', key: 'code_article', width: 14 },
    { header: 'Code EAN', key: 'ean', width: 16 },
    { header: 'Description', key: 'description', width: 36 },
    { header: 'Collectie actuelle', key: 'collection_actuelle', width: 22 },
    { header: 'Collectie proposée', key: 'collection_proposee', width: 22 },
    { header: 'Auteur', key: 'auteur', width: 16 },
    { header: 'Proposé le', key: 'maj_le', width: 18 },
    { header: 'Famille', key: 'famille', width: 12 },
  ];

  const entete = ws.getRow(1);
  entete.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  entete.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT_FONCE } };

  propositions.forEach((p, i) => {
    const row = ws.addRow({
      code_article: p.code_article,
      ean: p.ean || '',
      description: p.description || '',
      collection_actuelle: p.collection_actuelle || '',
      collection_proposee: p.collection_proposee,
      auteur: p.auteur || '',
      maj_le: p.maj_le ? new Date(p.maj_le) : null,
      famille: p.famille || '',
    });
    if (i % 2 === 1) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT_CLAIR } };
    }
    row.getCell('code_article').numFmt = '@';
    row.getCell('ean').numFmt = '@';
    row.getCell('maj_le').numFmt = 'dd/mm/yyyy hh:mm';
  });

  ws.autoFilter = { from: 'A1', to: 'H1' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // Feuilles prêtes à importer dans Beco, une par critère ERP.
  const wsColl = wb.addWorksheet('Import collections');
  wsColl.columns = [
    { header: 'N° article', key: 'code_article', width: 14 },
    { header: 'Collectie', key: 'collection', width: 24 },
  ];
  const wsTags = wb.addWorksheet('Import tags');
  wsTags.columns = [
    { header: 'N° article', key: 'code_article', width: 14 },
    { header: 'Tag initial', key: 'tag_initial', width: 24 },
    { header: 'Nouveau tag', key: 'tag', width: 24 },
  ];
  for (const w of [wsColl, wsTags]) {
    const e = w.getRow(1);
    e.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    e.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERT_FONCE } };
    w.views = [{ state: 'frozen', ySplit: 1 }];
  }

  propositions.forEach((p) => {
    const ligneColl = wsColl.addRow({ code_article: p.code_article, collection: p.collection_proposee });
    ligneColl.getCell('code_article').numFmt = '@';

    const tagInitial = tagPourCollection(p.collection_actuelle);
    const tag = tagPourCollection(p.collection_proposee);
    if (tag === tagInitial) return; // tag inchangé : rien à adapter dans Beco
    const ligneTag = wsTags.addRow({ code_article: p.code_article, tag_initial: tagInitial, tag });
    ligneTag.getCell('code_article').numFmt = '@';
    if (!tag) {
      ligneTag.getCell('tag').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ORANGE_CLAIR } };
    }
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { genererExportPropositions, genererExportCollections, tagPourCollection };
