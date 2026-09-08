/* ===================================================================
   enregistrement.js
   Gere l'enregistrement de la voix au micro (MediaRecorder), avec
   un visualiseur simple (barres qui bougent), un chronometre, et un
   selecteur de peripherique d'entree (utile quand plusieurs micros/
   cartes son sont branches : sans ca, le navigateur utilise toujours
   le micro par defaut du systeme, meme si un autre est branche).
   =================================================================== */

const Enregistrement = (() => {

  let resoudrePromesse = null;
  let flowMicro = null;
  let enregistreur = null;
  let morceaux = [];
  let enregistrementEnCours = false;
  let tempsDebut = 0;
  let intervalleChrono = null;
  let analyseur = null;
  let animationVisu = null;

  const modale = document.getElementById('modale-enregistrement');
  const btnDemarrer = document.getElementById('btn-demarrer-enreg');
  const chrono = document.getElementById('chrono-enregistrement');
  const statut = document.getElementById('statut-enregistrement');
  const visualiseur = document.getElementById('visualiseur-micro');
  const btnFermer = document.getElementById('btn-fermer-enregistrement');
  const selectMicro = document.getElementById('select-micro');

  // creation des barres du visualiseur (une seule fois)
  const NB_BARRES = 24;
  const barres = [];
  for (let i = 0; i < NB_BARRES; i++) {
    const barre = document.createElement('div');
    barre.className = 'barre-visu';
    barre.style.height = '4px';
    visualiseur.appendChild(barre);
    barres.push(barre);
  }

  function formaterTemps(secondes) {
    const m = Math.floor(secondes / 60);
    const s = Math.floor(secondes % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function animerVisualiseur() {
    if (!analyseur) return;
    const donnees = new Uint8Array(analyseur.frequencyBinCount);
    analyseur.getByteFrequencyData(donnees);
    const pas = Math.floor(donnees.length / NB_BARRES);
    for (let i = 0; i < NB_BARRES; i++) {
      const valeur = donnees[i * pas] || 0;
      const hauteur = Math.max(4, (valeur / 255) * 70);
      barres[i].style.height = hauteur + 'px';
    }
    animationVisu = requestAnimationFrame(animerVisualiseur);
  }

  function reinitialiserVisualiseur() {
    barres.forEach(b => b.style.height = '4px');
  }

  /**
   * Remplit le menu deroulant avec les peripheriques d'entree audio
   * disponibles. Les navigateurs ne donnent les vrais noms des
   * peripheriques (labels) qu'une fois une autorisation micro deja
   * accordee au moins une fois : sans ca, on ne verrait que des noms
   * generiques ("Microphone 1", etc). C'est pour ca qu'on demande une
   * autorisation initiale des l'ouverture de la modale (voir ouvrir()).
   */
  async function rafraichirListeMicros() {
    if (!selectMicro) return;
    try {
      const peripheriques = await navigator.mediaDevices.enumerateDevices();
      const entrees = peripheriques.filter(p => p.kind === 'audioinput');

      const idPrecedent = selectMicro.value;
      selectMicro.innerHTML = '';

      if (entrees.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Aucun micro détecté';
        selectMicro.appendChild(option);
        selectMicro.disabled = true;
        return;
      }

      selectMicro.disabled = false;
      entrees.forEach((peripherique, i) => {
        const option = document.createElement('option');
        option.value = peripherique.deviceId;
        option.textContent = peripherique.label || `Micro ${i + 1}`;
        selectMicro.appendChild(option);
      });

      // on essaie de re-selectionner le meme peripherique qu'avant
      // (utile si la liste se rafraichit pendant que la modale est ouverte)
      if (idPrecedent && entrees.some(p => p.deviceId === idPrecedent)) {
        selectMicro.value = idPrecedent;
      }
    } catch (e) {
      console.error('Impossible de lister les peripheriques audio', e);
    }
  }

  // Si l'utilisateur branche/debranche un micro pendant que la modale
  // est ouverte, la liste se met a jour automatiquement.
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', rafraichirListeMicros);
  }

  /**
   * Demande une autorisation micro juste pour debloquer les noms des
   * peripheriques dans enumerateDevices(), puis coupe immediatement ce
   * flux temporaire (l'enregistrement reel ouvrira son propre flux avec
   * le peripherique choisi par l'utilisateur).
   */
  async function debloquerLabelsPeripheriques() {
    try {
      const flowTemporaire = await navigator.mediaDevices.getUserMedia({ audio: true });
      flowTemporaire.getTracks().forEach(t => t.stop());
    } catch (e) {
      // l'utilisateur a peut-etre refuse ou aucun micro n'est branche :
      // pas grave, on tente quand meme de lister ce qui est disponible
    }
    await rafraichirListeMicros();
  }

  async function demarrerEnregistrement() {
    const contraintesAudio = selectMicro && selectMicro.value
      ? { deviceId: { exact: selectMicro.value } }
      : true;

    try {
      flowMicro = await navigator.mediaDevices.getUserMedia({ audio: contraintesAudio });
    } catch (e) {
      statut.textContent = "Impossible d'accéder au micro. Vérifie les autorisations de ton navigateur.";
      return;
    }

    const ctx = AudioMoteur.obtenirContexte();
    const source = ctx.createMediaStreamSource(flowMicro);
    analyseur = ctx.createAnalyser();
    analyseur.fftSize = 256;
    source.connect(analyseur);
    animerVisualiseur();

    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    enregistreur = mimeType ? new MediaRecorder(flowMicro, { mimeType }) : new MediaRecorder(flowMicro);
    morceaux = [];

    enregistreur.ondataavailable = (e) => { if (e.data.size > 0) morceaux.push(e.data); };

    enregistreur.start();
    enregistrementEnCours = true;
    tempsDebut = Date.now();
    statut.textContent = 'Enregistrement en cours... clique pour arrêter';
    btnDemarrer.textContent = '⏹️';
    btnDemarrer.classList.add('actif-enregistrement');
    if (selectMicro) selectMicro.disabled = true; // pas de changement de micro en plein enregistrement

    intervalleChrono = setInterval(() => {
      const ecoule = (Date.now() - tempsDebut) / 1000;
      chrono.textContent = formaterTemps(ecoule);
    }, 200);
  }

  function arreterEnregistrement() {
    return new Promise((resolve) => {
      if (!enregistreur || !enregistrementEnCours) { resolve(null); return; }

      enregistreur.onstop = async () => {
        clearInterval(intervalleChrono);
        if (animationVisu) cancelAnimationFrame(animationVisu);
        reinitialiserVisualiseur();
        if (flowMicro) flowMicro.getTracks().forEach(t => t.stop());
        if (selectMicro) selectMicro.disabled = false;

        const blob = new Blob(morceaux, { type: morceaux[0]?.type || 'audio/webm' });
        if (blob.size < 500) {
          // enregistrement quasi vide (clique accidentel tres bref)
          resolve(null);
          return;
        }
        try {
          const audioBuffer = await AudioMoteur.decoderFichier(blob);
          resolve(audioBuffer);
        } catch (e) {
          console.error('Erreur decodage enregistrement', e);
          resolve(null);
        }
      };

      enregistreur.stop();
      enregistrementEnCours = false;
      btnDemarrer.textContent = '⏺️';
      btnDemarrer.classList.remove('actif-enregistrement');
      statut.textContent = 'Traitement en cours...';
    });
  }

  btnDemarrer.addEventListener('click', async () => {
    if (!enregistrementEnCours) {
      await demarrerEnregistrement();
    } else {
      const audioBuffer = await arreterEnregistrement();
      fermer(audioBuffer);
    }
  });

  btnFermer.addEventListener('click', async () => {
    if (enregistrementEnCours) {
      await arreterEnregistrement();
    }
    fermer(null);
  });

  function fermer(resultat) {
    modale.hidden = true;
    chrono.textContent = '0:00';
    statut.textContent = 'Clique pour commencer à parler';
    if (resoudrePromesse) {
      resoudrePromesse(resultat);
      resoudrePromesse = null;
    }
  }

  /** Ouvre la modale d'enregistrement. Retourne une Promise<AudioBuffer|null>. */
  function ouvrir() {
    modale.hidden = false;
    debloquerLabelsPeripheriques(); // peuple le selecteur de micro des l'ouverture
    return new Promise((resolve) => {
      resoudrePromesse = resolve;
    });
  }

  return { ouvrir };
})();
