/* ===================================================================
   app.js
   Point d'entree de l'application. Contient :
   - l'etat du projet en cours (pistes, clips, nom...)
   - la navigation entre ecran accueil / editeur
   - la sauvegarde automatique (debounce apres une modification)
   - le branchement de tous les modules entre eux
   =================================================================== */

const App = (() => {

  let projetActuel = null; // { id, nom, pistes: [...] }
  let minuteurSauvegardeAuto = null;
  let sourcesEnCours = []; // sources Web Audio actives pendant "ecouter tout"
  let noeudsGainPistes = []; // GainNode + PannerNode par piste pour contrôle temps réel
  let lectureEnCours = false;
  let animationProgression = null;

  // contexte de la modale de reglages actuellement ouverte (piste ou clip)
  let contexteReglagesOuverts = null; // { type: 'piste'|'clip', indexPiste, indexClip }

  // ----- Elements DOM -----
  const ecranAccueil = document.getElementById('ecran-accueil');
  const ecranEditeur = document.getElementById('ecran-editeur');
  const btnNouveauProjet = document.getElementById('btn-nouveau-projet');
  const btnImporterProjet = document.getElementById('btn-importer-projet');
  const inputImportFichier = document.getElementById('input-import-fichier');
  const zoneProjetsRecents = document.getElementById('zone-projets-recents');
  const listeProjetsRecents = document.getElementById('liste-projets-recents');

  const btnAccueil = document.getElementById('btn-accueil');
  const champNomPodcast = document.getElementById('nom-podcast');
  const indicateurSauvegarde = document.getElementById('indicateur-sauvegarde');
  const btnSauvegarder = document.getElementById('btn-sauvegarder');
  const btnExporter = document.getElementById('btn-exporter');

  const btnEnregistrerRapide = document.getElementById('btn-enregistrer-rapide');
  const btnAjouterSon = document.getElementById('btn-ajouter-son');
  const inputImportSon = document.getElementById('input-import-son');
  const btnOuvrirBanque = document.getElementById('btn-ouvrir-banque');
  const menuBanqueDeroulant = document.getElementById('menu-banque-deroulant');
  const banqueSonsListe = document.getElementById('banque-sons-liste');

  const btnJouerTout = document.getElementById('btn-jouer-tout');
  const btnStop = document.getElementById('btn-stop');
  const btnReculer = document.getElementById('btn-reculer');
  const btnAvancer = document.getElementById('btn-avancer');
  const btnStopper = document.getElementById('btn-stopper');
  const barreProgressionConteneur = document.querySelector('.barre-progression-conteneur');
  const barreProgression = document.getElementById('barre-progression');
  const barreProgressionRemplissage = document.getElementById('barre-progression-remplissage');
  const barreProgressionCurseur = document.getElementById('barre-progression-curseur');
  const tempsAffiche = document.getElementById('temps-affiche');

  const modaleConfirmation = document.getElementById('modale-confirmation');
  const texteConfirmation = document.getElementById('texte-confirmation');
  const btnConfirmationOui = document.getElementById('btn-confirmation-oui');
  const btnConfirmationNon = document.getElementById('btn-confirmation-non');

  const modaleReglages = document.getElementById('modale-reglages');
  const titreReglages = document.getElementById('titre-reglages');
  const ligneePanoramique = document.getElementById('ligne-panoramique');
  const curseurVolume = document.getElementById('curseur-volume');
  const valeurVolume = document.getElementById('valeur-volume');
  const curseurPanoramique = document.getElementById('curseur-panoramique');
  const valeurPanoramique = document.getElementById('valeur-panoramique');
  const ligneeFondus = document.getElementById('ligne-fondus');
  const curseurFonduEntree = document.getElementById('curseur-fondu-entree');
  const valeurFonduEntree = document.getElementById('valeur-fondu-entree');
  const curseurFonduSortie = document.getElementById('curseur-fondu-sortie');
  const valeurFonduSortie = document.getElementById('valeur-fondu-sortie');
  const btnFermerReglages = document.getElementById('btn-fermer-reglages');
  const btnFermerReglagesBas = document.getElementById('btn-fermer-reglages-bas');

  const toast = document.getElementById('toast');

  /* ===================== UTILITAIRES ===================== */

  function afficherToast(message, duree = 2500) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.hidden = true; }, duree);
  }

  function demanderConfirmation(message) {
    return new Promise((resolve) => {
      texteConfirmation.textContent = message;
      modaleConfirmation.hidden = false;
      function repondre(valeur) {
        modaleConfirmation.hidden = true;
        btnConfirmationOui.removeEventListener('click', surOui);
        btnConfirmationNon.removeEventListener('click', surNon);
        resolve(valeur);
      }
      function surOui() { repondre(true); }
      function surNon() { repondre(false); }
      btnConfirmationOui.addEventListener('click', surOui);
      btnConfirmationNon.addEventListener('click', surNon);
    });
  }

  function echapperHtml(texte) {
    const div = document.createElement('div');
    div.textContent = texte;
    return div.innerHTML;
  }

  /** Volume reel a appliquer pour une piste : 0 si la piste est rendue muette. */
  function volumeEffectifPiste(piste) {
    return piste.muette ? 0 : (piste.volume ?? 1);
  }

  /* ===================== CREATION / CHARGEMENT DE PROJET ===================== */

  function creerProjetVide() {
    return {
      id: Stockage.genererIdentifiant(),
      nom: 'Podcast sans titre',
      pistes: [
        { type: 'voix', volume: 1, pan: 0, muette: false, clips: [] },
        { type: 'ambiance', volume: 0.7, pan: 0, muette: false, clips: [] },
      ],
      sonsPersonnels: [], // sons importes par l'eleve dans la bibliotheque (pas le catalogue fourni)
    };
  }

  async function demarrerNouveauProjet() {
    projetActuel = creerProjetVide();
    construireBanqueSonsUI();
    afficherEditeur();
    reinitialiserHistorique();
  }

  async function ouvrirProjetExistant(projet) {
    projetActuel = projet;
    // compatibilite avec d'anciens fichiers .podcast sans pan/volume/sonsPersonnels defini
    if (!Array.isArray(projetActuel.sonsPersonnels)) projetActuel.sonsPersonnels = [];
    for (const son of projetActuel.sonsPersonnels) {
      if (son.audioBase64 && !son.audioBuffer) {
        try {
          son.audioBuffer = await AudioMoteur.base64VersAudioBuffer(son.audioBase64);
        } catch (e) {
          console.error('Erreur reconstruction son personnel', son.nom, e);
        }
      }
    }
    for (const piste of projetActuel.pistes) {
      if (piste.volume === undefined) piste.volume = 1;
      if (piste.pan === undefined) piste.pan = 0;
      if (piste.muette === undefined) piste.muette = false;
      for (const clip of piste.clips) {
        if (clip.volume === undefined) clip.volume = 1;
        if (clip.fonduEntree === undefined) clip.fonduEntree = 0;
        if (clip.fonduSortie === undefined) clip.fonduSortie = 0;
        if (clip.audioBase64 && !clip.audioBuffer) {
          try {
            clip.audioBuffer = await AudioMoteur.base64VersAudioBuffer(clip.audioBase64);
          } catch (e) {
            console.error('Erreur reconstruction audio clip', clip.nom, e);
          }
        }
      }
    }
    construireBanqueSonsUI();
    afficherEditeur();
    reinitialiserHistorique();
  }

  function afficherEditeur() {
    ecranAccueil.hidden = true;
    ecranEditeur.hidden = false;
    champNomPodcast.value = projetActuel.nom;
    PistesUI.rafraichir(projetActuel.pistes);
    // Calculer la durée et afficher le curseur dès l'ouverture, en position 0
    dureeTotalePodcast = ExportMp3.calculerDureeTotale(projetActuel.pistes);
    positionLecturePodcast = 0;
    mettreAJourAffichageProgression(0);
    PistesUI.mettreAJourPlayhead(0, Math.max(dureeTotalePodcast, 1));
  }

  function retournerAccueil() {
    arreterLectureGlobale();
    PistesUI.cacherPlayhead();
    ecranEditeur.hidden = true;
    ecranAccueil.hidden = false;
    rafraichirListeProjetsRecents();
  }

  /* ===================== ECRAN ACCUEIL : PROJETS RECENTS ===================== */

  function rafraichirListeProjetsRecents() {
    const projets = Stockage.listerProjetsRecents();
    if (projets.length === 0) {
      zoneProjetsRecents.hidden = true;
      return;
    }
    zoneProjetsRecents.hidden = false;
    listeProjetsRecents.innerHTML = '';
    for (const p of projets) {
      const el = document.createElement('div');
      el.className = 'carte-projet-recent';
      const date = new Date(p.modifieLe);
      const dateTexte = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) +
        ' à ' + date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `
        <div class="carte-projet-recent-infos">
          <p class="carte-projet-recent-nom">${echapperHtml(p.nom)}</p>
          <p class="carte-projet-recent-date">${dateTexte}</p>
        </div>
        <button class="bouton-reprendre-recent">Reprendre</button>
        <button class="bouton-supprimer-recent" title="Oublier ce podcast sur cet ordinateur">🗑️</button>
      `;
      el.querySelector('.bouton-reprendre-recent').addEventListener('click', async () => {
        const projet = await Stockage.chargerProjet(p.id);
        if (projet) {
          await ouvrirProjetExistant(projet);
        } else {
          afficherToast('Impossible de retrouver ce podcast.');
        }
      });
      el.querySelector('.bouton-supprimer-recent').addEventListener('click', async () => {
        const confirme = await demanderConfirmation('Oublier ce podcast sur cet ordinateur ? Le fichier .podcast que tu as téléchargé (si tu en as un) ne sera pas affecté.');
        if (confirme) {
          await Stockage.supprimerProjet(p.id);
          rafraichirListeProjetsRecents();
        }
      });
      listeProjetsRecents.appendChild(el);
    }
  }

  /* ===================== SAUVEGARDE AUTOMATIQUE ===================== */

  function projeterVersionSerialisable(projet) {
    // on convertit les AudioBuffer en base64 pour le stockage / export fichier
    const copie = {
      id: projet.id,
      nom: projet.nom,
      pistes: projet.pistes.map(piste => ({
        type: piste.type,
        volume: piste.volume,
        pan: piste.pan || 0,
        muette: !!piste.muette,
        clips: piste.clips.map(clip => ({
          nom: clip.nom,
          debutDansPiste: clip.debutDansPiste,
          decoupeDebut: clip.decoupeDebut || 0,
          decoupeFin: clip.decoupeFin,
          dureeOriginale: clip.dureeOriginale,
          volume: clip.volume ?? 1,
          fonduEntree: clip.fonduEntree || 0,
          fonduSortie: clip.fonduSortie || 0,
          audioBase64: clip.audioBase64,
        })),
      })),
      sonsPersonnels: (projet.sonsPersonnels || []).map(son => ({
        id: son.id,
        nom: son.nom,
        audioBase64: son.audioBase64,
        dureeOriginale: son.dureeOriginale,
      })),
    };
    return copie;
  }

  /* ===================== HISTORIQUE (ANNULER / REFAIRE) ===================== */

  const HISTORIQUE_MAX = 50; // nombre d'etapes conservees, au-dela les plus anciennes sont oubliees
  let pileAnnuler = [];
  let pileRefaire = [];
  let snapshotCourant = null; // dernier etat connu (JSON), pour detecter les changements
  let restaurationEnCours = false; // evite de re-enregistrer un etat pendant qu'on restaure

  const btnAnnuler = document.getElementById('btn-annuler');
  const btnRefaire = document.getElementById('btn-refaire');

  function capturerSnapshot() {
    return JSON.stringify(projeterVersionSerialisable(projetActuel));
  }

  /** A appeler juste apres avoir initialise un projet (nouveau ou importe), pour reinitialiser l'historique. */
  function reinitialiserHistorique() {
    pileAnnuler = [];
    pileRefaire = [];
    snapshotCourant = capturerSnapshot();
    mettreAJourBoutonsHistorique();
  }

  /** A appeler apres toute modification du projet, pour l'enregistrer dans l'historique si elle a reellement change quelque chose. */
  function enregistrerEtatHistorique() {
    if (restaurationEnCours) return;
    const nouveauSnapshot = capturerSnapshot();
    if (nouveauSnapshot === snapshotCourant) return; // rien de change, ne pas polluer l'historique
    pileAnnuler.push(snapshotCourant);
    if (pileAnnuler.length > HISTORIQUE_MAX) pileAnnuler.shift();
    snapshotCourant = nouveauSnapshot;
    pileRefaire = []; // toute nouvelle action invalide la pile "refaire"
    mettreAJourBoutonsHistorique();
  }

  function mettreAJourBoutonsHistorique() {
    btnAnnuler.disabled = pileAnnuler.length === 0;
    btnRefaire.disabled = pileRefaire.length === 0;
  }

  async function restaurerSnapshot(snapshotJson) {
    restaurationEnCours = true;
    try {
      const projetRestaure = JSON.parse(snapshotJson);
      // on reconstruit les AudioBuffer a partir du base64 (comme a l'ouverture d'un fichier)
      for (const son of (projetRestaure.sonsPersonnels || [])) {
        if (son.audioBase64) son.audioBuffer = await AudioMoteur.base64VersAudioBuffer(son.audioBase64);
      }
      for (const piste of projetRestaure.pistes) {
        for (const clip of piste.clips) {
          if (clip.audioBase64) clip.audioBuffer = await AudioMoteur.base64VersAudioBuffer(clip.audioBase64);
        }
      }
      projetActuel = projetRestaure;
      champNomPodcast.value = projetActuel.nom;
      construireBanqueSonsUI();
      PistesUI.rafraichir(projetActuel.pistes);
    } finally {
      restaurationEnCours = false;
    }
  }

  async function gererAnnuler() {
    if (pileAnnuler.length === 0) return;
    const snapshotPrecedent = pileAnnuler.pop();
    pileRefaire.push(snapshotCourant);
    snapshotCourant = snapshotPrecedent;
    await restaurerSnapshot(snapshotPrecedent);
    mettreAJourBoutonsHistorique();
    declencherSauvegardeAuto();
  }

  async function gererRefaire() {
    if (pileRefaire.length === 0) return;
    const snapshotSuivant = pileRefaire.pop();
    pileAnnuler.push(snapshotCourant);
    snapshotCourant = snapshotSuivant;
    await restaurerSnapshot(snapshotSuivant);
    mettreAJourBoutonsHistorique();
    declencherSauvegardeAuto();
  }

  btnAnnuler.addEventListener('click', gererAnnuler);
  btnRefaire.addEventListener('click', gererRefaire);

  document.addEventListener('keydown', (e) => {
    if (ecranEditeur.hidden) return;
    const cible = document.activeElement;
    const dansChampTexte = cible && (cible.tagName === 'INPUT' || cible.tagName === 'TEXTAREA');
    const dansModalDecoupage = !document.getElementById('modale-decoupage').hidden;
    const ctrlOuCmd = e.ctrlKey || e.metaKey;

    // Ctrl+Z / Ctrl+Y — annuler/refaire
    if (ctrlOuCmd) {
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (dansChampTexte) return;
        e.preventDefault();
        gererAnnuler();
      } else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        if (dansChampTexte) return;
        e.preventDefault();
        gererRefaire();
      }
      return;
    }

    // Raccourcis sans modificateur (hors champ texte et hors modale découpage)
    if (dansChampTexte || dansModalDecoupage) return;

    if (e.code === 'Space') {
      // Espace = Play / Pause
      e.preventDefault();
      basculerLecturePodcast();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      deplacerCurseur(e.shiftKey ? -5 : -PAS_DEPLACEMENT);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      deplacerCurseur(e.shiftKey ? 5 : PAS_DEPLACEMENT);
    }
  });

  function declencherSauvegardeAuto() {
    enregistrerEtatHistorique();
    indicateurSauvegarde.classList.remove('visible');
    clearTimeout(minuteurSauvegardeAuto);
    minuteurSauvegardeAuto = setTimeout(async () => {
      const serialisable = projeterVersionSerialisable(projetActuel);
      const ok = await Stockage.sauvegarderProjet(serialisable);
      if (ok) {
        indicateurSauvegarde.textContent = '💾 Sauvegardé';
        indicateurSauvegarde.classList.add('visible');
      } else {
        indicateurSauvegarde.textContent = '⚠️ Sauvegarde impossible';
        indicateurSauvegarde.classList.add('visible');
      }
    }, 1500);
  }

  /* ===================== NOM DU PODCAST ===================== */

  let minuteurHistoriqueTexte = null;
  champNomPodcast.addEventListener('input', () => {
    projetActuel.nom = champNomPodcast.value || 'Podcast sans titre';
    // debounce specifique pour l'historique : on ne veut pas une etape
    // d'annulation par caractere tape, juste une etape une fois la frappe terminee
    clearTimeout(minuteurHistoriqueTexte);
    minuteurHistoriqueTexte = setTimeout(() => enregistrerEtatHistorique(), 800);
    indicateurSauvegarde.classList.remove('visible');
    clearTimeout(minuteurSauvegardeAuto);
    minuteurSauvegardeAuto = setTimeout(async () => {
      const serialisable = projeterVersionSerialisable(projetActuel);
      const ok = await Stockage.sauvegarderProjet(serialisable);
      if (ok) {
        indicateurSauvegarde.textContent = '💾 Sauvegardé';
        indicateurSauvegarde.classList.add('visible');
      } else {
        indicateurSauvegarde.textContent = '⚠️ Sauvegarde impossible';
        indicateurSauvegarde.classList.add('visible');
      }
    }, 1500);
  });

  /* ===================== AJOUT DE CLIPS (import fichier / micro / banque) ===================== */

  function trouverPisteParDefautPourImport() {
    // on cherche la premiere piste de type "voix" ; sinon la premiere piste
    const indexVoix = projetActuel.pistes.findIndex(p => p.type === 'voix');
    return indexVoix !== -1 ? indexVoix : 0;
  }

  function calculerPositionLibre(piste) {
    if (piste.clips.length === 0) return 0;
    const dureeMinAffichable = PistesUI.dureeMinimaleAffichable();
    const dernierClip = piste.clips.reduce((max, c) => {
      const dureeReelle = (c.decoupeFin ?? c.dureeOriginale) - (c.decoupeDebut || 0);
      // on reserve au moins l'equivalent-temps de la largeur minimale
      // affichee a l'ecran, sinon un clip tres court placerait le suivant
      // a une position qui le ferait chevaucher visuellement (le clip
      // precedent est affiche plus large que sa duree reelle)
      const dureeAffichee = Math.max(dureeReelle, dureeMinAffichable);
      const fin = c.debutDansPiste + dureeAffichee;
      return fin > max ? fin : max;
    }, 0);
    return dernierClip; // bout a bout par defaut (l'utilisateur peut ensuite deplacer librement)
  }

  async function ajouterFichierAudioSurPiste(fichierOuBuffer, nomAffiche, indexPiste, audioBase64Optionnel) {
    let audioBuffer;
    let audioBase64;

    if (audioBase64Optionnel) {
      // Son de la banque : base64 MP3 original, déjà compact
      audioBase64 = audioBase64Optionnel;
      try {
        audioBuffer = fichierOuBuffer instanceof AudioBuffer
          ? fichierOuBuffer
          : await AudioMoteur.decoderFichier(fichierOuBuffer);
      } catch (e) {
        afficherToast("Ce fichier audio n'a pas pu être lu.");
        return;
      }
    } else if (fichierOuBuffer instanceof File) {
      // Fichier importé par l'utilisateur : lire le base64 directement
      // (évite un ré-encodage MP3 coûteux — on conserve le fichier tel quel)
      try {
        audioBase64 = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(',')[1]);
          reader.onerror = rej;
          reader.readAsDataURL(fichierOuBuffer);
        });
        audioBuffer = await AudioMoteur.decoderFichier(fichierOuBuffer);
      } catch (e) {
        afficherToast("Ce fichier audio n'a pas pu être lu.");
        console.error(e);
        return;
      }
    } else {
      // AudioBuffer (voix enregistrée) : encoder en MP3
      try {
        audioBuffer = fichierOuBuffer instanceof AudioBuffer
          ? fichierOuBuffer
          : await AudioMoteur.decoderFichier(fichierOuBuffer);
      } catch (e) {
        afficherToast("Ce fichier audio n'a pas pu être lu.");
        return;
      }
      try {
        afficherToast('Compression du son...', 3000);
        const blob = await ExportMp3.encoderEnMp3(audioBuffer);
        audioBase64 = await new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result.split(',')[1]);
          reader.onerror = rej;
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        console.warn('Encodage MP3 échoué, fallback WAV', e);
        audioBase64 = AudioMoteur.audioBufferVersBase64(audioBuffer);
      }
    }

    const piste = projetActuel.pistes[indexPiste];
    const position = calculerPositionLibre(piste);

    piste.clips.push({
      nom: nomAffiche,
      audioBuffer,
      audioBase64,
      debutDansPiste: position,
      decoupeDebut: 0,
      decoupeFin: audioBuffer.duration,
      dureeOriginale: audioBuffer.duration,
      volume: 1,
      fonduEntree: 0,
      fonduSortie: 0,
    });

    PistesUI.signalerClipNouveau(indexPiste, piste.clips.length - 1);
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
  }

  inputImportSon.addEventListener('change', async (e) => {
    const fichiers = Array.from(e.target.files || []);
    const indexPiste = trouverPisteParDefautPourImport();
    for (const fichier of fichiers) {
      await ajouterFichierAudioSurPiste(fichier, fichier.name.replace(/\.[^.]+$/, ''), indexPiste);
    }
    if (fichiers.length > 0) afficherToast(fichiers.length > 1 ? 'Sons importés !' : 'Son importé !');
    inputImportSon.value = '';
  });

  btnAjouterSon.addEventListener('click', () => inputImportSon.click());

  /* ===================== BANQUE DE SONS (menu deroulant) ===================== */

  const cacheBuffersBanque = {};
  const btnImporterDansBanque = document.getElementById('btn-importer-dans-banque');
  const inputImporterDansBanque = document.getElementById('input-importer-dans-banque');

  async function obtenirBufferBanque(idSon) {
    if (cacheBuffersBanque[idSon]) return cacheBuffersBanque[idSon];
    const sonPersonnel = (projetActuel.sonsPersonnels || []).find(s => s.id === idSon);
    if (sonPersonnel) {
      if (!sonPersonnel.audioBuffer) {
        sonPersonnel.audioBuffer = await AudioMoteur.base64VersAudioBuffer(sonPersonnel.audioBase64);
      }
      return sonPersonnel.audioBuffer;
    }
    const infoSon = BANQUE_SONS_CATALOGUE.find(s => s.id === idSon);
    if (!infoSon) return null;
    // les sons du catalogue fourni sont integres en base64 directement dans
    // banque-sons.js (pas de fetch() : fonctionne meme en ouvrant la page
    // sans serveur, protocole file://)
    const audioBuffer = await AudioMoteur.base64VersAudioBuffer(infoSon.base64);
    cacheBuffersBanque[idSon] = audioBuffer;
    return audioBuffer;
  }

  // État de la préécoute dans la bibliothèque
  let _sourcePreview = null;
  let _btnPreviewActif = null;

  function arreterPreviewBanque() {
    if (_sourcePreview) {
      try { _sourcePreview.stop(); } catch (e) {}
      _sourcePreview = null;
    }
    if (_btnPreviewActif) {
      _btnPreviewActif.textContent = '▶';
      _btnPreviewActif = null;
    }
  }

  function creerBoutonSon(son, estPersonnel) {
    const bouton = document.createElement('div');
    bouton.className = estPersonnel ? 'bouton-banque bouton-banque-personnel' : `bouton-banque type-${son.categorie}`;
    bouton.draggable = true;

    // Icône + nom
    const icone = document.createElement('span');
    icone.className = 'icone-son';
    icone.textContent = estPersonnel ? '🎵' : son.icone;

    const nom = document.createElement('span');
    nom.className = 'nom-son';
    nom.textContent = son.nom;

    // Bouton préécoute ▶
    const btnPreview = document.createElement('button');
    btnPreview.className = 'btn-preview-son';
    btnPreview.textContent = '▶';
    btnPreview.title = 'Écouter ce son';
    btnPreview.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (_btnPreviewActif === btnPreview) {
        arreterPreviewBanque();
        return;
      }
      arreterPreviewBanque();
      const audioBuffer = await obtenirBufferBanque(son.id);
      if (!audioBuffer) return;
      const ctx = AudioMoteur.obtenirContexte();
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.start();
      _sourcePreview = source;
      _btnPreviewActif = btnPreview;
      btnPreview.textContent = '⏹';
      source.onended = () => {
        if (_sourcePreview === source) {
          _sourcePreview = null;
          _btnPreviewActif = null;
          btnPreview.textContent = '▶';
        }
      };
    });

    bouton.appendChild(icone);
    bouton.appendChild(nom);
    bouton.appendChild(btnPreview);

    // Drag & drop
    bouton.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/son-banque-id', son.id);
      e.dataTransfer.effectAllowed = 'copy';
      arreterPreviewBanque();
      setTimeout(() => {
        menuBanqueDeroulant.style.visibility = 'hidden';
        menuBanqueDeroulant.style.pointerEvents = 'none';
      }, 0);
    });
    bouton.addEventListener('dragend', () => {
      menuBanqueDeroulant.style.visibility = '';
      menuBanqueDeroulant.style.pointerEvents = '';
      menuBanqueDeroulant.hidden = true;
    });

    // Clic sur le nom/icône → ajouter à la piste
    bouton.addEventListener('click', async (e) => {
      if (e.target.closest('.bouton-supprimer-son-personnel')) return;
      if (e.target.closest('.btn-preview-son')) return;
      arreterPreviewBanque();
      await ajouterSonBanqueSurPisteAdaptee(son, estPersonnel);
      menuBanqueDeroulant.hidden = true;
    });

    if (estPersonnel) {
      const btnSupprimer = document.createElement('span');
      btnSupprimer.className = 'bouton-supprimer-son-personnel';
      btnSupprimer.textContent = '🗑️';
      btnSupprimer.title = 'Retirer ce son de la bibliothèque';
      btnSupprimer.addEventListener('click', (e) => {
        e.stopPropagation();
        gererSupprimerSonPersonnel(son.id);
      });
      bouton.appendChild(btnSupprimer);
    }

    return bouton;
  }

  const LABELS_CATEGORIES = {
    jingle: { titre: 'Jingles', icone: '🔔' },
    ambiance: { titre: 'Tapis', icone: '🌬️' },
    bruitage: { titre: 'Bruitages', icone: '🔊' },
  };

  function creerEnteteCategorie(cle) {
    const info = LABELS_CATEGORIES[cle] || { titre: cle, icone: '🎵' };
    const entete = document.createElement('div');
    entete.className = 'banque-sons-entete-categorie';
    entete.innerHTML = `${info.icone} ${echapperHtml(info.titre)}`;
    return entete;
  }

  function construireBanqueSonsUI() {
    banqueSonsListe.innerHTML = '';

    // sons du catalogue fourni, regroupes par categorie (jingle / ambiance / bruitage)
    for (const cle of ['jingle', 'ambiance', 'bruitage']) {
      const sonsDeLaCategorie = BANQUE_SONS_CATALOGUE.filter(s => s.categorie === cle);
      if (sonsDeLaCategorie.length === 0) continue;
      banqueSonsListe.appendChild(creerEnteteCategorie(cle));
      const grille = document.createElement('div');
      grille.className = 'banque-sons-grille';
      for (const son of sonsDeLaCategorie) {
        grille.appendChild(creerBoutonSon(son, false));
      }
      banqueSonsListe.appendChild(grille);
    }

    // sons personnels importes par l'eleve, dans leur propre section
    const sonsPerso = projetActuel?.sonsPersonnels || [];
    if (sonsPerso.length > 0) {
      const entete = document.createElement('div');
      entete.className = 'banque-sons-entete-categorie';
      entete.innerHTML = '🎵 Mes sons';
      banqueSonsListe.appendChild(entete);
      const grille = document.createElement('div');
      grille.className = 'banque-sons-grille';
      for (const son of sonsPerso) {
        grille.appendChild(creerBoutonSon(son, true));
      }
      banqueSonsListe.appendChild(grille);
    }
  }

  btnOuvrirBanque.addEventListener('click', async (e) => {
    e.stopPropagation();
    const etaitCache = menuBanqueDeroulant.hidden;
    menuBanqueDeroulant.hidden = !etaitCache;
    if (etaitCache) {
      // Premier clic ou réouverture : charger les sons si pas encore fait
      if (!banqueSonsListe.dataset.chargee) {
        banqueSonsListe.innerHTML = '<div style="padding:12px;color:var(--texte-secondaire);font-size:13px;">⏳ Chargement des sons…</div>';
        await chargerBanqueSons();
        banqueSonsListe.dataset.chargee = '1';
        construireBanqueSonsUI();
      }
    }
  });
  document.addEventListener('click', (e) => {
    if (!menuBanqueDeroulant.hidden && !e.target.closest('.menu-banque-conteneur')) {
      menuBanqueDeroulant.hidden = true;
      arreterPreviewBanque();
    }
  });

  btnImporterDansBanque.addEventListener('click', (e) => {
    e.stopPropagation();
    inputImporterDansBanque.click();
  });

  inputImporterDansBanque.addEventListener('change', async (e) => {
    const fichiers = Array.from(e.target.files || []);
    for (const fichier of fichiers) {
      try {
        const audioBuffer = await AudioMoteur.decoderFichier(fichier);
        const audioBase64 = AudioMoteur.audioBufferVersBase64(audioBuffer);
        const sonPersonnel = {
          id: 'perso_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
          nom: fichier.name.replace(/\.[^.]+$/, ''),
          audioBuffer,
          audioBase64,
          dureeOriginale: audioBuffer.duration,
        };
        if (!projetActuel.sonsPersonnels) projetActuel.sonsPersonnels = [];
        projetActuel.sonsPersonnels.push(sonPersonnel);
      } catch (err) {
        console.error('Erreur import son personnel', err);
        afficherToast(`"${fichier.name}" n'a pas pu être ajouté (format non reconnu ?).`);
      }
    }
    if (fichiers.length > 0) {
      construireBanqueSonsUI();
      declencherSauvegardeAuto();
      afficherToast(fichiers.length > 1 ? 'Sons ajoutés à la bibliothèque !' : 'Son ajouté à la bibliothèque !');
    }
    inputImporterDansBanque.value = '';
  });

  function gererSupprimerSonPersonnel(idSon) {
    projetActuel.sonsPersonnels = (projetActuel.sonsPersonnels || []).filter(s => s.id !== idSon);
    construireBanqueSonsUI();
    declencherSauvegardeAuto();
  }

  async function ajouterSonBanqueSurPisteAdaptee(son, estPersonnel) {
    // Si plusieurs pistes existent, demander sur laquelle ajouter le son
    const nbPistes = projetActuel.pistes.length;
    let indexPiste;

    if (nbPistes === 0) {
      // Pas de piste : créer une piste adaptée
      const type = estPersonnel ? 'voix' : son.categorie;
      projetActuel.pistes.push({ type, volume: 1, pan: 0, muette: false, clips: [] });
      indexPiste = 0;
    } else if (nbPistes === 1) {
      indexPiste = 0;
    } else {
      // Afficher un menu de choix de piste
      indexPiste = await choisirPiste(son);
      if (indexPiste === null) return; // annulé
    }

    afficherToast('Ajout du son...', 1200);
    const audioBuffer = await obtenirBufferBanque(son.id);
    if (audioBuffer) {
      const base64Original = estPersonnel ? null : son.base64;
      await ajouterFichierAudioSurPiste(audioBuffer, son.nom, indexPiste, base64Original);
      const nomPiste = PistesUI.TYPES_PISTE[projetActuel.pistes[indexPiste].type]?.label || '';
      afficherToast(`Son ajouté à la piste "${nomPiste}" !`);
    } else {
      afficherToast("Ce son n'a pas pu être chargé.");
    }
  }

  /** Affiche un menu de choix de piste et retourne l'index choisi (ou null si annulé). */
  function choisirPiste(son) {
    return new Promise(resolve => {
      // Supprimer tout menu précédent
      document.querySelectorAll('.menu-choix-piste').forEach(m => m.remove());

      const menu = document.createElement('div');
      menu.className = 'menu-choix-piste';
      menu.innerHTML = `<div class="menu-choix-piste-titre">Ajouter sur quelle piste ?</div>`;

      projetActuel.pistes.forEach((piste, i) => {
        const info = PistesUI.TYPES_PISTE[piste.type] || {};
        const btn = document.createElement('button');
        btn.className = 'menu-choix-piste-option';
        btn.textContent = `${info.icone || ''} Piste ${i + 1} — ${info.label || piste.type}`;
        btn.addEventListener('click', () => { menu.remove(); resolve(i); });
        menu.appendChild(btn);
      });

      // Bouton créer une nouvelle piste si possible
      if (projetActuel.pistes.length < PistesUI.NB_PISTES_MAX) {
        const type = son.categorie || 'voix';
        const info = PistesUI.TYPES_PISTE[type] || {};
        const btnNouv = document.createElement('button');
        btnNouv.className = 'menu-choix-piste-option menu-choix-piste-nouveau';
        btnNouv.textContent = `➕ Nouvelle piste ${info.label || type}`;
        btnNouv.addEventListener('click', () => {
          projetActuel.pistes.push({ type, volume: 1, pan: 0, muette: false, clips: [] });
          menu.remove();
          resolve(projetActuel.pistes.length - 1);
        });
        menu.appendChild(btnNouv);
      }

      const btnAnnuler = document.createElement('button');
      btnAnnuler.className = 'menu-choix-piste-option menu-choix-piste-annuler';
      btnAnnuler.textContent = '✕ Annuler';
      btnAnnuler.addEventListener('click', () => { menu.remove(); resolve(null); });
      menu.appendChild(btnAnnuler);

      // Positionner le menu au centre
      document.body.appendChild(menu);
      // Fermer si clic à l'extérieur
      setTimeout(() => {
        document.addEventListener('click', function fermer(e) {
          if (!menu.contains(e.target)) { menu.remove(); resolve(null); document.removeEventListener('click', fermer); }
        });
      }, 0);
    });
  }

  async function gererDepotSonBanque(indexPiste, idSon, positionSecondes) {
    const sonPersonnel = (projetActuel.sonsPersonnels || []).find(s => s.id === idSon);
    const son = sonPersonnel || BANQUE_SONS_CATALOGUE.find(s => s.id === idSon);
    if (!son) return;
    const audioBuffer = await obtenirBufferBanque(idSon);
    if (!audioBuffer) {
      afficherToast("Ce son n'a pas pu être chargé.");
      return;
    }
    // Pour les sons de la banque intégrée, on réutilise le base64 MP3 original
    // (compact, ~10-100 Ko) plutôt que de reconvertir en WAV (~1 Mo).
    // Cela évite de saturer le localStorage avec des données trop volumineuses.
    const audioBase64 = son.base64 || AudioMoteur.audioBufferVersBase64(audioBuffer);
    const piste = projetActuel.pistes[indexPiste];
    piste.clips.push({
      nom: son.nom,
      audioBuffer,
      audioBase64,
      debutDansPiste: positionSecondes,
      decoupeDebut: 0,
      decoupeFin: audioBuffer.duration,
      dureeOriginale: audioBuffer.duration,
      volume: 1,
      fonduEntree: 0,
      fonduSortie: 0,
    });
    PistesUI.signalerClipNouveau(indexPiste, piste.clips.length - 1);
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
  }

  /* ===================== ENREGISTREMENT MICRO ===================== */

  async function lancerEnregistrementSurPiste(indexPiste) {
    const audioBuffer = await Enregistrement.ouvrir();
    if (audioBuffer) {
      await ajouterFichierAudioSurPiste(audioBuffer, 'Ma voix', indexPiste);
      afficherToast('Enregistrement ajouté !');
    }
  }

  btnEnregistrerRapide.addEventListener('click', () => {
    const indexPiste = trouverPisteParDefautPourImport();
    lancerEnregistrementSurPiste(indexPiste);
  });

  /* ===================== DECOUPAGE ===================== */

  async function gererOuvrirDecoupage(indexPiste, indexClip) {
    const clip = projetActuel.pistes[indexPiste].clips[indexClip];
    if (!clip.audioBuffer) {
      afficherToast('Ce son n\'est pas encore prêt, réessaie dans un instant.');
      return;
    }

    // on isole la portion actuellement decoupee pour l'editeur (coherent avec ce qui est joue)
    const bufferActuel = (clip.decoupeDebut > 0 || clip.decoupeFin < clip.dureeOriginale)
      ? AudioMoteur.decouperAudioBuffer(clip.audioBuffer, clip.decoupeDebut, clip.decoupeFin)
      : clip.audioBuffer;

    const resultat = await Decoupage.ouvrir(bufferActuel, clip.debutDansPiste);
    if (!resultat) return; // annule

    const { debutRognage, finRognage, pointDeCoupe } = resultat;
    const volumeOrigine = clip.volume ?? 1;

    if (pointDeCoupe !== null) {
      // on separe en deux clips independants, l'un juste apres l'autre (bout a bout)
      const bufferAvant = AudioMoteur.decouperAudioBuffer(bufferActuel, debutRognage, pointDeCoupe);
      const bufferApres = AudioMoteur.decouperAudioBuffer(bufferActuel, pointDeCoupe, finRognage);

      const piste = projetActuel.pistes[indexPiste];
      const positionOriginale = clip.debutDansPiste;

      piste.clips.splice(indexClip, 1,
        {
          nom: clip.nom + ' (1)',
          audioBuffer: bufferAvant,
          audioBase64: AudioMoteur.audioBufferVersBase64(bufferAvant),
          debutDansPiste: positionOriginale,
          decoupeDebut: 0,
          decoupeFin: bufferAvant.duration,
          dureeOriginale: bufferAvant.duration,
          volume: volumeOrigine,
          // le fondu d'entree d'origine reste sur le premier morceau ;
          // pas de fondu de sortie sur le point de coupe interne
          fonduEntree: clip.fonduEntree || 0,
          fonduSortie: 0,
        },
        {
          nom: clip.nom + ' (2)',
          audioBuffer: bufferApres,
          audioBase64: AudioMoteur.audioBufferVersBase64(bufferApres),
          debutDansPiste: positionOriginale + bufferAvant.duration,
          decoupeDebut: 0,
          decoupeFin: bufferApres.duration,
          dureeOriginale: bufferApres.duration,
          volume: volumeOrigine,
          // pas de fondu d'entree sur le point de coupe interne ;
          // le fondu de sortie d'origine reste sur le second morceau
          fonduEntree: 0,
          fonduSortie: clip.fonduSortie || 0,
        }
      );
      PistesUI.rafraichir(projetActuel.pistes);
      afficherToast('✅ Son coupé en deux morceaux !', 3000);
      const elPiste = document.querySelectorAll('.piste')[indexPiste];
      if (elPiste) {
        const clipsDom = elPiste.querySelectorAll('.clip-audio');
        clipsDom.forEach((el, i) => {
          if (i === indexClip || i === indexClip + 1) {
            el.classList.add('clip-nouveau');
            setTimeout(() => el.classList.remove('clip-nouveau'), 650);
          }
        });
      }
    } else {
      // simple rognage debut/fin, sans separation
      const nouveauBuffer = AudioMoteur.decouperAudioBuffer(bufferActuel, debutRognage, finRognage);
      clip.audioBuffer = nouveauBuffer;
      clip.audioBase64 = AudioMoteur.audioBufferVersBase64(nouveauBuffer);
      clip.decoupeDebut = 0;
      clip.decoupeFin = nouveauBuffer.duration;
      clip.dureeOriginale = nouveauBuffer.duration;
      PistesUI.signalerClipNouveau(indexPiste, indexClip);
      PistesUI.rafraichir(projetActuel.pistes);
      afficherToast('✅ Son ajusté !');
    }

    declencherSauvegardeAuto();
  }

  /* ===================== COUPE MULTI-PISTES SYNCHRONISEE ===================== */

  const modaleCoupeMulti = document.getElementById('modale-coupe-multi');
  const listePistesACouper = document.getElementById('liste-pistes-a-couper');
  const positionCoupeMultiValeur = document.getElementById('position-coupe-multi-valeur');
  const btnCouperToutesPistes = document.getElementById('btn-couper-toutes-pistes');
  const btnFermerCoupeMulti = document.getElementById('btn-fermer-coupe-multi');
  const btnAnnulerCoupeMulti = document.getElementById('btn-annuler-coupe-multi');
  const btnValiderCoupeMulti = document.getElementById('btn-valider-coupe-multi');

  function formaterPositionAbsolue(secondes) {
    const total = Math.max(0, secondes);
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    const ms = Math.round((total - Math.floor(total)) * 1000);
    return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }

  /** Trouve le clip d'une piste qui chevauche la position donnée (secondes), ou null. */
  function trouverClipAuPoint(piste, positionAbsolue) {
    for (let i = 0; i < piste.clips.length; i++) {
      const clip = piste.clips[i];
      const debut = clip.debutDansPiste;
      const duree = (clip.decoupeFin ?? clip.dureeOriginale) - (clip.decoupeDebut || 0);
      const fin = debut + duree;
      // marge de 30ms pour éviter de couper pile sur un bord (couperait un clip de 0s)
      if (positionAbsolue > debut + 0.03 && positionAbsolue < fin - 0.03) {
        return { clip, index: i, debut, fin };
      }
    }
    return null;
  }

  function ouvrirModaleCoupeMulti() {
    if (!projetActuel || projetActuel.pistes.length === 0) {
      afficherToast("Il n'y a pas encore de piste à couper.");
      return;
    }
    const positionAbsolue = positionLecturePodcast;
    positionCoupeMultiValeur.textContent = formaterPositionAbsolue(positionAbsolue);

    listePistesACouper.innerHTML = '';
    projetActuel.pistes.forEach((piste, indexPiste) => {
      const infoType = PistesUI.TYPES_PISTE[piste.type] || {};
      const resultat = trouverClipAuPoint(piste, positionAbsolue);

      const option = document.createElement('label');
      option.className = 'option-piste-a-couper' + (resultat ? '' : ' indisponible');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!resultat;
      checkbox.disabled = !resultat;
      checkbox.dataset.indexPiste = indexPiste;

      checkbox.addEventListener('change', () => {
        option.classList.toggle('selectionnee', checkbox.checked);
      });
      if (resultat) option.classList.add('selectionnee');

      const icone = document.createElement('span');
      icone.className = 'icone-piste';
      icone.textContent = infoType.icone || '🎵';

      const label = document.createElement('span');
      label.className = 'label-piste';
      label.textContent = `Piste ${indexPiste + 1} — ${infoType.label || piste.type}`;

      const info = document.createElement('span');
      info.className = 'info-piste';
      info.textContent = resultat ? resultat.clip.nom : 'Aucun son à cet endroit';

      option.appendChild(checkbox);
      option.appendChild(icone);
      option.appendChild(label);
      option.appendChild(info);
      listePistesACouper.appendChild(option);
    });

    modaleCoupeMulti.hidden = false;
  }

  function fermerModaleCoupeMulti() {
    modaleCoupeMulti.hidden = true;
  }

  async function validerCoupeMulti() {
    const positionAbsolue = positionLecturePodcast;
    const cases = Array.from(listePistesACouper.querySelectorAll('input[type="checkbox"]:checked'));

    if (cases.length === 0) {
      afficherToast('Sélectionne au moins une piste à couper.');
      return;
    }

    let nbCoupes = 0;
    for (const checkbox of cases) {
      const indexPiste = parseInt(checkbox.dataset.indexPiste, 10);
      const piste = projetActuel.pistes[indexPiste];
      const resultat = trouverClipAuPoint(piste, positionAbsolue);
      if (!resultat) continue;

      const { clip, index } = resultat;
      if (!clip.audioBuffer) continue;

      // Position de coupe en temps RELATIF au clip (le clip a pu être déjà rogné)
      const positionDansClip = (clip.decoupeDebut || 0) + (positionAbsolue - clip.debutDansPiste);

      const bufferAvant = AudioMoteur.decouperAudioBuffer(clip.audioBuffer, clip.decoupeDebut || 0, positionDansClip);
      const bufferApres = AudioMoteur.decouperAudioBuffer(clip.audioBuffer, positionDansClip, clip.decoupeFin ?? clip.dureeOriginale);

      const volumeOrigine = clip.volume ?? 1;
      const positionOriginale = clip.debutDansPiste;

      piste.clips.splice(index, 1,
        {
          nom: clip.nom + ' (1)',
          audioBuffer: bufferAvant,
          audioBase64: AudioMoteur.audioBufferVersBase64(bufferAvant),
          debutDansPiste: positionOriginale,
          decoupeDebut: 0,
          decoupeFin: bufferAvant.duration,
          dureeOriginale: bufferAvant.duration,
          volume: volumeOrigine,
          fonduEntree: clip.fonduEntree || 0,
          fonduSortie: 0,
        },
        {
          nom: clip.nom + ' (2)',
          audioBuffer: bufferApres,
          audioBase64: AudioMoteur.audioBufferVersBase64(bufferApres),
          debutDansPiste: positionOriginale + bufferAvant.duration,
          decoupeDebut: 0,
          decoupeFin: bufferApres.duration,
          dureeOriginale: bufferApres.duration,
          volume: volumeOrigine,
          fonduEntree: 0,
          fonduSortie: clip.fonduSortie || 0,
        }
      );
      nbCoupes++;
    }

    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
    fermerModaleCoupeMulti();

    if (nbCoupes > 0) {
      afficherToast(`✅ ${nbCoupes} piste${nbCoupes > 1 ? 's' : ''} coupée${nbCoupes > 1 ? 's' : ''} !`, 3000);
    } else {
      afficherToast("Aucune coupe effectuée.");
    }
  }

  btnCouperToutesPistes.addEventListener('click', ouvrirModaleCoupeMulti);
  btnFermerCoupeMulti.addEventListener('click', fermerModaleCoupeMulti);
  btnAnnulerCoupeMulti.addEventListener('click', fermerModaleCoupeMulti);
  btnValiderCoupeMulti.addEventListener('click', validerCoupeMulti);

    /* ===================== DEPLACEMENT / SUPPRESSION ===================== */

  function gererDeplacerClip(indexPiste, indexClip, nouveauDebut) {
    projetActuel.pistes[indexPiste].clips[indexClip].debutDansPiste = Math.max(0, nouveauDebut);
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
  }

  function gererDeplacerClipVersAutrePiste(indexPisteSource, indexClip, indexPisteCible, nouveauDebut) {
    const pisteSource = projetActuel.pistes[indexPisteSource];
    const pisteCible = projetActuel.pistes[indexPisteCible];
    const [clip] = pisteSource.clips.splice(indexClip, 1);
    clip.debutDansPiste = Math.max(0, nouveauDebut);
    pisteCible.clips.push(clip);
    PistesUI.signalerClipNouveau(indexPisteCible, pisteCible.clips.length - 1);
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
    const infoType = PistesUI.TYPES_PISTE[pisteCible.type];
    afficherToast(`Son déplacé vers la piste "${infoType ? infoType.label : pisteCible.type}" !`);
  }

  function gererRenommerClip(indexPiste, indexClip, nouveauNom) {
    projetActuel.pistes[indexPiste].clips[indexClip].nom = nouveauNom;
    declencherSauvegardeAuto();
    // pas de rafraichir() ici : le DOM est deja mis a jour cote pistes-ui.js
    // (recreer le DOM ferait perdre le focus en cours d'edition)
  }

  function gererDupliquerClip(indexPiste, indexClip) {
    const piste = projetActuel.pistes[indexPiste];
    const original = piste.clips[indexClip];
    const dureeOriginal = (original.decoupeFin ?? original.dureeOriginale) - (original.decoupeDebut || 0);
    const copie = {
      nom: original.nom + ' (copie)',
      audioBuffer: original.audioBuffer,
      audioBase64: original.audioBase64,
      debutDansPiste: original.debutDansPiste + dureeOriginal,
      decoupeDebut: original.decoupeDebut || 0,
      decoupeFin: original.decoupeFin,
      dureeOriginale: original.dureeOriginale,
      volume: original.volume ?? 1,
      fonduEntree: original.fonduEntree || 0,
      fonduSortie: original.fonduSortie || 0,
    };
    piste.clips.splice(indexClip + 1, 0, copie);
    PistesUI.signalerClipNouveau(indexPiste, indexClip + 1);
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
    afficherToast('Son dupliqué !');
  }

  async function gererSupprimerClip(indexPiste, indexClip) {
    const clip = projetActuel.pistes[indexPiste].clips[indexClip];
    const confirme = await demanderConfirmation(`Supprimer "${clip.nom}" de la piste ?`);
    if (!confirme) return;
    arreterLectureClipEnCours();
    projetActuel.pistes[indexPiste].clips.splice(indexClip, 1);
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
    afficherToast('Son supprimé.');
  }

  function gererDeplacerPiste(indexSource, indexCible) {
    const pistes = projetActuel.pistes;
    if (indexCible < 0 || indexCible >= pistes.length) return;
    const tmp = pistes[indexSource];
    pistes[indexSource] = pistes[indexCible];
    pistes[indexCible] = tmp;
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
  }

  async function gererSupprimerPiste(indexPiste) {
    const confirme = await demanderConfirmation('Supprimer cette piste et tout son contenu ?');
    if (!confirme) return;
    projetActuel.pistes.splice(indexPiste, 1);
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
  }

  function gererAjouterPiste() {
    if (projetActuel.pistes.length >= PistesUI.NB_PISTES_MAX) return;
    projetActuel.pistes.push({ type: 'bruitage', volume: 1, pan: 0, muette: false, clips: [] });
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
  }

  function gererBasculerMuetPiste(indexPiste) {
    const piste = projetActuel.pistes[indexPiste];
    piste.muette = !piste.muette;
    // Mise à jour en temps réel pendant la lecture
    if (lectureEnCours && noeudsGainPistes[indexPiste]) {
      noeudsGainPistes[indexPiste].gain.gain.setTargetAtTime(
        volumeEffectifPiste(piste), AudioMoteur.obtenirContexte().currentTime, 0.02);
    }
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
    afficherToast(piste.muette ? 'Piste rendue muette.' : 'Le son de la piste est rétabli.');
  }

  function gererChangerTypePiste(indexPiste, nouveauType) {
    if (!PistesUI.TYPES_PISTE[nouveauType]) return;
    projetActuel.pistes[indexPiste].type = nouveauType;
    PistesUI.rafraichir(projetActuel.pistes);
    declencherSauvegardeAuto();
  }

  function gererZoomChange() {
    PistesUI.rafraichir(projetActuel.pistes);
    // Recaler le playhead sur la même position en secondes après le changement d'échelle
    PistesUI.mettreAJourPlayhead(positionLecturePodcast, dureeTotalePodcast);
  }

  /* ===================== REGLAGES (volume / panoramique) ===================== */

  function pourcentVersTexteVolume(pct) {
    return Math.round(pct) + '%';
  }

  function pourcentVersTextePan(valeur) {
    const v = Math.round(valeur);
    if (v === 0) return 'centre';
    return v < 0 ? `gauche ${Math.abs(v)}%` : `droite ${v}%`;
  }

  function secondesVersTexteFondu(valeurSecondes) {
    return valeurSecondes <= 0 ? 'aucun' : `${valeurSecondes.toFixed(1)} s`;
  }

  /** Duree maximale de fondu proposee pour un clip : la moitie de sa duree, plafonnee a 5s. */
  function fonduMaxPourDuree(dureeClip) {
    return Math.max(0.1, Math.min(5, dureeClip / 2));
  }

  function gererOuvrirReglagesPiste(indexPiste) {
    const piste = projetActuel.pistes[indexPiste];
    contexteReglagesOuverts = { type: 'piste', indexPiste };
    const infoType = PistesUI.TYPES_PISTE[piste.type];
    titreReglages.textContent = `🎚️ Réglages de la piste ${infoType ? infoType.label : ''}`;
    ligneePanoramique.hidden = false;
    if (ligneeFondus) ligneeFondus.hidden = true; // le fondu se regle par clip, pas par piste

    const volPct = Math.round((piste.volume ?? 1) * 100);
    curseurVolume.value = volPct;
    valeurVolume.textContent = pourcentVersTexteVolume(volPct);

    const panPct = Math.round((piste.pan || 0) * 100);
    curseurPanoramique.value = panPct;
    valeurPanoramique.textContent = pourcentVersTextePan(panPct);

    modaleReglages.hidden = false;
  }

  function gererOuvrirReglagesClip(indexPiste, indexClip) {
    const clip = projetActuel.pistes[indexPiste].clips[indexClip];
    contexteReglagesOuverts = { type: 'clip', indexPiste, indexClip };
    titreReglages.textContent = `🎚️ Réglages de "${clip.nom}"`;
    ligneePanoramique.hidden = true; // le panoramique se regle par piste, pas par clip (plus simple pour un enfant)

    const volPct = Math.round((clip.volume ?? 1) * 100);
    curseurVolume.value = volPct;
    valeurVolume.textContent = pourcentVersTexteVolume(volPct);

    if (ligneeFondus && curseurFonduEntree && curseurFonduSortie) {
      ligneeFondus.hidden = false;
      const dureeClip = (clip.decoupeFin ?? clip.dureeOriginale) - (clip.decoupeDebut || 0);
      const maxFondu = fonduMaxPourDuree(dureeClip);

      curseurFonduEntree.min = 0;
      curseurFonduEntree.max = maxFondu;
      curseurFonduEntree.step = 0.1;
      curseurFonduEntree.value = Math.min(clip.fonduEntree || 0, maxFondu);
      valeurFonduEntree.textContent = secondesVersTexteFondu(parseFloat(curseurFonduEntree.value));

      curseurFonduSortie.min = 0;
      curseurFonduSortie.max = maxFondu;
      curseurFonduSortie.step = 0.1;
      curseurFonduSortie.value = Math.min(clip.fonduSortie || 0, maxFondu);
      valeurFonduSortie.textContent = secondesVersTexteFondu(parseFloat(curseurFonduSortie.value));
    }

    modaleReglages.hidden = false;
  }

  let minuteurHistoriqueCurseur = null;
  /** Comme declencherSauvegardeAuto, mais debounce aussi l'enregistrement dans
   * l'historique : utile pour les curseurs (volume, panoramique) ou chaque
   * mouvement declenche un evenement, pour ne pas creer une etape d'annulation
   * par pixel glisse. */
  function declencherSauvegardeAutoDebounceCurseur() {
    indicateurSauvegarde.classList.remove('visible');
    clearTimeout(minuteurHistoriqueCurseur);
    minuteurHistoriqueCurseur = setTimeout(() => enregistrerEtatHistorique(), 500);
    clearTimeout(minuteurSauvegardeAuto);
    minuteurSauvegardeAuto = setTimeout(async () => {
      const serialisable = projeterVersionSerialisable(projetActuel);
      const ok = await Stockage.sauvegarderProjet(serialisable);
      if (ok) {
        indicateurSauvegarde.textContent = '💾 Sauvegardé';
        indicateurSauvegarde.classList.add('visible');
      } else {
        indicateurSauvegarde.textContent = '⚠️ Sauvegarde impossible';
        indicateurSauvegarde.classList.add('visible');
      }
    }, 1500);
  }

  curseurVolume.addEventListener('input', () => {
    const pct = parseInt(curseurVolume.value, 10);
    valeurVolume.textContent = pourcentVersTexteVolume(pct);
    if (!contexteReglagesOuverts) return;
    const valeurDecimale = pct / 100;
    if (contexteReglagesOuverts.type === 'piste') {
      const indexPiste = contexteReglagesOuverts.indexPiste;
      projetActuel.pistes[indexPiste].volume = valeurDecimale;
      // Mise à jour en temps réel pendant la lecture
      if (lectureEnCours && noeudsGainPistes[indexPiste]) {
        noeudsGainPistes[indexPiste].gain.gain.setTargetAtTime(
          volumeEffectifPiste(projetActuel.pistes[indexPiste]),
          AudioMoteur.obtenirContexte().currentTime, 0.02);
      }
    } else {
      projetActuel.pistes[contexteReglagesOuverts.indexPiste].clips[contexteReglagesOuverts.indexClip].volume = valeurDecimale;
    }
    declencherSauvegardeAutoDebounceCurseur();
  });

  curseurPanoramique.addEventListener('input', () => {
    const pct = parseInt(curseurPanoramique.value, 10);
    valeurPanoramique.textContent = pourcentVersTextePan(pct);
    if (!contexteReglagesOuverts || contexteReglagesOuverts.type !== 'piste') return;
    const indexPiste = contexteReglagesOuverts.indexPiste;
    projetActuel.pistes[indexPiste].pan = pct / 100;
    // Mise à jour en temps réel pendant la lecture
    if (lectureEnCours && noeudsGainPistes[indexPiste]?.pan) {
      noeudsGainPistes[indexPiste].pan.pan.setTargetAtTime(
        pct / 100, AudioMoteur.obtenirContexte().currentTime, 0.02);
    }
    declencherSauvegardeAutoDebounceCurseur();
  });

  if (curseurFonduEntree) {
    curseurFonduEntree.addEventListener('input', () => {
      const valeur = parseFloat(curseurFonduEntree.value);
      valeurFonduEntree.textContent = secondesVersTexteFondu(valeur);
      if (!contexteReglagesOuverts || contexteReglagesOuverts.type !== 'clip') return;
      const { indexPiste, indexClip } = contexteReglagesOuverts;
      // le nouveau reglage s'applique a la prochaine lecture du clip (comme le volume de clip)
      projetActuel.pistes[indexPiste].clips[indexClip].fonduEntree = valeur;
      declencherSauvegardeAutoDebounceCurseur();
    });
  }

  if (curseurFonduSortie) {
    curseurFonduSortie.addEventListener('input', () => {
      const valeur = parseFloat(curseurFonduSortie.value);
      valeurFonduSortie.textContent = secondesVersTexteFondu(valeur);
      if (!contexteReglagesOuverts || contexteReglagesOuverts.type !== 'clip') return;
      const { indexPiste, indexClip } = contexteReglagesOuverts;
      projetActuel.pistes[indexPiste].clips[indexClip].fonduSortie = valeur;
      declencherSauvegardeAutoDebounceCurseur();
    });
  }

  function fermerModaleReglages() {
    modaleReglages.hidden = true;
    contexteReglagesOuverts = null;
  }
  btnFermerReglages.addEventListener('click', fermerModaleReglages);
  btnFermerReglagesBas.addEventListener('click', fermerModaleReglages);

  /* ===================== LECTURE (un clip seul / tout le podcast) ===================== */

  // suit la lecture en cours d'un clip individuel (un seul a la fois) :
  // { indexPiste, indexClip, source, boutonEl, texteOriginalBouton }
  let lectureClipEnCours = null;

  function arreterLectureClipEnCours() {
    if (!lectureClipEnCours) return;
    try { lectureClipEnCours.source.stop(); } catch (e) {}
    if (lectureClipEnCours.boutonEl) {
      lectureClipEnCours.boutonEl.textContent = '▶️';
      lectureClipEnCours.boutonEl.title = 'Écouter ce son';
    }
    lectureClipEnCours = null;
  }

  function jouerClipSeul(indexPiste, indexClip, boutonEl) {
    // si on reclique sur le clip deja en train de jouer : on l'arrete (toggle stop)
    if (lectureClipEnCours && lectureClipEnCours.indexPiste === indexPiste && lectureClipEnCours.indexClip === indexClip) {
      arreterLectureClipEnCours();
      return;
    }
    // un seul clip a la fois peut etre ecoute individuellement
    arreterLectureClipEnCours();

    const piste = projetActuel.pistes[indexPiste];
    const clip = piste.clips[indexClip];
    if (!clip.audioBuffer) return;
    const ctx = AudioMoteur.obtenirContexte();
    const source = ctx.createBufferSource();
    source.buffer = clip.audioBuffer;
    const gainFondu = ctx.createGain(); // dedie a l'enveloppe de fondu, independant du volume
    const gain = ctx.createGain();
    gain.gain.value = volumeEffectifPiste(piste) * (clip.volume ?? 1);
    const panNode = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panNode) {
      panNode.pan.value = piste.pan || 0;
      source.connect(gainFondu).connect(gain).connect(panNode).connect(ctx.destination);
    } else {
      source.connect(gainFondu).connect(gain).connect(ctx.destination);
    }
    const debut = clip.decoupeDebut || 0;
    const duree = (clip.decoupeFin ?? clip.dureeOriginale) - debut;
    const tempsDebutClip = ctx.currentTime;
    AudioMoteur.appliquerAutomationFondu(gainFondu, tempsDebutClip, duree, clip.fonduEntree || 0, clip.fonduSortie || 0);
    source.start(0, debut, duree);

    if (boutonEl) {
      boutonEl.textContent = '⏹️';
      boutonEl.title = 'Arrêter';
    }
    lectureClipEnCours = { indexPiste, indexClip, source, boutonEl };

    source.onended = () => {
      // si le clip est arrive naturellement a sa fin (pas un stop manuel)
      if (lectureClipEnCours && lectureClipEnCours.source === source) {
        if (boutonEl) {
          boutonEl.textContent = '▶️';
          boutonEl.title = 'Écouter ce son';
        }
        lectureClipEnCours = null;
      }
    };
  }

  // position de lecture du podcast (en secondes), conservee meme en pause,
  // pour permettre une vraie reprise (pas juste un redemarrage a 0)
  let positionLecturePodcast = 0;
  let positionDebutLecture = 0; // position mémorisée au lancement — Stop y revient
  let dureeTotalePodcast = 0;
  let enPause = false;

  function arreterLectureGlobale(remettreAuDebut = true) {
    sourcesEnCours.forEach(s => { try { s.stop(); } catch (e) {} });
    sourcesEnCours = [];
    noeudsGainPistes = [];
    lectureEnCours = false;
    enPause = false;
    btnJouerTout.textContent = '▶️';
    btnJouerTout.title = 'Écouter tout le podcast';
    if (animationProgression) {
      cancelAnimationFrame(animationProgression);
      animationProgression = null;
    }
    if (remettreAuDebut) {
      positionLecturePodcast = 0;
      mettreAJourAffichageProgression(0);
      PistesUI.cacherPlayhead();
    }
  }

  function mettreEnPauseLectureGlobale() {
    if (!lectureEnCours) return;
    sourcesEnCours.forEach(s => { try { s.stop(); } catch (e) {} });
    sourcesEnCours = [];
    lectureEnCours = false;
    enPause = true;
    btnJouerTout.textContent = '▶️';
    btnJouerTout.title = 'Reprendre la lecture';
    if (animationProgression) {
      cancelAnimationFrame(animationProgression);
      animationProgression = null;
    }
    // positionLecturePodcast a deja ete mise a jour par la derniere frame d'animation
  }

  function mettreAJourAffichageProgression(positionSecondes) {
    const ratio = dureeTotalePodcast > 0 ? Math.min(1, positionSecondes / dureeTotalePodcast) : 0;
    barreProgressionRemplissage.style.width = (ratio * 100) + '%';
    barreProgressionCurseur.style.left = (ratio * 100) + '%';
    tempsAffiche.textContent = PistesUI.formaterDuree(positionSecondes) + ' / ' + PistesUI.formaterDuree(dureeTotalePodcast);
  }

  /** Demarre (ou reprend) la lecture du podcast a partir de positionLecturePodcast. */
  function demarrerLectureDepuisPosition() {
    positionDebutLecture = positionLecturePodcast; // mémoriser pour le Stop
    const ctx = AudioMoteur.obtenirContexte();
    dureeTotalePodcast = ExportMp3.calculerDureeTotale(projetActuel.pistes);
    if (dureeTotalePodcast <= 0) {
      afficherToast('Le podcast est vide pour le moment.');
      return;
    }
    if (positionLecturePodcast >= dureeTotalePodcast) {
      positionLecturePodcast = 0;
    }

    arreterLectureClipEnCours(); // un seul son a la fois dans toute l'appli

    sourcesEnCours = [];
    noeudsGainPistes = [];
    const tempsDebutLecture = ctx.currentTime - positionLecturePodcast;

    for (let iPiste = 0; iPiste < projetActuel.pistes.length; iPiste++) {
      const piste = projetActuel.pistes[iPiste];
      const gainPiste = ctx.createGain();
      gainPiste.gain.value = volumeEffectifPiste(piste);
      let panNode = null;
      let noeudSortiePiste = gainPiste;
      if (ctx.createStereoPanner) {
        panNode = ctx.createStereoPanner();
        panNode.pan.value = piste.pan || 0;
        gainPiste.connect(panNode);
        noeudSortiePiste = panNode;
      }
      noeudSortiePiste.connect(ctx.destination);
      // Stocker les nœuds pour modification en temps réel
      noeudsGainPistes[iPiste] = { gain: gainPiste, pan: panNode };

      for (const clip of piste.clips) {
        if (!clip.audioBuffer) continue;
        const debutDecoupe = clip.decoupeDebut || 0;
        const dureeAJouer = (clip.decoupeFin ?? clip.dureeOriginale) - debutDecoupe;
        const finClipDansPodcast = clip.debutDansPiste + dureeAJouer;

        // si le clip est entierement avant la position de reprise, on l'ignore
        if (finClipDansPodcast <= positionLecturePodcast) continue;

        const source = ctx.createBufferSource();
        source.buffer = clip.audioBuffer;
        const gainFonduClip = ctx.createGain(); // dedie a l'enveloppe de fondu, independant du volume
        const gainClip = ctx.createGain();
        gainClip.gain.value = clip.volume ?? 1;
        source.connect(gainFonduClip).connect(gainClip).connect(gainPiste);

        // Ancrage de l'automation de fondu sur le debut "logique" du clip dans
        // la timeline du contexte audio (meme formule dans les deux branches
        // ci-dessous), pour que la courbe de fondu soit correcte meme quand on
        // reprend la lecture au milieu du clip.
        const tempsLogiqueDebutClip = tempsDebutLecture + clip.debutDansPiste;
        AudioMoteur.appliquerAutomationFondu(gainFonduClip, tempsLogiqueDebutClip, dureeAJouer, clip.fonduEntree || 0, clip.fonduSortie || 0);

        if (clip.debutDansPiste >= positionLecturePodcast) {
          // le clip commence apres la position de reprise : demarrage normal, plus tard
          source.start(tempsDebutLecture + clip.debutDansPiste, debutDecoupe, dureeAJouer);
        } else {
          // on est en train de "rentrer" dans ce clip : on reprend au milieu
          const decalageDansLeClip = positionLecturePodcast - clip.debutDansPiste;
          source.start(ctx.currentTime, debutDecoupe + decalageDansLeClip, dureeAJouer - decalageDansLeClip);
        }
        sourcesEnCours.push(source);
      }
    }

    lectureEnCours = true;
    enPause = false;
    btnJouerTout.textContent = '⏸️';
    btnJouerTout.title = 'Mettre en pause';

    function animer() {
      const ecoule = ctx.currentTime - tempsDebutLecture;
      positionLecturePodcast = Math.min(ecoule, dureeTotalePodcast);
      mettreAJourAffichageProgression(positionLecturePodcast);
      PistesUI.mettreAJourPlayhead(positionLecturePodcast, dureeTotalePodcast);
      if (ecoule >= dureeTotalePodcast) {
        arreterLectureGlobale(true);
        return;
      }
      animationProgression = requestAnimationFrame(animer);
    }
    animationProgression = requestAnimationFrame(animer);
  }

  function basculerLecturePodcast() {
    if (lectureEnCours) {
      mettreEnPauseLectureGlobale();
    } else {
      demarrerLectureDepuisPosition();
    }
  }

  /** Deplace la position de lecture (curseur cliquable/glissable), que la lecture soit en cours ou non. */
  function deplacerPositionLecture(ratio) {
    dureeTotalePodcast = ExportMp3.calculerDureeTotale(projetActuel.pistes);
    if (dureeTotalePodcast <= 0) return;
    const etaitEnLecture = lectureEnCours;
    if (lectureEnCours) {
      sourcesEnCours.forEach(s => { try { s.stop(); } catch (e) {} });
      sourcesEnCours = [];
      if (animationProgression) { cancelAnimationFrame(animationProgression); animationProgression = null; }
      lectureEnCours = false;
    }
    positionLecturePodcast = Math.max(0, Math.min(1, ratio)) * dureeTotalePodcast;
    mettreAJourAffichageProgression(positionLecturePodcast);
    // Synchroniser le playhead sur les pistes
    PistesUI.mettreAJourPlayhead(positionLecturePodcast, dureeTotalePodcast);
    if (etaitEnLecture) {
      demarrerLectureDepuisPosition();
    }
  }

  btnJouerTout.addEventListener('click', basculerLecturePodcast);

  // ⏮ Retour au début (position 0) + scroll à gauche
  btnStop.addEventListener('click', () => {
    arreterLectureGlobale(false);
    positionLecturePodcast = 0;
    mettreAJourAffichageProgression(0);
    PistesUI.cacherPlayhead();
    PistesUI.scrollerAuDebut();
  });

  // ⏹ Stop : arrêter et revenir à la position où la lecture avait été lancée
  btnStopper.addEventListener('click', () => {
    const posRetour = positionDebutLecture;
    arreterLectureGlobale(false);
    positionLecturePodcast = posRetour;
    mettreAJourAffichageProgression(posRetour);
    if (dureeTotalePodcast > 0) {
      PistesUI.mettreAJourPlayhead(posRetour, dureeTotalePodcast);
    }
  });

  // ◀ Reculer / ▶ Avancer de PAS_DEPLACEMENT secondes
  const PAS_DEPLACEMENT = 0.5; // 500 ms par clic/touche
  function deplacerCurseur(delta) {
    if (dureeTotalePodcast <= 0) {
      dureeTotalePodcast = ExportMp3.calculerDureeTotale(projetActuel.pistes);
    }
    const nouvellePos = Math.max(0, Math.min(dureeTotalePodcast, positionLecturePodcast + delta));
    const etaitEnLecture = lectureEnCours;
    if (lectureEnCours) {
      sourcesEnCours.forEach(s => { try { s.stop(); } catch (e) {} });
      sourcesEnCours = [];
      if (animationProgression) { cancelAnimationFrame(animationProgression); animationProgression = null; }
      lectureEnCours = false;
    }
    positionLecturePodcast = nouvellePos;
    mettreAJourAffichageProgression(nouvellePos);
    PistesUI.mettreAJourPlayhead(nouvellePos, Math.max(dureeTotalePodcast, 1));
    if (etaitEnLecture) demarrerLectureDepuisPosition();
  }
  btnReculer.addEventListener('click', () => deplacerCurseur(-PAS_DEPLACEMENT));
  btnAvancer.addEventListener('click', () => deplacerCurseur(PAS_DEPLACEMENT));

  // barre de progression cliquable ET glissable pour se positionner dans le podcast
  let enGlissementBarreProgression = false;

  function calculerRatioDepuisEvenement(e) {
    const rect = barreProgression.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  barreProgressionConteneur.addEventListener('mousedown', (e) => {
    enGlissementBarreProgression = true;
    deplacerPositionLecture(calculerRatioDepuisEvenement(e));
  });
  barreProgressionConteneur.addEventListener('touchstart', (e) => {
    enGlissementBarreProgression = true;
    deplacerPositionLecture(calculerRatioDepuisEvenement(e));
  }, { passive: true });
  window.addEventListener('mousemove', (e) => {
    if (!enGlissementBarreProgression) return;
    deplacerPositionLecture(calculerRatioDepuisEvenement(e));
  });
  window.addEventListener('touchmove', (e) => {
    if (!enGlissementBarreProgression) return;
    deplacerPositionLecture(calculerRatioDepuisEvenement(e));
  }, { passive: true });
  window.addEventListener('mouseup', () => { enGlissementBarreProgression = false; });
  window.addEventListener('touchend', () => { enGlissementBarreProgression = false; });

  /* ===================== EXPORT MP3 ===================== */

  btnExporter.addEventListener('click', async () => {
    btnExporter.disabled = true;
    const texteOriginal = btnExporter.innerHTML;
    btnExporter.innerHTML = '<span class="icone">⏳</span> Préparation...';
    try {
      const blob = await ExportMp3.exporterPodcast(projetActuel.pistes, (progres) => {
        btnExporter.innerHTML = `<span class="icone">⏳</span> ${Math.round(progres * 100)}%`;
      });
      ExportMp3.telechargerBlob(blob, projetActuel.nom || 'mon-podcast');
      afficherToast('Podcast exporté en mp3 !');
    } catch (e) {
      console.error(e);
      afficherToast(e.message || "Erreur pendant l'export.");
    } finally {
      btnExporter.disabled = false;
      btnExporter.innerHTML = texteOriginal;
    }
  });

  /* ===================== SAUVEGARDE / IMPORT FICHIER .podcast ===================== */

  btnSauvegarder.addEventListener('click', () => {
    const serialisable = projeterVersionSerialisable(projetActuel);
    Stockage.telechargerFichierProjet(serialisable);
    afficherToast('Fichier .podcast téléchargé !');
  });

  btnImporterProjet.addEventListener('click', () => inputImportFichier.click());

  inputImportFichier.addEventListener('change', async (e) => {
    const fichier = e.target.files[0];
    if (!fichier) return;
    try {
      const projet = await Stockage.lireFichierProjet(fichier);
      await ouvrirProjetExistant(projet);
      afficherToast('Podcast chargé !');
    } catch (err) {
      afficherToast(err.message);
    }
    inputImportFichier.value = '';
  });

  /* ===================== NAVIGATION ===================== */

  btnNouveauProjet.addEventListener('click', demarrerNouveauProjet);
  btnAccueil.addEventListener('click', async () => {
    const confirme = await demanderConfirmation('Retourner à l\'accueil ? Ton travail est déjà sauvegardé automatiquement sur cet ordinateur.');
    if (confirme) retournerAccueil();
  });

  /* ===================== INITIALISATION ===================== */

  function initialiser() {
    construireBanqueSonsUI();
    rafraichirListeProjetsRecents();

    PistesUI.initialiser({
      onAjouterPiste: gererAjouterPiste,
      onDemanderSupprimerPiste: gererSupprimerPiste,
      onDemanderSupprimerClip: gererSupprimerClip,
      onJouerClip: jouerClipSeul,
      onDeplacerClip: gererDeplacerClip,
      onDeplacerClipVersAutrePiste: gererDeplacerClipVersAutrePiste,
      onRenommerClip: gererRenommerClip,
      onDupliquerClip: gererDupliquerClip,
      onBasculerMuetPiste: gererBasculerMuetPiste,
      onChangerTypePiste: gererChangerTypePiste,
      onOuvrirDecoupage: gererOuvrirDecoupage,
      onDeposerSonBanque: gererDepotSonBanque,
      onDeplacerPiste: gererDeplacerPiste,
      onSeekLecture: (posSecondes) => {
        // Calculer la durée si pas encore fait (avant le premier Play)
        if (dureeTotalePodcast <= 0) {
          dureeTotalePodcast = ExportMp3.calculerDureeTotale(projetActuel.pistes);
        }
        const etaitEnLecture = lectureEnCours;
        arreterLectureGlobale(false);
        positionLecturePodcast = Math.max(0, posSecondes);
        mettreAJourAffichageProgression(positionLecturePodcast);
        PistesUI.mettreAJourPlayhead(positionLecturePodcast, Math.max(dureeTotalePodcast, 1));
        if (etaitEnLecture) demarrerLectureDepuisPosition();
      },
      onObtenirDuree: () => dureeTotalePodcast,
      onOuvrirReglagesPiste: gererOuvrirReglagesPiste,
      onOuvrirReglagesClip: gererOuvrirReglagesClip,
      onZoomChange: gererZoomChange,
    });
  }

  return { initialiser };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.initialiser();
  initialiserAide();
});

function initialiserAide() {
  const btnAide = document.getElementById('btn-aide');
  const panneau = document.getElementById('panneau-aide');
  const btnFermer = document.getElementById('btn-fermer-aide');

  if (!btnAide || !panneau) return;

  btnAide.addEventListener('click', () => { panneau.hidden = !panneau.hidden; });
  btnFermer.addEventListener('click', () => { panneau.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panneau.hidden) panneau.hidden = true;
  });

  // Accordéon
  panneau.querySelectorAll('.aide-section-titre').forEach(titre => {
    titre.addEventListener('click', () => {
      const cible = document.getElementById(titre.dataset.cible);
      if (!cible) return;
      const etaitOuvert = !cible.hidden;
      panneau.querySelectorAll('.aide-section-contenu').forEach(c => { c.hidden = true; });
      panneau.querySelectorAll('.aide-section-titre').forEach(t => t.classList.remove('ouvert'));
      if (!etaitOuvert) {
        cible.hidden = false;
        titre.classList.add('ouvert');
      }
    });
  });

  // Tooltips enrichis
  const tooltips = {
    'btn-enregistrer-rapide': 'Enregistrer ta voix\nUn micro est nécessaire.\nS\'ajoute à la première piste Voix.',
    'btn-ajouter-son':        'Importer un fichier audio\n(MP3 ou WAV) depuis\nton ordinateur.',
    'btn-ouvrir-banque':      'Bibliothèque de sons\nJingles, tapis, bruitages.\nGlisse un son sur une piste\nou clique Ajouter.',
    'btn-sauvegarder':        'Sauvegarder le projet\nTélécharge un fichier .podcast\npour transférer ou sécuriser.',
    'btn-exporter':           'Exporter en MP3\nMixe toutes les pistes\net télécharge le fichier audio.',
    'btn-zoom-plus':          'Agrandir la vue\nClips plus larges → édition plus précise.',
    'btn-zoom-moins':         'Réduire la vue\nVoir plus de contenu sur l\'écran.',
    'btn-annuler':            'Annuler (Ctrl+Z)',
    'btn-refaire':            'Rétablir (Ctrl+Y)',
    'btn-stop':               'Revenir au début\nRemet le curseur à 0.',
    'btn-jouer-tout':         'Écouter / Pause\nLancer ou mettre en pause\nla lecture du podcast.',
    'btn-aide':               'Aide et documentation',
  };
  Object.entries(tooltips).forEach(([id, texte]) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('data-tooltip', texte);
  });
}