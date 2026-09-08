/* ===================================================================
   pistes-ui.js
   Construit et gere l'interface des pistes : affichage des clips,
   glisser-deposer (avec effet aimant pour aligner bout a bout),
   reordonnement, boutons de controle (jouer, reglages, supprimer),
   ajout de pistes (max 4), zoom horizontal.
   Le state reel (donnees) est dans App (app.js) ; ce module se charge
   uniquement du rendu et des interactions, et appelle des callbacks
   fournis par App pour modifier l'etat.
   =================================================================== */

const PistesUI = (() => {

  const NB_PISTES_MAX = 6;
  const NIVEAUX_ZOOM = [15, 25, 40, 60, 90, 130]; // pixels par seconde
  const INDEX_ZOOM_DEFAUT = 2;
  const TOLERANCE_AIMANT_PX = 12; // distance en-dessous de laquelle un clip "s'accroche"
  const LARGEUR_MIN_CLIP_PX = 56; // largeur visuelle minimale : poignee actions (18px fixe) + un peu de nom lisible

  let indexZoomActuel = INDEX_ZOOM_DEFAUT;

  const TYPES_PISTE = {
    voix: { icone: '🎤', label: 'voix' },
    ambiance: { icone: '🌬️', label: 'Tapis' },
    jingle: { icone: '🔔', label: 'jingle' },
    bruitage: { icone: '🔊', label: 'bruitage' },
  };

  const zonePistes = document.getElementById('zone-pistes');
  const btnAjouterPiste = document.getElementById('btn-ajouter-piste');
  const btnZoomPlus = document.getElementById('btn-zoom-plus');
  const btnZoomMoins = document.getElementById('btn-zoom-moins');
  const regleTempsDom = document.getElementById('regle-temps');
  const regleConteneurDom = document.getElementById('regle-temps-conteneur');
  const colonneScrollDom = document.getElementById('colonne-clips-scroll');

  let callbacks = {};
  let idClipNouveau = null;
  // Playhead : ligne verticale qui traverse toutes les pistes
  let elPlayhead = null;
  // Largeur max des conteneurs intérieurs (pour dimensionner la règle)
  let largeurZoneClips = 600;

  function pixelsParSeconde() {
    return NIVEAUX_ZOOM[indexZoomActuel];
  }

  /**
   * Duree (en secondes) en-dessous de laquelle un clip est affiche plus
   * large que sa duree reelle ne le justifie (pour rester lisible).
   * App.js s'en sert pour que le placement "bout a bout" automatique
   * laisse un espace visuel coherent, sans faire chevaucher deux clips
   * tres courts places l'un apres l'autre.
   */
  function dureeMinimaleAffichable() {
    return LARGEUR_MIN_CLIP_PX / pixelsParSeconde();
  }

  function initialiser(cb) {
    callbacks = cb;
    btnAjouterPiste.addEventListener('click', () => callbacks.onAjouterPiste());
    btnZoomPlus.addEventListener('click', () => changerZoom(1));
    btnZoomMoins.addEventListener('click', () => changerZoom(-1));
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.piste-etiquette')) {
        document.querySelectorAll('.menu-type-piste').forEach(m => { m.hidden = true; });
      }
    });

    // Synchroniser le scroll VERTICAL entre colonne gauche et colonne droite.
    // La scrollbar visible est sur la colonne gauche ; la colonne droite suit.
    // Et inversement si l'utilisateur utilise la molette sur la colonne droite.
    if (colonneScrollDom && zonePistes) {
      let syncing = false;
      zonePistes.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        colonneScrollDom.scrollTop = zonePistes.scrollTop;
        syncing = false;
      });
      colonneScrollDom.addEventListener('scroll', () => {
        if (syncing) return;
        syncing = true;
        zonePistes.scrollTop = colonneScrollDom.scrollTop;
        syncing = false;
      });
    }

    // Créer le playhead (ligne verticale de lecture)
    elPlayhead = document.createElement('div');
    elPlayhead.id = 'playhead';
    elPlayhead.style.cssText = [
      'position:absolute',
      'top:0',
      'left:0',
      'width:2px',
      'bottom:0',
      'background:var(--rouge)',
      'pointer-events:none',
      'z-index:20',
      'display:none',
      'border-radius:1px',
    ].join(';');
    zonePistes.style.position = 'relative';
    zonePistes.appendChild(elPlayhead);

    // --- Clic et drag pour positionner la tête de lecture ---
    function positionDepuisEvenement(e, conteneurClips) {
      const rect = conteneurClips.getBoundingClientRect();
      const x = Math.max(0, (e.clientX || (e.touches && e.touches[0].clientX) || 0) - rect.left);
      return x / pixelsParSeconde();
    }

    // Seuil de magnétisme : 8px en pixels → converti en secondes selon zoom
    const SEUIL_MAGNETISME_PX = 12;

    /**
     * Si posSecondes est proche d'un début ou d'une fin de clip (toutes pistes),
     * retourne la position aimantée. Sinon retourne posSecondes inchangée.
     */
    function appliquerMagnetisme(posSecondes) {
      const pps = pixelsParSeconde();
      const seuilSecondes = SEUIL_MAGNETISME_PX / pps;
      let meilleureDistance = seuilSecondes;
      let posAimantee = posSecondes;

      // Collecter tous les points d'ancrage (début et fin de chaque clip)
      const wrapperM = colonneScrollDom
        ? colonneScrollDom.querySelector('.wrapper-clips-interne')
        : null;
      const rangees = (wrapperM || colonneScrollDom || document)
        .querySelectorAll('.piste-clips-rangee');
      rangees.forEach(rangee => {
        const indexPiste = parseInt(rangee.dataset.indexPiste);
        rangee.querySelectorAll('.clip-audio').forEach(elClip => {
          const left = parseFloat(elClip.style.left) / pps;
          const width = parseFloat(elClip.style.width) / pps;
          const fin = left + width;
          for (const ancre of [left, fin]) {
            const dist = Math.abs(posSecondes - ancre);
            if (dist < meilleureDistance) {
              meilleureDistance = dist;
              posAimantee = ancre;
            }
          }
        });
      });

      // Afficher/masquer le repère visuel de magnétisme
      afficherRepereAimant(posAimantee !== posSecondes ? posAimantee : null);
      return posAimantee;
    }

    let elRepereAimant = null;
    function afficherRepereAimant(posSecondes) {
      const wrapper = colonneScrollDom
        ? colonneScrollDom.querySelector('.wrapper-clips-interne')
        : null;
      if (!wrapper) return;
      if (!elRepereAimant || elRepereAimant.parentNode !== wrapper) {
        elRepereAimant = document.createElement('div');
        elRepereAimant.className = 'repere-aimant-curseur';
        wrapper.appendChild(elRepereAimant);
      }
      if (posSecondes === null) {
        elRepereAimant.style.display = 'none';
      } else {
        const x = posSecondes * pixelsParSeconde();
        elRepereAimant.style.display = 'block';
        elRepereAimant.style.left = x + 'px';
      }
    }

    function demarrerNavigationLecture(e) {
      e.preventDefault();
      const clientX0 = e.clientX ?? (e.touches && e.touches[0].clientX);
      if (clientX0 === undefined) return;
      if (!colonneScrollDom) return;

      function calculerPosition(clientX) {
        // colonneScrollDom est le référentiel visuel stable :
        // son rect.left ne change pas quand on scrolle.
        // On ajoute scrollLeft pour convertir en coordonnée absolue dans le contenu.
        const r = colonneScrollDom.getBoundingClientRect();
        const scrollActuel = colonneScrollDom.scrollLeft;
        const x = Math.max(0, (clientX - r.left) + scrollActuel);
        const posSecondes = x / pixelsParSeconde();
        return appliquerMagnetisme(posSecondes);
      }

      const pos0 = calculerPosition(clientX0);
      callbacks.onSeekLecture && callbacks.onSeekLecture(pos0);
      mettreAJourPlayhead(pos0, callbacks.onObtenirDuree ? callbacks.onObtenirDuree() : 9999);

      function onMove(ev) {
        const cx = ev.clientX ?? (ev.touches && ev.touches[0].clientX);
        if (cx === undefined) return;
        const pos = calculerPosition(cx);
        callbacks.onSeekLecture && callbacks.onSeekLecture(pos);
        mettreAJourPlayhead(pos, callbacks.onObtenirDuree ? callbacks.onObtenirDuree() : 9999);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        afficherRepereAimant(null);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
    }

    // Clic/drag sur la colonne scrollable : règle temporelle ET fond des pistes
    if (colonneScrollDom) {
      colonneScrollDom.addEventListener('mousedown', (e) => {
        const surRegle      = !!e.target.closest('.regle-temps');
        const surFondPiste  = (!!e.target.closest('.piste-pose-conteneur') ||
                               !!e.target.closest('.piste-pose-interieur')) &&
                              !e.target.closest('.clip-audio');
        if (!surRegle && !surFondPiste) return;
        demarrerNavigationLecture(e);
      });
      colonneScrollDom.addEventListener('touchstart', (e) => {
        const surRegle      = !!e.target.closest('.regle-temps');
        const surFondPiste  = (!!e.target.closest('.piste-pose-conteneur') ||
                               !!e.target.closest('.piste-pose-interieur')) &&
                              !e.target.closest('.clip-audio');
        if (!surRegle && !surFondPiste) return;
        demarrerNavigationLecture(e);
      }, { passive: false });
    }
  }

  function changerZoom(direction) {
    const nouvelIndex = indexZoomActuel + direction;
    if (nouvelIndex < 0 || nouvelIndex >= NIVEAUX_ZOOM.length) return;
    indexZoomActuel = nouvelIndex;
    callbacks.onZoomChange && callbacks.onZoomChange();
  }

  function formaterDuree(secondes) {
    const m = Math.floor(secondes / 60);
    const s = Math.floor(secondes % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  /** Marque un clip comme "nouveau" pour qu'il soit mis en evidence au prochain rendu. */
  function signalerClipNouveau(indexPiste, indexClip) {
    idClipNouveau = indexPiste + '_' + indexClip;
  }

  /** Reconstruit entierement l'affichage des pistes depuis l'etat fourni. */
  function rafraichir(pistes) {
    // Mémoriser la position de scroll horizontal pour la restaurer après
    // reconstruction du DOM (sinon le déplacement d'un clip ramène la vue
    // tout au début du podcast).
    const scrollAvant = colonneScrollDom ? colonneScrollDom.scrollLeft : 0;

    // Vider la colonne gauche
    zonePistes.innerHTML = '';
    // Vider colonneScrollDom entièrement
    if (colonneScrollDom) colonneScrollDom.innerHTML = '';

    // Calculer la largeur max (durée totale + marge)
    const pps = pixelsParSeconde();
    let largeurMax = Math.max(
      colonneScrollDom ? colonneScrollDom.clientWidth : 600, 600);
    pistes.forEach(piste => {
      piste.clips.forEach(clip => {
        const fin = (clip.debutDansPiste +
          ((clip.decoupeFin ?? clip.dureeOriginale) - (clip.decoupeDebut || 0))) * pps;
        if (fin + 120 > largeurMax) largeurMax = fin + 120;
      });
    });
    largeurZoneClips = largeurMax;

    // Wrapper interne position:relative — tout défile ensemble dedans
    const wrapper = document.createElement('div');
    wrapper.className = 'wrapper-clips-interne';
    wrapper.style.cssText = [
      'position:relative',
      `width:${largeurMax}px`,
      'min-height:100%',
      'display:flex',
      'flex-direction:column',
      'gap:6px',
    ].join(';');

    // Règle temporelle en tête
    construireRegle(largeurMax);
    wrapper.appendChild(regleTempsDom);

    // Pistes
    pistes.forEach((piste, indexPiste) => {
      const { elGauche, elClips } = creerElementPiste(piste, indexPiste);
      zonePistes.appendChild(elGauche);
      wrapper.appendChild(elClips);
    });

    // Playhead dans le wrapper (suit le scroll)
    if (elPlayhead) wrapper.appendChild(elPlayhead);

    if (colonneScrollDom) colonneScrollDom.appendChild(wrapper);

    // Restaurer la position de scroll horizontal (clampée à la nouvelle largeur)
    if (colonneScrollDom) colonneScrollDom.scrollLeft = scrollAvant;

    btnAjouterPiste.hidden = pistes.length >= NB_PISTES_MAX;
    idClipNouveau = null;
  }

  /** Construit la règle graduée en secondes au-dessus des zones de clips. */
  function construireRegle(largeurPx) {
    if (!regleTempsDom) return;
    const pps = pixelsParSeconde();
    // Choisir le pas de graduation selon le zoom
    let pasSecondes;
    if (pps >= 90) pasSecondes = 1;
    else if (pps >= 40) pasSecondes = 2;
    else if (pps >= 25) pasSecondes = 5;
    else pasSecondes = 10;

    const dureeTotaleAff = largeurPx / pps;
    const nbMarques = Math.ceil(dureeTotaleAff / pasSecondes) + 1;

    regleTempsDom.innerHTML = '';
    regleTempsDom.style.width = largeurPx + 'px';
    regleTempsDom.style.position = 'relative';
    regleTempsDom.style.height = '28px';
    regleTempsDom.style.flexShrink = '0';

    for (let i = 0; i < nbMarques; i++) {
      const t = i * pasSecondes;
      const x = t * pps;
      if (x > largeurPx + 10) break;

      const marque = document.createElement('div');
      marque.style.cssText = `position:absolute;left:${x}px;top:0;display:flex;flex-direction:column;align-items:flex-start;`;

      const tick = document.createElement('div');
      tick.style.cssText = 'width:1px;height:6px;background:var(--texte-secondaire);opacity:.4;';
      marque.appendChild(tick);

      if (i > 0 || true) {
        const label = document.createElement('span');
        label.textContent = formaterDureeRegle(t);
        label.style.cssText = 'font-size:10px;color:var(--texte-secondaire);white-space:nowrap;transform:translateX(-50%);margin-top:2px;user-select:none;';
        marque.appendChild(label);
      }
      regleTempsDom.appendChild(marque);
    }
  }

  function formaterDureeRegle(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    if (m === 0) return sec + 's';
    return m + ':' + String(sec).padStart(2, '0');
  }

  function creerElementPiste(piste, indexPiste) {
    const infoType = TYPES_PISTE[piste.type] || TYPES_PISTE.voix;
    const pps = pixelsParSeconde();
    const estMuette = !!piste.muette;

    // ── Colonne gauche : étiquette + contrôles ───────────────
    const elGauche = document.createElement('div');
    elGauche.className = `piste-gauche type-${piste.type}`;
    elGauche.dataset.indexPiste = indexPiste;
    elGauche.innerHTML = `
      <div class="piste-etiquette">
        <button class="piste-etiquette-rond bouton-type-piste" title="Changer le type de piste">${infoType.icone}</button>
        <span class="piste-etiquette-texte">${infoType.label}</span>
        <div class="menu-type-piste" hidden>
          ${Object.entries(TYPES_PISTE).map(([cle, info]) => `
            <button class="option-type-piste" data-type="${cle}">${info.icone} ${info.label}</button>
          `).join('')}
        </div>
      </div>
      <div class="piste-controles">
        <button class="piste-bouton-controle bouton-muet-piste ${estMuette ? 'actif' : ''}" title="${estMuette ? 'Rétablir le son' : 'Rendre muette'}">${estMuette ? '🔇' : '🔊'}</button>
        <button class="piste-bouton-controle bouton-reglages-piste" title="Volume et panoramique de la piste">🎚️</button>
        <button class="piste-bouton-controle bouton-monter-piste" title="Déplacer la piste vers le haut">▲</button>
        <button class="piste-bouton-controle bouton-descendre-piste" title="Déplacer la piste vers le bas">▼</button>
        <button class="piste-bouton-controle bouton-supprimer-piste" title="Supprimer cette piste">🗑️</button>
      </div>
    `;

    // ── Colonne droite : zone de clips ───────────────────────
    const elClips = document.createElement('div');
    elClips.className = `piste-clips-rangee type-${piste.type}`;
    elClips.dataset.indexPiste = indexPiste;

    const conteneurPose = document.createElement('div');
    conteneurPose.className = 'piste-pose-conteneur';
    conteneurPose.dataset.indexPiste = indexPiste;

    const conteneurInterieur = document.createElement('div');
    conteneurInterieur.className = 'piste-pose-interieur';
    conteneurInterieur.style.width = largeurZoneClips + 'px';

    piste.clips.forEach((clip, indexClip) => {
      conteneurInterieur.appendChild(creerElementClip(clip, indexPiste, indexClip, piste));
    });

    conteneurPose.appendChild(conteneurInterieur);
    elClips.appendChild(conteneurPose);

    initialiserDepotSurPiste(conteneurPose, conteneurInterieur, indexPiste);

    // ── Événements colonne gauche ────────────────────────────
    elGauche.querySelector('.bouton-supprimer-piste').addEventListener('click', () => {
      callbacks.onDemanderSupprimerPiste(indexPiste);
    });
    elGauche.querySelector('.bouton-monter-piste').addEventListener('click', () => {
      callbacks.onDeplacerPiste && callbacks.onDeplacerPiste(indexPiste, indexPiste - 1);
    });
    elGauche.querySelector('.bouton-descendre-piste').addEventListener('click', () => {
      callbacks.onDeplacerPiste && callbacks.onDeplacerPiste(indexPiste, indexPiste + 1);
    });
    elGauche.querySelector('.bouton-reglages-piste').addEventListener('click', () => {
      callbacks.onOuvrirReglagesPiste(indexPiste);
    });
    elGauche.querySelector('.bouton-muet-piste').addEventListener('click', () => {
      callbacks.onBasculerMuetPiste(indexPiste);
    });

    const btnTypePiste = elGauche.querySelector('.bouton-type-piste');
    const menuTypePiste = elGauche.querySelector('.menu-type-piste');
    btnTypePiste.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.menu-type-piste').forEach(m => {
        if (m !== menuTypePiste) m.hidden = true;
      });
      const ouvert = !menuTypePiste.hidden;
      menuTypePiste.hidden = ouvert;
      if (!ouvert) {
        // Positionner en fixed sous le bouton
        const rect = btnTypePiste.getBoundingClientRect();
        menuTypePiste.style.top  = (rect.bottom + 4) + 'px';
        menuTypePiste.style.left = rect.left + 'px';
      }
    });
    menuTypePiste.querySelectorAll('.option-type-piste').forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        menuTypePiste.hidden = true;
        callbacks.onChangerTypePiste(indexPiste, option.dataset.type);
      });
    });

    return { elGauche, elClips };
  }

  function creerElementClip(clip, indexPiste, indexClip, piste) {
    const pps = pixelsParSeconde();
    const elClip = document.createElement('div');
    elClip.className = 'clip-audio';
    elClip.style.left = (clip.debutDansPiste * pps) + 'px';
    const dureeClip = (clip.decoupeFin ?? clip.dureeOriginale) - (clip.decoupeDebut || 0);
    elClip.style.width = Math.max(LARGEUR_MIN_CLIP_PX, dureeClip * pps) + 'px';
    elClip.dataset.indexPiste = indexPiste;
    elClip.dataset.indexClip = indexClip;

    if (idClipNouveau === (indexPiste + '_' + indexClip)) {
      elClip.classList.add('clip-nouveau');
    }

    elClip.innerHTML = `
      <canvas class="clip-mini-onde"></canvas>
      <div class="clip-nom-conteneur">
        <span class="clip-nom" title="Clique pour renommer">${echapperHtml(clip.nom)}</span>
        <input type="text" class="clip-nom-edition" value="${echapperHtml(clip.nom)}" hidden maxlength="40">
      </div>
      <button class="clip-poignee-actions" title="Voir les actions">⋯</button>
      <div class="clip-boutons-action">
        <button class="clip-bouton-action bouton-jouer-clip" title="Écouter ce son">▶️</button>
        <button class="clip-bouton-action bouton-decouper-clip" title="Découper ce son">✂️</button>
        <button class="clip-bouton-action bouton-reglages-clip" title="Volume de ce son">🎚️</button>
        <button class="clip-bouton-action bouton-dupliquer-clip" title="Dupliquer ce son">📋</button>
        <button class="clip-bouton-action bouton-supprimer-clip" title="Supprimer ce son">🗑️</button>
        <button class="clip-bouton-action bouton-fermer-actions-clip" title="Fermer">✖️</button>
      </div>
    `;

    // dessin differe de la mini forme d'onde (apres insertion dans le DOM, pour avoir une largeur)
    if (clip.audioBuffer) {
      requestAnimationFrame(() => {
        const canvas = elClip.querySelector('.clip-mini-onde');
        const points = FormeOnde.calculerPoints(clip.audioBuffer, 60);
        FormeOnde.dessiner(canvas, points, { couleur: 'rgba(0,0,0,0.18)' });
      });
    }

    const elNom = elClip.querySelector('.clip-nom');
    const elEdition = elClip.querySelector('.clip-nom-edition');

    function entrerEnEdition() {
      elNom.hidden = true;
      elEdition.hidden = false;
      elEdition.focus();
      elEdition.select();
    }
    function validerEdition() {
      elEdition.hidden = true;
      elNom.hidden = false;
      const nouveauNom = elEdition.value.trim();
      if (nouveauNom && nouveauNom !== clip.nom) {
        elNom.textContent = nouveauNom;
        callbacks.onRenommerClip(indexPiste, indexClip, nouveauNom);
      } else {
        elEdition.value = clip.nom;
      }
    }
    elEdition.addEventListener('click', (e) => e.stopPropagation());
    elEdition.addEventListener('blur', validerEdition);
    elEdition.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); validerEdition(); }
      if (e.key === 'Escape') { e.preventDefault(); elEdition.value = clip.nom; validerEdition(); }
    });
    // entrerEnEdition est appelee depuis initialiserGlisserClip lorsque le
    // clic sur le nom n'a entraine AUCUN mouvement (donc un vrai clic, pas
    // un debut de glissement) -- voir plus bas

    elClip.querySelector('.bouton-jouer-clip').addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onJouerClip(indexPiste, indexClip, e.currentTarget);
    });
    elClip.querySelector('.bouton-supprimer-clip').addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onDemanderSupprimerClip(indexPiste, indexClip);
    });
    elClip.querySelector('.bouton-reglages-clip').addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onOuvrirReglagesClip(indexPiste, indexClip);
    });
    elClip.querySelector('.bouton-dupliquer-clip').addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onDupliquerClip(indexPiste, indexClip);
    });
    elClip.querySelector('.bouton-fermer-actions-clip').addEventListener('click', (e) => {
      e.stopPropagation();
      basculerActionsVisibles();
    });

    function basculerActionsVisibles() {
      const etaitVisible = elClip.classList.contains('actions-visibles');
      document.querySelectorAll('.clip-audio.actions-visibles').forEach(el => {
        el.classList.remove('actions-visibles');
        el.querySelector('.clip-boutons-action').style.left = '';
        el.querySelector('.clip-boutons-action').style.transform = '';
      });
      if (etaitVisible) return; // on voulait juste fermer

      elClip.classList.add('actions-visibles');
      requestAnimationFrame(() => {
        const overlay = elClip.querySelector('.clip-boutons-action');
        const poignee = elClip.querySelector('.clip-poignee-actions');
        const conteneurScroll = elClip.closest('.piste-pose-conteneur');
        if (!overlay || !conteneurScroll) return;

        // Positionner sous le bouton ⋯, pas au centre du clip
        const rectPoignee = poignee ? poignee.getBoundingClientRect() : elClip.getBoundingClientRect();
        const rectClip = elClip.getBoundingClientRect();
        const rectConteneur = conteneurScroll.getBoundingClientRect();
        const largeurOverlay = overlay.offsetWidth;

        // Centre cible = centre du bouton ⋯
        const centrePoignee = rectPoignee.left + rectPoignee.width / 2;
        // Décalage par rapport au centre du clip (point d'ancrage CSS de l'overlay)
        const centreClip = rectClip.left + rectClip.width / 2;
        let decalage = centrePoignee - centreClip;

        // Éviter que l'overlay déborde du conteneur scroll
        const posGauche = centrePoignee - largeurOverlay / 2;
        const posDroite = centrePoignee + largeurOverlay / 2;
        if (posGauche < rectConteneur.left)
          decalage += rectConteneur.left - posGauche;
        else if (posDroite > rectConteneur.right)
          decalage -= posDroite - rectConteneur.right;

        overlay.style.left = `calc(50% + ${decalage}px)`;
      });
    }

    // clic sur le clip (hors boutons/nom) : bascule l'affichage des actions.
    // Un clic sur le FOND de l'overlay (mais pas sur un bouton precis) le referme aussi.
    elClip.querySelector('.clip-poignee-actions').addEventListener('click', (e) => {
      e.stopPropagation();
      basculerActionsVisibles();
    });

    initialiserGlisserClip(elClip, indexPiste, indexClip, piste, entrerEnEdition);
    initialiserClicDecoupage(elClip, indexPiste, indexClip);

    return elClip;
  }

  function echapperHtml(texte) {
    const div = document.createElement('div');
    div.textContent = texte;
    return div.innerHTML;
  }

  /* ---------- Glisser-deposer pour repositionner un clip, avec effet aimant ---------- */

  function calculerReperesAimant(piste, indexClipExclu) {
    // renvoie la liste des positions (en pixels) ou les bords des AUTRES
    // clips se trouvent : debut a 0, et debut/fin de chaque clip existant.
    // On utilise la largeur REELLEMENT AFFICHEE (donc avec le plancher de
    // lisibilite) pour que l'aimant accroche au bord visuel exact, et non
    // a une position legerement decalee qui ferait chevaucher les clips.
    const pps = pixelsParSeconde();
    const reperes = [0];
    piste.clips.forEach((c, i) => {
      if (i === indexClipExclu) return;
      const debut = c.debutDansPiste * pps;
      const dureeReelle = (c.decoupeFin ?? c.dureeOriginale) - (c.decoupeDebut || 0);
      const largeurAffichee = Math.max(LARGEUR_MIN_CLIP_PX, dureeReelle * pps);
      reperes.push(debut, debut + largeurAffichee);
    });
    return reperes;
  }

  function initialiserGlisserClip(elClip, indexPiste, indexClip, piste, callbackClicSurNom) {
    let enGlissement = false;
    let xDepart = 0;
    let yDepart = 0;
    let leftDepart = 0;
    let aBouge = false;
    let elementsRepere = [];
    let pisteSurvoleeActuelle = null;
    let cibleInitialeEtaitLeNom = false;

    function nettoyerReperesVisuels() {
      elementsRepere.forEach(el => el.remove());
      elementsRepere = [];
    }

    function nettoyerSurvolPiste() {
      if (pisteSurvoleeActuelle) {
        pisteSurvoleeActuelle.classList.remove('piste-cible-glissement');
        pisteSurvoleeActuelle = null;
      }
    }

    function demarrer(e) {
      if (e.target.closest('.clip-boutons-action') || e.target.closest('.clip-poignee-actions')) return;
      cibleInitialeEtaitLeNom = !!e.target.closest('.clip-nom-conteneur');
      enGlissement = true;
      aBouge = false;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      xDepart = clientX;
      yDepart = clientY;
      leftDepart = parseFloat(elClip.style.left) || 0;
      elClip.classList.add('en-deplacement');
      e.preventDefault();
    }

    function trouverPisteSousLeCurseur(clientX, clientY) {
      const ancienPointerEvents = elClip.style.pointerEvents;
      elClip.style.pointerEvents = 'none';
      const elementSousCurseur = document.elementFromPoint(clientX, clientY);
      elClip.style.pointerEvents = ancienPointerEvents;
      if (!elementSousCurseur) return null;
      // Dans la nouvelle architecture, les rangées sont .piste-clips-rangee
      return elementSousCurseur.closest('.piste-clips-rangee');
    }

    function deplacer(e) {
      if (!enGlissement) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const delta = clientX - xDepart;
      if (Math.abs(delta) > 3 || Math.abs(clientY - yDepart) > 3) aBouge = true;
      let nouveauLeft = Math.max(0, leftDepart + delta);

      // detection de survol d'une AUTRE piste (deplacement vertical)
      const elPisteSurvolee = trouverPisteSousLeCurseur(clientX, clientY);
      nettoyerSurvolPiste();
      if (elPisteSurvolee && elPisteSurvolee !== elClip.closest('.piste-clips-rangee')) {
        elPisteSurvolee.classList.add('piste-cible-glissement');
        pisteSurvoleeActuelle = elPisteSurvolee;
      }

      // effet aimant : uniquement pertinent si on reste sur la piste d'origine
      // (changer de piste rend l'alignement avec les clips de l'AUTRE piste
      // moins prevvisible pour un enfant ; on garde simple)
      if (!pisteSurvoleeActuelle) {
        const largeurClip = elClip.offsetWidth;
        const reperes = calculerReperesAimant(piste, indexClip);
        let meilleureAccroche = null;
        let meilleureDistance = TOLERANCE_AIMANT_PX + 1;
        let accrocheParBordGauche = true;

        for (const repere of reperes) {
          const distanceGauche = Math.abs(nouveauLeft - repere);
          if (distanceGauche < meilleureDistance) {
            meilleureDistance = distanceGauche;
            meilleureAccroche = repere;
            accrocheParBordGauche = true;
          }
          const distanceDroite = Math.abs((nouveauLeft + largeurClip) - repere);
          if (distanceDroite < meilleureDistance) {
            meilleureDistance = distanceDroite;
            meilleureAccroche = repere - largeurClip;
            accrocheParBordGauche = false;
          }
        }

        nettoyerReperesVisuels();
        if (meilleureAccroche !== null) {
          nouveauLeft = Math.max(0, meilleureAccroche);
          const conteneurInterieur = elClip.parentElement;
          const ligne = document.createElement('div');
          ligne.className = 'repere-aimant';
          const positionLigne = accrocheParBordGauche ? nouveauLeft : nouveauLeft + largeurClip;
          ligne.style.left = positionLigne + 'px';
          conteneurInterieur.appendChild(ligne);
          elementsRepere.push(ligne);
        }
      } else {
        nettoyerReperesVisuels();
      }

      elClip.style.left = nouveauLeft + 'px';
    }

    function relacher() {
      if (!enGlissement) return;
      enGlissement = false;
      elClip.classList.remove('en-deplacement');
      nettoyerReperesVisuels();
      const pisteCible = pisteSurvoleeActuelle;
      nettoyerSurvolPiste();

      if (aBouge) {
        const nouveauLeft = parseFloat(elClip.style.left) || 0;
        const nouveauDebut = nouveauLeft / pixelsParSeconde();
        if (pisteCible) {
          const indexPisteCible = parseInt(pisteCible.dataset.indexPiste ?? pisteCible.closest('[data-index-piste]')?.dataset.indexPiste, 10);
          callbacks.onDeplacerClipVersAutrePiste(indexPiste, indexClip, indexPisteCible, nouveauDebut);
        } else {
          callbacks.onDeplacerClip(indexPiste, indexClip, nouveauDebut);
        }
      } else if (cibleInitialeEtaitLeNom && callbackClicSurNom) {
        // vrai clic (sans glissement) sur le nom : on ouvre l'edition
        callbackClicSurNom();
      }
    }

    elClip.addEventListener('mousedown', demarrer);
    elClip.addEventListener('touchstart', demarrer, { passive: false });
    window.addEventListener('mousemove', deplacer);
    window.addEventListener('touchmove', deplacer, { passive: false });
    window.addEventListener('mouseup', relacher);
    window.addEventListener('touchend', relacher);
  }

  /* ---------- Double-clic = ouvrir le decoupage ---------- */

  function initialiserClicDecoupage(elClip, indexPiste, indexClip) {
    elClip.querySelector('.bouton-decouper-clip').addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onOuvrirDecoupage(indexPiste, indexClip);
    });
    // le double-clic reste un raccourci pratique pour qui le decouvre,
    // mais le bouton ciseau est desormais le moyen fiable et visible
    elClip.addEventListener('dblclick', (e) => {
      if (e.target.closest('.clip-boutons-action')) return;
      e.stopPropagation();
      callbacks.onOuvrirDecoupage(indexPiste, indexClip);
    });
  }

  /* ---------- Depot de sons (depuis banque ou import) sur une piste ---------- */

  function initialiserDepotSurPiste(conteneurPose, conteneurInterieur, indexPiste) {
    conteneurPose.addEventListener('dragover', (e) => {
      e.preventDefault();
      conteneurPose.classList.add('survol-drag');
    });
    conteneurPose.addEventListener('dragleave', () => {
      conteneurPose.classList.remove('survol-drag');
    });
    conteneurPose.addEventListener('drop', (e) => {
      e.preventDefault();
      conteneurPose.classList.remove('survol-drag');
      const idSon = e.dataTransfer.getData('text/son-banque-id');
      const rect = conteneurInterieur.getBoundingClientRect();
      const positionSecondes = Math.max(0, (e.clientX - rect.left) / pixelsParSeconde());
      if (idSon) {
        callbacks.onDeposerSonBanque(indexPiste, idSon, positionSecondes);
      }
    });
  }

  /**
   * Met à jour la position du playhead (ligne de lecture verticale).
   * positionSecondes = position actuelle de la tête de lecture.
   * dureeTotale = durée totale du podcast (pour masquer si terminé/arrêté).
   *
   * L'offset gauche est lu via offsetLeft du piste-pose-conteneur par rapport
   * à son parent .piste — valeur CSS du layout, stable et indépendante du
   * rendu à l'écran (contrairement à getBoundingClientRect qui varie avec
   * le scroll et le zoom navigateur).
   */
  function mettreAJourPlayhead(positionSecondes, dureeTotale) {
    if (!elPlayhead) return;
    if (dureeTotale <= 0 || positionSecondes < 0) {
      elPlayhead.style.display = 'none';
      return;
    }
    const pps = pixelsParSeconde();

    // Le playhead est dans le wrapper interne qui défile avec le contenu.
    // +1px pour que le curseur reste visible même à la position 0
    const x = positionSecondes * pps + 1;
    elPlayhead.style.display = 'block';
    elPlayhead.style.left = x + 'px';

    // Scroll automatique : garder le playhead visible pendant la lecture
    if (colonneScrollDom) {
      const largeurVisible = colonneScrollDom.clientWidth;
      const scrollActuel   = colonneScrollDom.scrollLeft;
      const marge = 80;
      if (x > scrollActuel + largeurVisible - marge) {
        colonneScrollDom.scrollLeft = x - marge;
      }
    }
  }

  function cacherPlayhead() {
    if (elPlayhead) elPlayhead.style.display = 'none';
  }

  /** Remet le scroll horizontal à 0 (retour au début du projet). */
  function scrollerAuDebut() {
    if (colonneScrollDom) {
      colonneScrollDom.scrollLeft = 0;
    }
  }

  return {
    initialiser,
    rafraichir,
    formaterDuree,
    signalerClipNouveau,
    pixelsParSeconde,
    dureeMinimaleAffichable,
    mettreAJourPlayhead,
    cacherPlayhead,
    scrollerAuDebut,
    NB_PISTES_MAX,
    TYPES_PISTE,
  };
})();
