/* ===================================================================
   forme-onde.js
   Calcule une version "miniature" de la forme d'onde d'un AudioBuffer
   (tableau de valeurs 0-1) et sait la dessiner sur un canvas.
   Utilise a la fois pour les petits clips dans les pistes et pour
   le grand editeur de decoupage.
   =================================================================== */

const FormeOnde = (() => {

  /** Calcule nbPoints valeurs representant l'amplitude moyenne du son. */
  function calculerPoints(audioBuffer, nbPoints) {
    const canal = audioBuffer.getChannelData(0);
    const tailleBloc = Math.max(1, Math.floor(canal.length / nbPoints));
    const points = new Array(nbPoints).fill(0);

    for (let i = 0; i < nbPoints; i++) {
      const debut = i * tailleBloc;
      const fin = Math.min(canal.length, debut + tailleBloc);
      let somme = 0;
      let compte = 0;
      for (let j = debut; j < fin; j++) {
        somme += Math.abs(canal[j]);
        compte++;
      }
      points[i] = compte > 0 ? somme / compte : 0;
    }

    // normalisation : on etire pour que le point le plus fort touche 1
    const maxValeur = Math.max(...points, 0.001);
    return points.map(v => Math.min(1, v / maxValeur));
  }

  /** Dessine les points sous forme de petites barres verticales, centrees verticalement. */
  function dessiner(canvas, points, options = {}) {
    const ctx = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    const largeurAffichee = canvas.clientWidth || canvas.width;
    const hauteurAffichee = canvas.clientHeight || canvas.height;
    canvas.width = largeurAffichee * ratio;
    canvas.height = hauteurAffichee * ratio;
    ctx.scale(ratio, ratio);

    const couleur = options.couleur || '#4A90D9';
    const fond = options.fond || null;

    if (fond) {
      ctx.fillStyle = fond;
      ctx.fillRect(0, 0, largeurAffichee, hauteurAffichee);
    } else {
      ctx.clearRect(0, 0, largeurAffichee, hauteurAffichee);
    }

    if (!points || points.length === 0) return;

    const largeurBarre = largeurAffichee / points.length;
    ctx.fillStyle = couleur;

    for (let i = 0; i < points.length; i++) {
      const hauteurBarre = Math.max(2, points[i] * hauteurAffichee * 0.9);
      const x = i * largeurBarre;
      const y = (hauteurAffichee - hauteurBarre) / 2;
      ctx.fillRect(x, y, Math.max(1, largeurBarre - 1), hauteurBarre);
    }
  }

  return { calculerPoints, dessiner };
})();
