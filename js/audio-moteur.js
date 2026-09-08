/* ===================================================================
   audio-moteur.js
   Fonctions bas niveau autour de Web Audio API :
   - decoder un fichier audio en AudioBuffer
   - convertir AudioBuffer <-> base64 (pour la sauvegarde .podcast)
   - lire un AudioBuffer (avec debut/fin de decoupe)
   - appliquer des fondus d'entree/de sortie
   - jouer le mixage complet de toutes les pistes
   =================================================================== */

const AudioMoteur = (() => {

  let contexteAudio = null;

  function obtenirContexte() {
    if (!contexteAudio) {
      contexteAudio = new (window.AudioContext || window.webkitAudioContext)();
    }
    return contexteAudio;
  }

  async function decoderFichier(fichierOuArrayBuffer) {
    const ctx = obtenirContexte();
    let arrayBuffer;
    if (fichierOuArrayBuffer instanceof ArrayBuffer) {
      arrayBuffer = fichierOuArrayBuffer;
    } else {
      arrayBuffer = await fichierOuArrayBuffer.arrayBuffer();
    }
    // decodeAudioData "consomme" le buffer, on en garde une copie au cas ou
    const copie = arrayBuffer.slice(0);
    return ctx.decodeAudioData(copie);
  }

  /**
   * Convertit un AudioBuffer en WAV (Float -> PCM 16 bits), puis en base64.
   * On stocke en WAV brut plutot qu'en re-encodant en mp3 a chaque sauvegarde
   * intermediaire : plus rapide, pas de perte de qualite cumulative, et
   * lamejs n'est utilise qu'une seule fois, a l'export final.
   */
  function audioBufferVersBase64(audioBuffer) {
    const wavArrayBuffer = audioBufferVersWav(audioBuffer);
    return arrayBufferVersBase64(wavArrayBuffer);
  }

  async function base64VersAudioBuffer(base64) {
    const arrayBuffer = base64VersArrayBuffer(base64);
    return decoderFichier(arrayBuffer);
  }

  function arrayBufferVersBase64(arrayBuffer) {
    const octets = new Uint8Array(arrayBuffer);
    const taillePaquet = 0x8000;
    let resultat = '';
    for (let i = 0; i < octets.length; i += taillePaquet) {
      const paquet = octets.subarray(i, i + taillePaquet);
      resultat += String.fromCharCode.apply(null, paquet);
    }
    return btoa(resultat);
  }

  function base64VersArrayBuffer(base64) {
    const binaire = atob(base64);
    const octets = new Uint8Array(binaire.length);
    for (let i = 0; i < binaire.length; i++) {
      octets[i] = binaire.charCodeAt(i);
    }
    return octets.buffer;
  }

  /** Encode un AudioBuffer en fichier WAV (PCM 16 bits) sous forme d'ArrayBuffer. */
  function audioBufferVersWav(audioBuffer) {
    const nbCanaux = audioBuffer.numberOfChannels;
    const frequence = audioBuffer.sampleRate;
    const nbEchantillons = audioBuffer.length;
    const octetsParEchantillon = 2;
    const tailleData = nbEchantillons * nbCanaux * octetsParEchantillon;
    const buffer = new ArrayBuffer(44 + tailleData);
    const vue = new DataView(buffer);

    function ecrireChaine(decalage, chaine) {
      for (let i = 0; i < chaine.length; i++) {
        vue.setUint8(decalage + i, chaine.charCodeAt(i));
      }
    }

    ecrireChaine(0, 'RIFF');
    vue.setUint32(4, 36 + tailleData, true);
    ecrireChaine(8, 'WAVE');
    ecrireChaine(12, 'fmt ');
    vue.setUint32(16, 16, true);
    vue.setUint16(20, 1, true); // PCM
    vue.setUint16(22, nbCanaux, true);
    vue.setUint32(24, frequence, true);
    vue.setUint32(28, frequence * nbCanaux * octetsParEchantillon, true);
    vue.setUint16(32, nbCanaux * octetsParEchantillon, true);
    vue.setUint16(34, 16, true);
    ecrireChaine(36, 'data');
    vue.setUint32(40, tailleData, true);

    const canaux = [];
    for (let c = 0; c < nbCanaux; c++) canaux.push(audioBuffer.getChannelData(c));

    let decalage = 44;
    for (let i = 0; i < nbEchantillons; i++) {
      for (let c = 0; c < nbCanaux; c++) {
        let echantillon = Math.max(-1, Math.min(1, canaux[c][i]));
        echantillon = echantillon < 0 ? echantillon * 0x8000 : echantillon * 0x7FFF;
        vue.setInt16(decalage, echantillon, true);
        decalage += 2;
      }
    }

    return buffer;
  }

  /**
   * Decoupe un AudioBuffer entre deux instants (en secondes) et retourne
   * un nouvel AudioBuffer independant.
   */
  function decouperAudioBuffer(audioBuffer, debut, fin) {
    const ctx = obtenirContexte();
    const frequence = audioBuffer.sampleRate;
    const debutEch = Math.max(0, Math.floor(debut * frequence));
    const finEch = Math.min(audioBuffer.length, Math.floor(fin * frequence));
    const longueur = Math.max(1, finEch - debutEch);

    const nouveauBuffer = ctx.createBuffer(audioBuffer.numberOfChannels, longueur, frequence);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const donneesSource = audioBuffer.getChannelData(c);
      const nouvellesDonnees = nouveauBuffer.getChannelData(c);
      for (let i = 0; i < longueur; i++) {
        nouvellesDonnees[i] = donneesSource[debutEch + i] || 0;
      }
    }
    return nouveauBuffer;
  }

  /**
   * Applique un fondu d'entree et/ou de sortie a un AudioBuffer, et retourne
   * un nouvel AudioBuffer independant (ne modifie pas le buffer source).
   *
   * dureeFonduEntree / dureeFonduSortie : duree en secondes (0 = pas de fondu).
   * Courbe en demi-cosinus ("fondu a puissance egale") : plus naturelle a
   * l'oreille qu'un fondu lineaire, sans variation brusque de volume percu
   * au debut/a la fin de la rampe.
   *
   * Si les deux fondus se chevauchent (cas d'un echantillon tres court avec
   * des durees de fondu trop grandes), le gain applique est le minimum des
   * deux courbes a chaque echantillon, pour eviter toute remontee de volume
   * au milieu du fondu.
   */
  function appliquerFondu(audioBuffer, dureeFonduEntree = 0, dureeFonduSortie = 0) {
    const ctx = obtenirContexte();
    const frequence = audioBuffer.sampleRate;
    const nbCanaux = audioBuffer.numberOfChannels;
    const nbEchantillons = audioBuffer.length;

    const echFonduEntree = Math.max(0, Math.min(nbEchantillons, Math.round(dureeFonduEntree * frequence)));
    const echFonduSortie = Math.max(0, Math.min(nbEchantillons, Math.round(dureeFonduSortie * frequence)));

    // Rien a faire : on retourne quand meme une copie independante, par
    // coherence avec le reste de l'API (decouperAudioBuffer retourne aussi
    // toujours un nouveau buffer).
    if (echFonduEntree === 0 && echFonduSortie === 0) {
      return decouperAudioBuffer(audioBuffer, 0, audioBuffer.duration);
    }

    const nouveauBuffer = ctx.createBuffer(nbCanaux, nbEchantillons, frequence);

    for (let c = 0; c < nbCanaux; c++) {
      const source = audioBuffer.getChannelData(c);
      const dest = nouveauBuffer.getChannelData(c);
      for (let i = 0; i < nbEchantillons; i++) {
        let gain = 1;

        if (echFonduEntree > 0 && i < echFonduEntree) {
          gain = 0.5 * (1 - Math.cos(Math.PI * (i / echFonduEntree)));
        }

        if (echFonduSortie > 0) {
          const distanceFin = nbEchantillons - 1 - i;
          if (distanceFin < echFonduSortie) {
            const gainSortie = 0.5 * (1 - Math.cos(Math.PI * (distanceFin / echFonduSortie)));
            gain = Math.min(gain, gainSortie);
          }
        }

        dest[i] = source[i] * gain;
      }
    }

    return nouveauBuffer;
  }

  /**
   * Calcule le gain (0 a 1) a appliquer a l'instant t (en secondes, relatif
   * au debut du clip) pour un clip de duree dureeClip avec des fondus
   * d'entree/de sortie donnes. Formule "source de verite" partagee entre
   * la preview temps reel (genererCourbeGainClip / appliquerAutomationFondu
   * ci-dessous) et l'export final (export-mp3.js), pour que le rendu
   * ecoute pendant l'edition corresponde exactement au mp3 exporte.
   * Meme courbe en demi-cosinus que appliquerFondu ; en cas de chevauchement
   * (fondus trop longs pour un clip tres court), on prend le minimum des
   * deux courbes, pour eviter toute remontee de volume au milieu.
   */
  function calculerGainFondu(t, dureeClip, dureeFonduEntree = 0, dureeFonduSortie = 0) {
    const fEntree = Math.max(0, Math.min(dureeFonduEntree, dureeClip));
    const fSortie = Math.max(0, Math.min(dureeFonduSortie, dureeClip));
    let gain = 1;

    if (fEntree > 0 && t < fEntree) {
      gain = 0.5 * (1 - Math.cos(Math.PI * (t / fEntree)));
    }
    if (fSortie > 0) {
      const distanceFin = dureeClip - t;
      if (distanceFin < fSortie) {
        const gainSortie = 0.5 * (1 - Math.cos(Math.PI * (distanceFin / fSortie)));
        gain = Math.min(gain, gainSortie);
      }
    }
    return gain;
  }

  /**
   * Echantillonne calculerGainFondu() sur toute la duree d'un clip, pour
   * fournir une courbe utilisable avec AudioParam.setValueCurveAtTime().
   * resolution : points par seconde (50 est largement suffisant pour une
   * automation de volume, l'oreille ne percoit pas les paliers a cette finesse).
   */
  function genererCourbeGainClip(dureeClip, dureeFonduEntree = 0, dureeFonduSortie = 0, resolution = 50) {
    const nbPoints = Math.max(2, Math.round(dureeClip * resolution));
    const courbe = new Float32Array(nbPoints);
    for (let p = 0; p < nbPoints; p++) {
      const t = (p / (nbPoints - 1)) * dureeClip;
      courbe[p] = calculerGainFondu(t, dureeClip, dureeFonduEntree, dureeFonduSortie);
    }
    return courbe;
  }

  /**
   * Programme un GainNode pour appliquer les fondus d'un clip pendant sa
   * lecture, sans toucher a l'AudioBuffer source (non destructif, modifiable
   * et supprimable a volonte en rappelant cette fonction avec d'autres valeurs).
   * tempsDebut : ctx.currentTime auquel le clip commence a jouer.
   * dureeClip : duree du clip apres decoupe (decoupeFin - decoupeDebut).
   */
  function appliquerAutomationFondu(gainNode, tempsDebut, dureeClip, dureeFonduEntree = 0, dureeFonduSortie = 0) {
    gainNode.gain.cancelScheduledValues(tempsDebut);
    if (dureeClip <= 0) return;
    if (dureeFonduEntree <= 0 && dureeFonduSortie <= 0) {
      gainNode.gain.setValueAtTime(1, tempsDebut);
      return;
    }
    const courbe = genererCourbeGainClip(dureeClip, dureeFonduEntree, dureeFonduSortie);
    gainNode.gain.setValueCurveAtTime(courbe, tempsDebut, dureeClip);
  }

  return {
    obtenirContexte,
    decoderFichier,
    audioBufferVersBase64,
    base64VersAudioBuffer,
    decouperAudioBuffer,
    appliquerFondu,
    calculerGainFondu,
    genererCourbeGainClip,
    appliquerAutomationFondu,
  };
})();
