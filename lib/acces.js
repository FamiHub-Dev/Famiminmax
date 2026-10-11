'use strict';
// Famicard dit qui a accès — contrat « Famicard dit qui a accès », le même pour
// tous les services du portail (voir le README, « Accès décidé par Famicard »).
//
// Famicard est le SEUL juge : la case de la fiche (et ses règles : comptes
// inactifs, profils « FamiFormation seule »…) décide. On ne recopie pas sa
// décision, on lit la liste qu'il publie : au démarrage, puis toutes les 60 s,
// EN ARRIÈRE-PLAN, avec 5 s au plus pour répondre. Les portes la consultent en
// mémoire : aucune requête n'attend Famicard.
//
// ⚠️ FAMICARD QUI TOUSSE NE MET PERSONNE DEHORS. Injoignable, lent, ou une
// réponse qui ne ressemble pas au contrat : la dernière liste connue reste en
// vigueur. Elle est gardée en mémoire ET en base (table acces_famicard) pour
// survivre à un redémarrage pendant la panne. Si AUCUNE liste n'a jamais été
// reçue (tout premier démarrage), on laisse passer, et on le dit au journal.
//
// Deux modes (ACCES_FAMICARD_MODE) :
// - observer, PAR DÉFAUT : rien n'est refusé ; chaque refus qui AURAIT eu lieu
//   est noté (journal + rapport). C'est ce qui permet de publier sans risque.
// - appliquer : les refus sont réels. Réversible : la variable, et c'est tout.
//
// Ce module ne signe rien lui-même : le service lui passe sa fonction de
// signature (celle du laissez-passer), il n'y a qu'une façon de signer.

const db = require('./db');

const DELAI_MS = 5000; // une relecture plus longue est abandonnée
const PERIODE_MS = 60 * 1000; // une relecture par minute : un retrait vaut en une minute au plus
const VALIDITE_S = 120; // exp de la demande signée (Famicard en accepte 300 au plus)
const TAILLE_MAX = 5 * 1024 * 1024; // la liste de toute la maison tient en quelques dizaines de Ko
const REFUS_MAX = 500; // couples (qui, porte) détaillés dans le rapport, au-delà : « (autres) »
const RELANCE_MS = 10 * 1000; // relecture anticipée après une entrée refusée : une par 10 s au plus

// Motif lisible d'une relecture ratée, pour le journal et le rapport. fetch
// cache la vraie raison (ECONNREFUSED, ENOTFOUND…) dans e.cause.
function motif(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return `pas de réponse en ${DELAI_MS / 1000} s`;
  const cause = e && e.cause && (e.cause.code || e.cause.message);
  return ((e && (e.message || e.code)) || String(e)) + (cause ? ` (${cause})` : '');
}

// Un nom tel qu'il ira au journal : sans caractère de contrôle (un saut de
// ligne dans une fiche fabriquerait une fausse ligne de journal).
const nomPropre = (nom) => String(nom || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

// « personnes » reçue → Map id → nom. Tout ou rien : une seule entrée
// illisible et la réponse entière est écartée (la précédente reste).
function lirePersonnes(personnes) {
  if (!Array.isArray(personnes)) throw new Error('« personnes » manque ou n’est pas une liste');
  const liste = new Map();
  for (const p of personnes) {
    // Un id en texte (« 4 ») passe aussi : PDO rend souvent les entiers ainsi.
    const id = p && (typeof p.id === 'number' || typeof p.id === 'string') ? String(p.id) : '';
    if (!/^\d{1,9}$/.test(id) || Number(id) <= 0) throw new Error('id illisible dans « personnes »');
    liste.set(Number(id), typeof p.nom === 'string' ? nomPropre(p.nom).slice(0, 120) : '');
  }
  return liste;
}

// Forme rangée d'une liste : ce qu'on enregistre en base, et ce qu'on compare
// pour n'écrire que quand elle change.
const empreinte = (liste) => JSON.stringify([...liste].sort((a, b) => a[0] - b[0]).map(([id, nom]) => ({ id, nom })));

// « +Kim Peeters (n° 5), −Lise Martin (n° 12) » : ce qui a bougé, pour le journal.
function ecart(avant, apres) {
  const plus = [...apres.keys()].filter((id) => !avant.has(id)).map((id) => `+${apres.get(id) || '?'} (n° ${id})`);
  const moins = [...avant.keys()].filter((id) => !apres.has(id)).map((id) => `−${avant.get(id) || '?'} (n° ${id})`);
  const tout = [...plus, ...moins];
  return tout.length > 10 ? `${tout.slice(0, 10).join(', ')} … (${tout.length} changements)` : tout.join(', ');
}

// Qui, pour le journal et le rapport : « Kim Peeters (Famicard n° 5) ».
function quiTexte(qui) {
  const id = String(qui.id);
  const nom = nomPropre(qui.nom);
  return nom && nom !== `Famicard n° ${id}` ? `${nom} (Famicard n° ${id})` : `Famicard n° ${id}`;
}

// service : le code au catalogue Famicard (« famiminmax ») ; url : le point de
// lecture de Famicard ; mode : la valeur de ACCES_FAMICARD_MODE ; signer :
// message → signature hex, ou null sans secret (rien n'est alors demandé) ;
// variableSecret, secours : leurs noms, pour les messages.
function creerAcces({ service, url, mode, signer, variableSecret, secours: nomSecours }) {
  const brut = String(mode || '').trim().toLowerCase();
  const applique = brut === 'appliquer';
  if (brut && brut !== 'observer' && !applique) {
    console.warn(`⚠ ACCES_FAMICARD_MODE="${String(mode).trim().slice(0, 40)}" inconnu : mode observer, rien n'est refusé (valeurs : observer, appliquer).`);
  }

  let liste = null; // Map id → nom, ou null : aucune liste jamais reçue
  let origine = null; // 'famicard' (reçue par ce processus) ou 'base' (relue au démarrage)
  let recueLe = null; // dernière réception réussie (pour une copie en base : sa date)
  let genereLe = null; // ce que Famicard a écrit dans genere_le
  let derniereOk = false; // la dernière relecture a-t-elle réussi ?
  let erreur = null; // motif de la dernière relecture ratée
  let essaiLe = null;
  let echecsDeSuite = 0;
  let enCours = null; // la relecture en cours : une seule à la fois
  let minuterie = null;
  let dernierSignal = 0;
  let empreinteEnBase = null;
  let echecsEcriture = 0;
  const refus = new Map();
  const secours = { fois: 0, dernier: null };
  const sansListe = { fois: 0, dernier: null, noteLe: 0, depuisNote: 0 };

  const source = () => (!liste ? 'aucune' : origine === 'base' ? 'base' : derniereOk ? 'famicard' : 'memoire');

  // GET <url>?service=…&exp=…&sig=…, sig = hex(HMAC-SHA256("acces|" + service + "|" + exp)).
  async function lireFamicard() {
    const exp = Math.floor(Date.now() / 1000) + VALIDITE_S;
    let adresse;
    try { adresse = new URL(url); } catch { throw new Error(`adresse illisible : « ${String(url).slice(0, 80)} » (ACCES_FAMICARD_URL)`); }
    adresse.searchParams.set('service', service);
    adresse.searchParams.set('exp', String(exp));
    adresse.searchParams.set('sig', signer(`acces|${service}|${exp}`));
    // Le délai couvre tout : connexion, en-têtes ET corps.
    const rep = await fetch(adresse, { signal: AbortSignal.timeout(DELAI_MS), headers: { Accept: 'application/json' } });
    if (rep.status !== 200) {
      try { await rep.body?.cancel(); } catch { /* déjà fermé */ }
      throw new Error(`Famicard a répondu ${rep.status}`);
    }
    const morceaux = [];
    let taille = 0;
    if (rep.body) {
      for await (const morceau of rep.body) {
        taille += morceau.length;
        if (taille > TAILLE_MAX) throw new Error('réponse trop volumineuse');
        morceaux.push(Buffer.from(morceau));
      }
    }
    let data;
    try { data = JSON.parse(Buffer.concat(morceaux).toString('utf8')); } catch { throw new Error('réponse illisible (pas du JSON)'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('réponse sans objet JSON');
    if (String(data.contrat) !== '1') throw new Error(`contrat « ${String(data.contrat).slice(0, 20)} » inattendu (1 attendu)`);
    if (data.service !== service) throw new Error(`liste d’un autre service (« ${String(data.service).slice(0, 40)} »)`);
    const recue = lirePersonnes(data.personnes);
    if (data.total !== undefined && data.total !== null && Number(data.total) !== data.personnes.length) {
      throw new Error(`total incohérent (${String(data.total).slice(0, 20)} annoncés, ${data.personnes.length} reçus)`);
    }
    return { recue, genere: typeof data.genere_le === 'string' ? data.genere_le.slice(0, 40) : null };
  }

  // Copie en base, seulement quand la liste a changé (une écriture par
  // changement, pas une par minute). Un échec n'enlève rien à la mémoire : on
  // réessaie à la relecture suivante.
  async function enregistrer() {
    const forme = empreinte(liste);
    if (forme === empreinteEnBase) return;
    try {
      await db.requete(
        `INSERT INTO acces_famicard (service, personnes, total, genere_le) VALUES ($1, $2, $3, $4)
         ON CONFLICT (service) DO UPDATE SET
           personnes = EXCLUDED.personnes, total = EXCLUDED.total, genere_le = EXCLUDED.genere_le, recue_le = now()`,
        [service, forme, liste.size, genereLe]
      );
      empreinteEnBase = forme;
      echecsEcriture = 0;
    } catch (e) {
      // Au premier échec, puis tous les dix (une table absente ne doit pas
      // écrire une ligne par minute)
      if (++echecsEcriture === 1 || echecsEcriture % 10 === 0) {
        console.error(`[accès] liste non enregistrée en base (${motif(e)}) : elle vaut en mémoire, nouvel essai à la prochaine relecture.` +
          (echecsEcriture > 1 ? ` [${echecsEcriture} échecs de suite]` : ''));
      }
    }
  }

  async function relire() {
    essaiLe = new Date();
    try {
      if (!signer) throw new Error(`${variableSecret} manque : la liste n’est pas demandée`);
      const { recue, genere } = await lireFamicard();
      const avant = liste;
      const change = !avant || empreinte(avant) !== empreinte(recue);
      if (echecsDeSuite) console.log(`[accès] Famicard répond de nouveau (après ${echecsDeSuite} relecture(s) ratée(s)).`);
      liste = recue;
      origine = 'famicard';
      recueLe = new Date();
      genereLe = genere;
      derniereOk = true;
      erreur = null;
      echecsDeSuite = 0;
      if (change) {
        console.log(`[accès] liste Famicard « ${service} » : ${recue.size} personne(s)` +
          (avant ? ` — ${ecart(avant, recue) || 'noms changés'}` : '') + ` (mode ${applique ? 'appliquer' : 'observer'}).`);
        if (!recue.size) console.warn(`[accès] ⚠ liste VIDE reçue de Famicard : plus personne n'entre par le portail${applique ? '' : ' (en mode appliquer)'}.`);
      }
      await enregistrer();
    } catch (e) {
      derniereOk = false;
      erreur = motif(e);
      echecsDeSuite++;
      // Au premier échec, puis toutes les dix minutes : une panne longue ne
      // noie pas le journal.
      if (echecsDeSuite === 1 || echecsDeSuite % 10 === 0) {
        console.error(`[accès] liste Famicard non relue (${erreur}) : ` + (liste
          ? `la liste du ${recueLe.toISOString()} (${liste.size} personne(s)) reste en vigueur.`
          : 'aucune liste connue, on laisse passer.') + (echecsDeSuite > 1 ? ` [${echecsDeSuite} échecs de suite]` : ''));
      }
    }
  }

  // Une seule relecture à la fois ; ne lève jamais.
  function rafraichir() {
    if (!enCours) enCours = relire().finally(() => { enCours = null; });
    return enCours;
  }

  // Au démarrage, AVANT la première relecture : la copie en base. Un
  // redémarrage pendant une panne de Famicard ne rouvre donc rien.
  async function charger() {
    try {
      const { rows } = await db.requete('SELECT personnes, genere_le, recue_le FROM acces_famicard WHERE service = $1', [service]);
      if (!rows.length) {
        console.log('[accès] aucune liste en base : on attend celle de Famicard.');
        return;
      }
      const enBase = lirePersonnes(JSON.parse(rows[0].personnes));
      empreinteEnBase = empreinte(enBase);
      if (liste) return; // une relecture de Famicard est déjà passée : elle est plus fraîche
      liste = enBase;
      origine = 'base';
      recueLe = new Date(rows[0].recue_le);
      genereLe = rows[0].genere_le || null;
      console.log(`[accès] liste relue en base : ${enBase.size} personne(s), reçue de Famicard le ${recueLe.toISOString()}.`);
    } catch (e) {
      console.error(`[accès] liste en base illisible (${motif(e)}) : on attend celle de Famicard.`);
    }
  }

  function lancer() {
    if (minuterie) return;
    minuterie = setInterval(rafraichir, PERIODE_MS);
    minuterie.unref(); // n'empêche jamais le processus de s'arrêter
  }

  function arreter() {
    clearInterval(minuterie);
    minuterie = null;
  }

  async function demarrer() {
    console.log((applique
      ? `[accès] mode APPLIQUER : Famicard décide qui entre (liste « ${service} »`
      : `[accès] mode observer : rien n’est refusé, les refus qui auraient eu lieu sont notés (liste « ${service} »`) +
      `, relue toutes les 60 s sur ${url}).`);
    await charger();
    await rafraichir(); // 5 s au plus : la première requête trouve la liste
    if (signer) lancer(); // sans secret, rien à demander : la copie en base (s'il y en a une) reste
  }

  // Une entrée vient d'être refusée : si l'accès vient d'être coché dans
  // Famicard, la liste en mémoire a jusqu'à une minute de retard. On la relit
  // tout de suite, en arrière-plan : le prochain passage par le portail entre.
  function relireBientot() {
    const maintenant = Date.now();
    if (enCours || maintenant - dernierSignal < RELANCE_MS) return;
    dernierSignal = maintenant;
    rafraichir();
  }

  function noterRefus(qui, porte) {
    const texte = quiTexte(qui);
    let cle = `${texte}\u0000${porte}`;
    if (!refus.has(cle) && refus.size >= REFUS_MAX) cle = `(autres)\u0000${porte}`;
    const ligne = refus.get(cle) || { qui: cle.split('\u0000')[0], porte, fois: 0, dernier: null };
    ligne.fois++;
    ligne.dernier = new Date().toISOString();
    refus.set(cle, ligne);
    console.log(`[accès] ${applique ? 'REFUSÉ' : 'aurait été refusé (mode observer)'} : ${texte}, porte « ${porte} », absent de la liste Famicard.`);
  }

  function noterSansListe(qui, porte) {
    sansListe.fois++;
    sansListe.dernier = new Date().toISOString();
    sansListe.depuisNote++;
    const maintenant = Date.now();
    if (maintenant - sansListe.noteLe < 60 * 1000) return; // une note par minute au plus
    console.warn(`[accès] aucune liste reçue de Famicard : laissé passer ${quiTexte(qui)}, porte « ${porte} »` +
      (sansListe.depuisNote > 1 ? ` (${sansListe.depuisNote} passages depuis la dernière note).` : '.'));
    sansListe.noteLe = maintenant;
    sansListe.depuisNote = 0;
  }

  // LA question de chaque porte : qui ({ id, nom }) peut-il passer ? En mode
  // observer, oui, toujours : le refus qui AURAIT eu lieu est seulement noté.
  // Instantané : un Set en mémoire, jamais un appel à Famicard.
  function laissePasser(qui, porte) {
    if (!liste) {
      noterSansListe(qui, porte);
      return true;
    }
    if (liste.has(Number(qui.id))) return true;
    noterRefus(qui, porte);
    return !applique;
  }

  // Le secours de Jimmy passe toujours, même en appliquer ; chaque usage est
  // journalisé (le chemin seul : jamais le code, qui peut voyager en ?code=).
  function noterSecours(req) {
    secours.fois++;
    secours.dernier = new Date().toISOString();
    // Derrière Railway, le client est le premier de X-Forwarded-For ; en direct,
    // l'adresse de la connexion, sans le préfixe IPv6 des adresses IPv4.
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      String((req.socket && req.socket.remoteAddress) || '?').replace(/^::ffff:/, '');
    console.log(`[accès] secours ${nomSecours} : ${req.method} ${String(req.url || '').split('?')[0]} (${ip})`);
  }

  // Le rapport du contrat (et ce qui aide à le lire). refus : depuis le
  // démarrage, regroupés par (qui, porte), le plus récent d'abord.
  function rapport() {
    return {
      contrat: 1,
      service,
      mode: applique ? 'appliquer' : 'observer',
      liste: {
        recue_le: recueLe ? recueLe.toISOString() : null,
        total: liste ? liste.size : null,
        source: source(),
        genere_le: genereLe,
        essai_le: essaiLe ? essaiLe.toISOString() : null,
        erreur,
      },
      refus: [...refus.values()].sort((a, b) => b.dernier.localeCompare(a.dernier)).map((l) => ({ ...l })),
      comptes: { crees: [], desactives: [] }, // pas de comptes ici : la personne EST sa fiche Famicard
      secours: { porte: nomSecours, fois: secours.fois, dernier: secours.dernier },
      sans_liste: { fois: sansListe.fois, dernier: sansListe.dernier },
    };
  }

  return {
    applique,
    demarrer,
    charger,
    rafraichir,
    lancer,
    arreter,
    relireBientot,
    laissePasser,
    noterSecours,
    rapport,
    connue: () => !!liste,
    contient: (id) => !!liste && liste.has(Number(id)),
  };
}

module.exports = { creerAcces, DELAI_MS, PERIODE_MS };
