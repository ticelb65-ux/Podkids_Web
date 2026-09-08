/* ===================================================================
   banque-sons.js
   Gère le chargement DIFFÉRÉ des catalogues de sons.

   Les fichiers banque-sons-jingles.js / ambiances.js / bruitages.js
   ne sont PAS chargés au démarrage de l'application (ils peuvent
   représenter plusieurs Mo). Ils sont chargés dynamiquement la
   première fois que l'utilisateur ouvre la bibliothèque de sons,
   ce qui accélère considérablement le démarrage.
   =================================================================== */

let BANQUE_SONS_CATALOGUE = [];
let _banqueChargee = false;
let _chargementEnCours = null;

/**
 * Charge les fichiers de la bibliothèque si ce n'est pas déjà fait.
 * Retourne une Promise résolue quand les sons sont disponibles.
 */
function chargerBanqueSons() {
  if (_banqueChargee) return Promise.resolve();
  if (_chargementEnCours) return _chargementEnCours;

  _chargementEnCours = new Promise((resolve) => {
    const fichiers = [
      'js/banque-sons-jingles.js',
      'js/banque-sons-ambiances.js',
      'js/banque-sons-bruitages.js',
    ];

    let charges = 0;
    const total = fichiers.length;

    fichiers.forEach((src) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => {
        charges++;
        if (charges === total) {
          // Tous les fichiers sont chargés — fusionner les catalogues
          BANQUE_SONS_CATALOGUE = [
            ...(typeof BANQUE_SONS_JINGLE   !== 'undefined' ? BANQUE_SONS_JINGLE   : []),
            ...(typeof BANQUE_SONS_AMBIANCE !== 'undefined' ? BANQUE_SONS_AMBIANCE : []),
            ...(typeof BANQUE_SONS_BRUITAGE !== 'undefined' ? BANQUE_SONS_BRUITAGE : []),
          ];
          _banqueChargee = true;
          _chargementEnCours = null;
          resolve();
        }
      };
      script.onerror = () => {
        // Fichier absent (normal si aucun son dans cette catégorie)
        charges++;
        if (charges === total) {
          BANQUE_SONS_CATALOGUE = [
            ...(typeof BANQUE_SONS_JINGLE   !== 'undefined' ? BANQUE_SONS_JINGLE   : []),
            ...(typeof BANQUE_SONS_AMBIANCE !== 'undefined' ? BANQUE_SONS_AMBIANCE : []),
            ...(typeof BANQUE_SONS_BRUITAGE !== 'undefined' ? BANQUE_SONS_BRUITAGE : []),
          ];
          _banqueChargee = true;
          _chargementEnCours = null;
          resolve();
        }
      };
      document.head.appendChild(script);
    });
  });

  return _chargementEnCours;
}
