# Famiminmax

Consultation et adaptation des **minimums rayon** et des **collections** en magasin,
via scan sur Zebra TC26.

L'ERP ne permet pas de voir le minimum rayon paramétré par produit, ni de changer la
collection depuis un Zebra. Famiminmax comble ce trou : les collègues scannent un produit,
voient le minimum (= capacité du rayon plein), le stock, les ventes des 5 dernières semaines
et la collection, puis proposent une adaptation. Les propositions sont **validées d'office** ;
l'acheteur refuse celles qui posent problème (motif visible au rescan, alertes de fiabilité
pour les repérer) et exporte les validées en Excel au format d'import ERP.

## Écrans

- **`/` — page scan (TC26)** : champ de scan toujours actif (le TC26 scanne en mode clavier dans
  Chrome, aucune app à installer). Fiche produit : minimum rayon, stock, VPE, stocks dépôt,
  badge actif/inactif, VK-12, graphique des ventes Fami des 5 dernières semaines, collection
  actuelle. Deux formulaires de proposition : nouveau minimum (pas d'incrément = VPE) et
  changement de collection (liste fermée avec recherche). Une seule proposition par produit et
  par type : la dernière écrase la précédente et repart au début du circuit. Le collègue voit
  l'état de sa demande en rescannant (en attente / validée / traitée / refusée + motif).
  Article inactif sans stock dépôt = proposition de minimum désactivée.
- **`/admin` — administration (PC)** : protégée par code d'accès, deux onglets. « Propositions
  d'adaptation » : tableau avec **alertes de fiabilité**, action ✗ Refuser (motif obligatoire) —
  les propositions sont validées d'office. L'export ne sort que les **validées** et les passe
  « traitées » ; l'historique (refusées/traitées) reste consultable, avec revalidation possible.
  « Imports & données » : les trois imports et le journal des scans non reconnus.

## Alertes de fiabilité (propositions de minimum)

| Alerte | Déclencheur | Seuil (variable d'env.) |
|---|---|---|
| ⚠ ventes | min proposé < ventes moyennes hebdo × N | `SEUIL_COUVERTURE_SEMAINES` (défaut 1) |
| ⚠ dépôt | stock dépôts ≥ N × min proposé (et ≥ plancher) | `SEUIL_RATIO_DEPOT` (5), `SEUIL_DEPOT_MIN` (24) |
| ⚠ écart | min proposé ×N ou ÷N par rapport à l'actuel | `SEUIL_VARIATION` (5) |
| ⚠ VPE | min proposé non multiple du VPE | — |

## Familles

Chaque fichier ERP couvre **une famille** (Noël, Automne…) : la famille se choisit à l'import,
et l'import ne remplace que les données de sa famille. Les familles cohabitent : le scan
retrouve n'importe quel produit, la fiche affiche sa famille, et le sélecteur de collections
ne propose que les collections de la famille du produit scanné.

## Fichiers attendus

| Import | Source ERP | Colonnes clés |
|---|---|---|
| Minimums rayon | Export type « Beta4 », feuille `Export` | `Article`, `EAN barcode`, `Minimale Stock`, `Stock`, `VPE`, `VK-12`, `Actief AK`, `FDepot`, `FDepot2`, `FDCM` |
| Ventes d'une semaine | Export hebdo agrégé | `Artikelnummer`, `EANBarcode`, `Aantal`, `Fami (#)` |
| Collections | Export type « noel collection » | `N° art`, `Code EAN`, `Collectie` |

Les colonnes sont repérées par leur intitulé (l'ordre n'a pas d'importance). Un article présent
sur plusieurs lignes de ventes est cumulé. Les EAN scannés en UPC-A (12 chiffres) retrouvent
automatiquement l'EAN-13 à zéro de tête.

## Routine hebdomadaire

1. Exporter depuis l'ERP, **par famille** : minimums, ventes de la semaine écoulée, collections.
2. Sur `/admin` : importer les fichiers en choisissant la famille (et le **lundi** de la
   semaine pour les ventes).
3. Passer en revue les propositions (refuser les douteuses), puis « Minimums validés
   (format ERP) » → fichier `adaptations-minimums-AAAA-MM-JJ.xlsx` → import dans l'ERP.
   Idem pour les collections : le fichier contient une feuille « vue d'ensemble »
   et deux feuilles prêtes à importer dans Beco — « Import collections » (n° article +
   collection) et « Import tags », limitée aux articles dont le tag change, avec le
   tag initial et le nouveau (déduits des collections, p. ex. `SugarCrush26-06` →
   `SugarCrush26` ; cellule vide surlignée si aucun tag ne correspond).

## Déploiement Railway

1. Nouveau projet Railway → **Deploy from GitHub repo** → `hdrckji/Famiminmax`.
2. Ajouter une base **PostgreSQL** au projet.
3. Variables du service :
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ADMIN_CODE` = code d'accès de la page admin (obligatoire en production)
4. Settings → Networking → **Generate Domain**.

Le schéma de base se crée tout seul au démarrage, aucune migration à lancer.

## Connexion par Famiportail (s'ajoute, ne remplace rien)

La tuile du portail signe un laissez-passer d'une minute (`id|expiration|nom`, HMAC-SHA256,
même contrat que FamiTask et FamiPresta) et redirige vers `/entrer?j=…`. Famiminmax le vérifie
et ouvre une session de 8 h (cookie `fmm`). Avec cette session : nom affiché sans saisie, il
signe les propositions (`auteur` + `auteur_central_id`), bouton « Changer d'utilisateur »
(`/sortir`), bouton Famiportail. **Sans** session, rien ne change : page scan ouverte et nom
saisi sur le Zebra, code admin.

Le bouton Famiportail est le même sur tous les services : une icône au bout de la barre du haut,
posée dans `<span data-famiportail>` par le script du portail
(`https://famiportail.famiformation.com/assets/bouton-portail.js`, aucune copie ici). Page scan :
chargé **seulement** avec une session portail, un Zebra en libre-service ne l'a jamais ; `/admin` :
pour tout le monde.

| Variable | Rôle |
|---|---|
| `FAMIMINMAX_SECRET` | secret partagé avec Famiportail (même valeur des deux côtés). Absent : `/entrer` répond 503. |
| `FAMIMINMAX_SESSION_SECRET` | signe les cookies de session ; **différent** du précédent. Absent : `/entrer` répond 503. |
| `FAMIMINMAX_ADMINS` | **amorçage seulement** : au démarrage, si la table `portail_roles` est vide, ces ids Famicard (séparés par des virgules) y entrent `admin`. Ensuite c'est la table qui fait foi (rôles changés depuis Famicard, voir ci-dessous) et la variable n'est plus lue. |
| `FAMIPORTAIL_URL` | facultatif, adresse du portail rendue par `/api/moi` (`portailUrl`, défaut `https://famiportail.famiformation.com`). Le bouton Famiportail ne la lit pas : il mène toujours au portail. |

### Rôles, modifiables depuis la fiche Famicard

Qui entre par le portail a un rôle **ici**, rangé dans la table `portail_roles` (une ligne par id
Famicard) : `collegue` (propose minimums et collections ; c'est le défaut, pas de ligne = collègue)
ou `admin` (imports ERP, validation, exports). Famicard le lit et le change depuis la fiche
(contrat « rôles par service », commun aux services du portail) ; il ne le recopie pas.

- `GET /api/famicard/roles?exp=…&sig=…`, `sig = hex(HMAC-SHA256("roles|" + exp, FAMIMINMAX_SECRET))` :
  rend `{contrat: 1, service, roles: [{cle, libelle}], defaut, comptes: {"<id>": {role, compte}}}`.
- `POST /api/famicard/role` `{centralId, role, nom, exp, sig}`,
  `sig = hex(HMAC-SHA256("role|" + centralId + "|" + role + "|" + nom + "|" + exp, FAMIMINMAX_SECRET))` :
  pose le rôle, ou le pré-pose pour qui n'est pas encore venu. Rend `{ok: true, role}`.

Refus 403 si la signature est fausse, ou si `exp` est dépassé ou à plus de 300 s ; 400 pour un rôle
ou un id inconnus ; 503 sans `FAMIMINMAX_SECRET` ou si la base ne répond pas. Jamais de 500.

`/admin` par le portail (et `/entrer?vers=admin`) suit cette table, relue à chaque requête : un
changement depuis Famicard vaut tout de suite, sans repasser par le portail. Base qui ne répond
pas : pas admin. Le code `ADMIN_CODE` reste valable et ne passe pas par la table.

`railway.json` ne règle que le contrôle de santé (`/api/sante`, qui ne touche pas la base) :
une version qui ne démarre pas ne remplace jamais celle qui tourne.

## Développement

```bash
npm install
npm test          # E2E complet sur pg-mem (aucun Postgres local requis)
npm run verif -- minimums.xlsx ventes.xlsx   # vérifie les parseurs sur des fichiers réels
```

`npm start` exige `DATABASE_URL` (et éventuellement `ADMIN_CODE`, sinon admin en accès libre).
