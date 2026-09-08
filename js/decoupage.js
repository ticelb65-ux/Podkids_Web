/* ===================================================================
   decoupage.js
   Modale de decoupage audio. Deux operations possibles :
   1. Rogner : deplacer les poignees verte (debut) et rouge (fin)
      pour retirer du silence ou du contenu inutile aux extremites.
   2. Couper au milieu : cliquer sur la forme d'onde a un endroit
      precis place un repere ; valider separe alors le clip en DEUX
      clips independants, l'un avant et l'un apres le repere, que
      l'eleve peut ensuite deplacer ou supprimer separement.
   =================================================================== */

const Decoupage = (() => {

  let resoudrePromesse = null;
  let audioBufferActuel = null;
  let pointDeCoupeActuel = null; // en secondes, ou null si pas de coupe demandee
  let debutRognage = 0;
  let finRognage = 0;
  let dureeAudioTotale = 0;
  let sourceLectureEnCours = null;
  let animationEnCours = null;
  let offsetProjetActuel = 0; // position du debut du clip dans le projet (secondes)

  const modale = document.getElementById('modale-decoupage');
  const canvas = document.getElementById('canvas-forme-onde');
  const conteneurOnde = document.querySelector('.editeur-forme-onde-conteneur');
  const poigneeDebut = document.getElementById('poignee-debut');
  const poigneeFin = document.getElementById('poignee-fin');
  const curseurLecture = document.getElementById('curseur-lecture-decoupage');
  const btnJouer = document.getElementById('btn-jouer-decoupage');
  const btnCouperIci = document.getElementById('btn-couper-ici');
  const btnAnnuler = document.getElementById('btn-annuler-decoupage');
  const btnValider = document.getElementById('btn-valider-decoupage');
  const btnFermer = document.getElementById('btn-fermer-decoupage');
  const positionValeurDom = document.getElementById('position-decoupage-valeur');

  /** Formate une duree en secondes vers "m:ss.mmm" (minutes, secondes, millisecondes). */
  function formaterPositionAbsolue(secondes) {
    const total = Math.max(0, secondes);
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    const ms = Math.round((total - Math.floor(total)) * 1000);
    return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  /** Met a jour l'affichage textuel de la position absolue dans le projet. */
  function rafraichirAffichagePosition() {
    if (!positionValeurDom) return;
    const positionAbsolue = offsetProjetActuel + positionCurseurLecture;
    positionValeurDom.textContent = formaterPositionAbsolue(positionAbsolue);
  }

  function tempsVersPixels(t) {
    const largeur = conteneurOnde.clientWidth;
    return (t / dureeAudioTotale) * largeur;
  }
  function pixelsVersTemps(x) {
    const largeur = conteneurOnde.clientWidth;
    return Math.max(0, Math.min(dureeAudioTotale, (x / largeur) * dureeAudioTotale));
  }

  function rafraichirAffichagePoignees() {
    poigneeDebut.style.left = tempsVersPixels(debutRognage) + 'px';
    poigneeFin.style.left = (tempsVersPixels(finRognage) - 18) + 'px';
  }

  function rafraichirAffichageCoupe() {
    if (pointDeCoupeActuel === null) {
      curseurLecture.style.background = 'var(--texte-principal)';
      return;
    }
    curseurLecture.style.left = tempsVersPixels(pointDeCoupeActuel) + 'px';
    curseurLecture.style.background = '#E0A23C';
    curseurLecture.style.width = '3px';
  }

  function dessinerOnde() {
    const points = FormeOnde.calculerPoints(audioBufferActuel, 200);
    FormeOnde.dessiner(canvas, points, { couleur: '#C9C2B4', fond: '#FFF8EF' });
    appliquerVoileCoupe();
  }

  /**
   * Affiche un calque semi-transparent colore separant visuellement
   * les deux futurs morceaux quand un point de coupe est pose, pour que
   * la confirmation visuelle de la decoupe soit immediate.
   */
  function appliquerVoileCoupe() {
    let voileGauche = conteneurOnde.querySelector('.voile-coupe-gauche');
    let voileDroit = conteneurOnde.querySelector('.voile-coupe-droite');

    if (pointDeCoupeActuel === null) {
      if (voileGauche) voileGauche.remove();
      if (voileDroit) voileDroit.remove();
      return;
    }

    if (!voileGauche) {
      voileGauche = document.createElement('div');
      voileGauche.className = 'voile-coupe-gauche';
      conteneurOnde.appendChild(voileGauche);
    }
    if (!voileDroit) {
      voileDroit = document.createElement('div');
      voileDroit.className = 'voile-coupe-droite';
      conteneurOnde.appendChild(voileDroit);
    }

    const xCoupe = tempsVersPixels(pointDeCoupeActuel);
    voileGauche.style.left = '0px';
    voileGauche.style.width = xCoupe + 'px';
    voileDroit.style.left = xCoupe + 'px';
    voileDroit.style.width = (conteneurOnde.clientWidth - xCoupe) + 'px';
  }

  // position actuelle du curseur de lecture/reperage (en secondes), independante
  // du point de coupe : permet d'ecouter precisement avant de decider ou couper
  let positionCurseurLecture = 0;

  // Memorise la position d'edition juste avant une ecoute de verification,
  // pour pouvoir la restaurer exactement a l'arret de la lecture (naturel
  // ou manuel), sans que le defilement de la tete de lecture ne l'ecrase.
  let positionCurseurAvantEcoute = null;

  function arreterLecturePreview() {
    if (sourceLectureEnCours) {
      try { sourceLectureEnCours.stop(); } catch (e) { /* deja arretee */ }
      sourceLectureEnCours = null;
    }
    if (animationEnCours) {
      cancelAnimationFrame(animationEnCours);
      animationEnCours = null;
    }
    btnJouer.textContent = '▶️ Écouter';

    // Restaure le curseur d'edition a sa position d'avant ecoute, que la
    // lecture ait ete stoppee manuellement ou soit allee a son terme.
    if (positionCurseurAvantEcoute !== null) {
      positionCurseurLecture = positionCurseurAvantEcoute;
      positionCurseurAvantEcoute = null;
      curseurLecture.style.left = tempsVersPixels(positionCurseurLecture) + 'px';
      curseurLecture.style.background = 'var(--texte-principal)';
      curseurLecture.style.width = '2px';
      rafraichirAffichagePosition();
    }
  }

  function jouerPreview() {
    // On memorise la position d'edition AVANT tout arret/relance, puis on
    // la refixe juste apres arreterLecturePreview() (qui peut l'avoir
    // consommee/remise a null si une lecture precedente etait en cours).
    const positionEditionDeDepart = positionCurseurLecture;
    arreterLecturePreview();
    positionCurseurAvantEcoute = positionEditionDeDepart;

    const ctx = AudioMoteur.obtenirContexte();
    const source = ctx.createBufferSource();
    source.buffer = audioBufferActuel;
    source.connect(ctx.destination);
    // on demarre depuis la position actuelle du curseur, pas forcement depuis le debut
    const pointDeDepart = Math.max(debutRognage, Math.min(positionEditionDeDepart, finRognage));
    const dureeAJouer = finRognage - pointDeDepart;
    if (dureeAJouer <= 0) {
      positionCurseurAvantEcoute = null;
      return;
    }
    source.start(0, pointDeDepart, dureeAJouer);
    sourceLectureEnCours = source;
    btnJouer.textContent = '⏹️ Arrêter';

    const tempsDebutLecture = ctx.currentTime;
    function animer() {
      const ecoule = ctx.currentTime - tempsDebutLecture;
      const positionActuelle = pointDeDepart + ecoule;
      if (positionActuelle >= finRognage) {
        // Fin naturelle de la lecture : on restaure le curseur d'edition
        // via arreterLecturePreview(), qui gere aussi le cas manuel.
        arreterLecturePreview();
        return;
      }
      // Affichage purement visuel de la tete de lecture : on ne touche ni
      // a positionCurseurLecture ni a positionCurseurAvantEcoute, qui
      // restent le point d'edition a restaurer a l'arret.
      curseurLecture.style.left = tempsVersPixels(positionActuelle) + 'px';
      curseurLecture.style.background = 'var(--texte-principal)';
      curseurLecture.style.width = '2px';
      if (positionValeurDom) {
        positionValeurDom.textContent = formaterPositionAbsolue(offsetProjetActuel + positionActuelle);
      }
      animationEnCours = requestAnimationFrame(animer);
    }
    animationEnCours = requestAnimationFrame(animer);

    source.onended = () => { sourceLectureEnCours = null; };
  }

  /** Bascule entre demarrer et arreter la lecture (utilise par le bouton Ecouter). */
  function basculerLecturePreview() {
    if (sourceLectureEnCours) {
      arreterLecturePreview();
    } else {
      jouerPreview();
    }
  }

  /** Deplace le curseur de lecture/reperage a une position donnee (en secondes), avec bornes. */
  function deplacerCurseurLecture(nouvellePosition) {
    arreterLecturePreview();
    positionCurseurLecture = Math.max(debutRognage, Math.min(nouvellePosition, finRognage));
    curseurLecture.style.left = tempsVersPixels(positionCurseurLecture) + 'px';
    curseurLecture.style.background = 'var(--texte-principal)';
    curseurLecture.style.width = '2px';
    rafraichirAffichagePosition();
  }

  function gererClicSurOnde(evenement) {
    if (evenement.target === poigneeDebut || evenement.target === poigneeFin) return;
    const rect = conteneurOnde.getBoundingClientRect();
    const x = evenement.clientX - rect.left;
    const temps = pixelsVersTemps(x);
    deplacerCurseurLecture(temps);
  }

  // Navigation au clavier : fleches gauche/droite pour un positionnement fin
  // du curseur (Maj+fleche pour des pas plus grands).
  const PAS_CLAVIER_FIN = 0.05; // 50 millisecondes : ajustement tres precis
  const PAS_CLAVIER_LARGE = 0.5; // 500 millisecondes, avec Maj : deplacement plus rapide

  function gererClavier(evenement) {
    if (modale.hidden) return;
    if (evenement.target === elementEditionNomEnCours()) return; // ne pas interferer avec une saisie de texte
    if (evenement.key === 'ArrowLeft') {
      evenement.preventDefault();
      const pas = evenement.shiftKey ? PAS_CLAVIER_LARGE : PAS_CLAVIER_FIN;
      deplacerCurseurLecture(positionCurseurLecture - pas);
    } else if (evenement.key === 'ArrowRight') {
      evenement.preventDefault();
      const pas = evenement.shiftKey ? PAS_CLAVIER_LARGE : PAS_CLAVIER_FIN;
      deplacerCurseurLecture(positionCurseurLecture + pas);
    } else if (evenement.key === ' ') {
      // barre espace : jouer/arreter, pratique au clavier
      evenement.preventDefault();
      basculerLecturePreview();
    }
  }

  function elementEditionNomEnCours() {
    return document.activeElement && document.activeElement.classList.contains('clip-nom-edition')
      ? document.activeElement
      : null;
  }

  document.addEventListener('keydown', gererClavier);

  /** Pose (ou retire) le point de coupe a la position actuelle du curseur de lecture. */
  function gererMarquerCoupureIci() {
    if (pointDeCoupeActuel !== null) {
      // une coupure est deja posee : ce bouton l'annule
      pointDeCoupeActuel = null;
      rafraichirAffichageCoupe();
      appliquerVoileCoupe();
      btnCouperIci.disabled = true;
      btnCouperIci.textContent = '📍 Marquer la coupure ici';
      btnCouperIci.classList.remove('coupe-active');
      mettreAJourTexteValider();
      return;
    }
    if (positionCurseurLecture <= debutRognage + 0.05 || positionCurseurLecture >= finRognage - 0.05) {
      return; // trop proche du debut/de la fin pour une coupure utile
    }
    pointDeCoupeActuel = positionCurseurLecture;
    rafraichirAffichageCoupe();
    appliquerVoileCoupe();
    btnCouperIci.textContent = '↩️ Annuler la coupure';
    btnCouperIci.classList.add('coupe-active');
    mettreAJourTexteValider();
  }

  function initialiserGlisserPoignee(poignee, estDebut) {
    let enGlissement = false;

    function demarrer(e) {
      enGlissement = true;
      e.preventDefault();
    }
    function deplacer(e) {
      if (!enGlissement) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const rect = conteneurOnde.getBoundingClientRect();
      const temps = pixelsVersTemps(clientX - rect.left);
      if (estDebut) {
        debutRognage = Math.max(0, Math.min(temps, finRognage - 0.1));
      } else {
        finRognage = Math.min(dureeAudioTotale, Math.max(temps, debutRognage + 0.1));
      }
      rafraichirAffichagePoignees();
    }
    function arreter() { enGlissement = false; }

    poignee.addEventListener('mousedown', demarrer);
    poignee.addEventListener('touchstart', demarrer, { passive: false });
    window.addEventListener('mousemove', deplacer);
    window.addEventListener('touchmove', deplacer, { passive: false });
    window.addEventListener('mouseup', arreter);
    window.addEventListener('touchend', arreter);
  }

  initialiserGlisserPoignee(poigneeDebut, true);
  initialiserGlisserPoignee(poigneeFin, false);
  conteneurOnde.addEventListener('click', gererClicSurOnde);

  btnJouer.addEventListener('click', basculerLecturePreview);
  btnCouperIci.addEventListener('click', gererMarquerCoupureIci);

  function mettreAJourTexteValider() {
    btnValider.textContent = pointDeCoupeActuel !== null
      ? '✅ Couper en 2 et valider'
      : '✅ Valider';
  }

  btnAnnuler.addEventListener('click', () => fermer(null));
  btnFermer.addEventListener('click', () => fermer(null));
  btnValider.addEventListener('click', () => {
    arreterLecturePreview();
    fermer({
      debutRognage,
      finRognage,
      pointDeCoupe: pointDeCoupeActuel,
    });
  });

  function fermer(resultat) {
    arreterLecturePreview();
    modale.hidden = true;
    if (resoudrePromesse) {
      resoudrePromesse(resultat);
      resoudrePromesse = null;
    }
  }

  /**
   * Ouvre la modale de decoupage pour un AudioBuffer donne.
   * offsetProjet : position (en secondes) du debut du clip dans le projet,
   * utilisee pour afficher la position absolue du curseur (min:s.ms).
   * Retourne une Promise qui se resout avec :
   *  - null si l'utilisateur annule
   *  - { debutRognage, finRognage, pointDeCoupe } sinon
   */
  function ouvrir(audioBuffer, offsetProjet = 0) {
    audioBufferActuel = audioBuffer;
    dureeAudioTotale = audioBuffer.duration;
    debutRognage = 0;
    finRognage = dureeAudioTotale;
    pointDeCoupeActuel = null;
    positionCurseurLecture = 0;
    positionCurseurAvantEcoute = null;
    offsetProjetActuel = offsetProjet;
    btnCouperIci.disabled = false;
    btnCouperIci.textContent = '📍 Marquer la coupure ici';
    btnCouperIci.classList.remove('coupe-active');
    mettreAJourTexteValider();
    rafraichirAffichagePosition();

    modale.hidden = false;
    // on attend que la modale soit affichee (donc avec une largeur reelle)
    // avant de dessiner, l'aire de dessin ayant une largeur de 0 sinon
    requestAnimationFrame(() => {
      dessinerOnde();
      rafraichirAffichagePoignees();
      curseurLecture.style.left = '0px';
    });

    return new Promise((resolve) => {
      resoudrePromesse = resolve;
    });
  }

  return { ouvrir };
})();