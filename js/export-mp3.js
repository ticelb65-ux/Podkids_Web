/* ===================================================================
   export-mp3.js
   Melange (mixe) toutes les pistes du projet en un seul AudioBuffer,
   puis encode ce resultat en mp3 grace a lamejs (charge globalement
   via lib/lame.min.js).
   =================================================================== */

const ExportMp3 = (() => {

  const FREQUENCE_EXPORT = 44100;

  /**
   * Calcule la duree totale du podcast (position la plus tardive de
   * tous les clips de toutes les pistes).
   */
  function calculerDureeTotale(pistes) {
    let duree = 0;
    for (const piste of pistes) {
      for (const clip of piste.clips) {
        const finClip = clip.debutDansPiste + (clip.decoupeFin - clip.decoupeDebut);
        if (finClip > duree) duree = finClip;
      }
    }
    return duree;
  }

  /**
   * Mixe toutes les pistes dans un seul AudioBuffer stereo.
   * pistes : tableau de { clips: [{ audioBuffer, debutDansPiste, decoupeDebut, decoupeFin, volume }] }
   */
  function mixerPistes(pistes, dureeTotale) {
    const ctx = AudioMoteur.obtenirContexte();
    const nbCanaux = 2;
    const nbEchantillons = Math.ceil(dureeTotale * FREQUENCE_EXPORT) + 1;
    const tampon = ctx.createBuffer(nbCanaux, Math.max(1, nbEchantillons), FREQUENCE_EXPORT);

    for (const piste of pistes) {
      const volumePiste = piste.muette ? 0 : (piste.volume ?? 1);
      for (const clip of piste.clips) {
        if (!clip.audioBuffer) continue;
        const decoupeDebut = clip.decoupeDebut || 0;
        const decoupeFin = clip.decoupeFin ?? clip.audioBuffer.duration;
        const dureeClip = decoupeFin - decoupeDebut;
        const offsetEchantillonsClip = Math.round(decoupeDebut * clip.audioBuffer.sampleRate);
        const nbEchantillonsAEcrire = Math.round(dureeClip * FREQUENCE_EXPORT);
        const debutEchantillonSortie = Math.round(clip.debutDansPiste * FREQUENCE_EXPORT);

        // Fondus d'entree/de sortie du clip (0 par defaut : retrocompatible
        // avec les projets sauvegardes avant l'ajout de cette fonctionnalite).
        // Le calcul de gain est partage avec la preview temps reel
        // (AudioMoteur.calculerGainFondu), pour que l'export corresponde
        // exactement a ce qui a ete entendu pendant l'edition.
        const fonduEntree = clip.fonduEntree || 0;
        const fonduSortie = clip.fonduSortie || 0;
        const aDesFondus = fonduEntree > 0 || fonduSortie > 0;

        for (let c = 0; c < nbCanaux; c++) {
          const canalSource = clip.audioBuffer.getChannelData(
            Math.min(c, clip.audioBuffer.numberOfChannels - 1)
          );
          const canalSortie = tampon.getChannelData(c);
          const rapportFrequence = clip.audioBuffer.sampleRate / FREQUENCE_EXPORT;

          for (let i = 0; i < nbEchantillonsAEcrire; i++) {
            const indexSortie = debutEchantillonSortie + i;
            if (indexSortie >= canalSortie.length) break;
            const indexSource = offsetEchantillonsClip + Math.floor(i * rapportFrequence);
            if (indexSource >= canalSource.length) continue;

            const gainFondu = aDesFondus
              ? AudioMoteur.calculerGainFondu(i / FREQUENCE_EXPORT, dureeClip, fonduEntree, fonduSortie)
              : 1;

            canalSortie[indexSortie] += canalSource[indexSource] * volumePiste * gainFondu;
          }
        }
      }
    }

    // ecretage doux (eviter la saturation si plusieurs pistes fortes se superposent)
    for (let c = 0; c < nbCanaux; c++) {
      const donnees = tampon.getChannelData(c);
      for (let i = 0; i < donnees.length; i++) {
        donnees[i] = Math.max(-1, Math.min(1, donnees[i]));
      }
    }

    return tampon;
  }

  /** Encode un AudioBuffer en mp3 (Blob) via lamejs. */
  function encoderEnMp3(audioBuffer, progressionCallback) {
    return new Promise((resolve, reject) => {
      try {
        const nbCanaux = audioBuffer.numberOfChannels >= 2 ? 2 : 1;
        const encodeur = new lamejs.Mp3Encoder(nbCanaux, audioBuffer.sampleRate, 128);
        const TAILLE_BLOC = 1152;
        const morceauxMp3 = [];

        const canalGauche = audioBuffer.getChannelData(0);
        const canalDroit = nbCanaux === 2 ? audioBuffer.getChannelData(1) : null;
        const longueur = canalGauche.length;

        function flottantVersInt16(tableau, debut, fin) {
          const sortie = new Int16Array(fin - debut);
          for (let i = debut; i < fin; i++) {
            let v = Math.max(-1, Math.min(1, tableau[i]));
            sortie[i - debut] = v < 0 ? v * 0x8000 : v * 0x7FFF;
          }
          return sortie;
        }

        let position = 0;
        function traiterBloc() {
          if (position >= longueur) {
            const dernierBloc = encodeur.flush();
            if (dernierBloc.length > 0) morceauxMp3.push(dernierBloc);
            const blob = new Blob(morceauxMp3, { type: 'audio/mp3' });
            resolve(blob);
            return;
          }

          const fin = Math.min(position + TAILLE_BLOC, longueur);
          const blocGauche = flottantVersInt16(canalGauche, position, fin);
          let mp3Buf;
          if (nbCanaux === 2) {
            const blocDroit = flottantVersInt16(canalDroit, position, fin);
            mp3Buf = encodeur.encodeBuffer(blocGauche, blocDroit);
          } else {
            mp3Buf = encodeur.encodeBuffer(blocGauche);
          }
          if (mp3Buf.length > 0) morceauxMp3.push(mp3Buf);

          position = fin;
          if (progressionCallback) progressionCallback(position / longueur);

          // on laisse la main au navigateur regulierement pour ne pas geler l'interface
          setTimeout(traiterBloc, 0);
        }

        traiterBloc();
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Fonction complete : pistes -> Blob mp3 telechargeable.
   */
  async function exporterPodcast(pistes, progressionCallback) {
    const duree = calculerDureeTotale(pistes);
    if (duree <= 0) {
      throw new Error('Le podcast est vide, il n\'y a rien à exporter.');
    }
    const mixage = mixerPistes(pistes, duree);
    const blobMp3 = await encoderEnMp3(mixage, progressionCallback);
    return blobMp3;
  }

  function telechargerBlob(blob, nomFichier) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nomFichier.replace(/[^a-z0-9_\-]+/gi, '_') + '.mp3';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { exporterPodcast, telechargerBlob, calculerDureeTotale, mixerPistes, encoderEnMp3 };
})();