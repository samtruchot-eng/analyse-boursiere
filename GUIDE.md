# Analyse boursière — votre page personnelle

Une page web qui affiche de **vrais cours** et leur analyse. Vous l'ouvrez d'un
simple lien, sur **téléphone ou ordinateur**, **sans rien installer**.

> 🔒 **Ce projet est indépendant** — il n'a aucun lien avec l'extranet
> professionnel. Mettez-le sur **vos comptes personnels** (GitHub perso + Vercel
> perso).

---

## Mettre la page en ligne (une seule fois, ~5 min)

Le calcul a besoin d'un serveur qui a accès à Internet : on utilise **Vercel**
(gratuit). Vercel se connecte à **GitHub** (gratuit) où vivra le code. Tout se
fait dans le navigateur, **sans terminal**.

### Étape 1 — Compte GitHub personnel
1. Si vous n'en avez pas : créez un compte gratuit sur **https://github.com**
   (utilisez une adresse **personnelle**, pas votre adresse pro).

### Étape 2 — Créer un dépôt et y déposer ces fichiers
1. Sur GitHub, cliquez le **+** en haut à droite → **« New repository »**.
2. Nommez-le par ex. `analyse-boursiere`, laissez **Public** ou **Private**,
   cliquez **« Create repository »**.
3. Sur la page du dépôt vide, cliquez le lien **« uploading an existing file »**.
4. **Glissez-déposez** dans la fenêtre **tout le contenu** de ce dossier :
   - le fichier `index.html`
   - le fichier `vercel.json`
   - le **dossier** `api` (avec `analyze.js` dedans)
   *(GitHub conserve la structure des dossiers.)*
5. Cliquez **« Commit changes »**.

### Étape 3 — Déployer sur Vercel personnel
1. Allez sur **https://vercel.com** → **« Sign Up »** → **« Continue with
   GitHub »** (avec votre compte perso).
2. Cliquez **« Add New… » → « Project »**.
3. Choisissez votre dépôt **`analyse-boursiere`** → **« Import »**.
4. Ne touchez à rien, cliquez **« Deploy »**.
5. Après ~1 min, Vercel affiche un lien du type
   `https://analyse-boursiere.vercel.app`. **C'est votre page !**

### Étape 4 — L'avoir sous la main
- **iPhone (Safari)** : ouvrez le lien → bouton Partager → **« Sur l'écran
  d'accueil »** : vous obtenez une icône comme une application.
- **Android (Chrome)** : menu ⋮ → **« Ajouter à l'écran d'accueil »**.

---

## Utilisation

- Tapez vos symboles séparés par des virgules : `AAPL, MSFT, NVDA`.
- Chaque titre affiche : **score 0–100**, recommandation, mini-graphe,
  explications en français, profil de risque et points de vigilance.

**Symboles utiles** : `AAPL` Apple · `MSFT` Microsoft · `GOOGL` Google ·
`NVDA` Nvidia · `AMZN` Amazon · `TSLA` Tesla · `SPY` indice S&P 500.
Valeurs de Paris : ajoutez `.fr` (ex. `air.fr` Airbus, `mc.fr` LVMH, `bnp.fr`).

---

## Mettre à jour plus tard
Pour changer quelque chose, modifiez le fichier sur GitHub (crayon ✏️ →
« Commit »). Vercel redéploie **tout seul** en quelques secondes.

---

⚠️ **Avertissement.** Analyse technique automatisée, à but informatif et
pédagogique. Ne constitue **pas un conseil en investissement**. Les performances
passées ne préjugent pas des performances futures. Investir comporte un risque de
perte en capital.
