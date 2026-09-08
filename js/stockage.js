/* ===================================================================
   stockage.js
   Gestion de la persistance locale des projets.

   Architecture hybride localStorage + IndexedDB :
   - localStorage : métadonnées légères (noms, positions, volumes...)
   - IndexedDB    : données audio (audioBase64) — capacité illimitée

   Cela permet de sauvegarder des projets de toute taille sans jamais
   atteindre la limite du localStorage (~5-10 Mo).
   =================================================================== */

const Stockage = (() => {

  const CLE_INDEX       = 'podcast_ecole_index_projets';
  const PREFIXE_META    = 'podcast_ecole_meta_';
  const PREFIXE_PROJET  = 'podcast_ecole_projet_'; // legacy
  const DB_NOM          = 'PodkidsAudio';
  const DB_VERSION      = 1;
  const STORE_AUDIO     = 'clipAudio';

  /* ── IndexedDB ───────────────────────────────────────────────────── */

  let _db = null;

  function ouvrirDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NOM, DB_VERSION);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore(STORE_AUDIO);
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function idbSet(cle, valeur) {
    const db = await ouvrirDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIO, 'readwrite');
      tx.objectStore(STORE_AUDIO).put(valeur, cle);
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  }

  async function idbGet(cle) {
    const db = await ouvrirDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_AUDIO, 'readonly');
      const req = tx.objectStore(STORE_AUDIO).get(cle);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function idbDelete(cle) {
    const db = await ouvrirDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AUDIO, 'readwrite');
      tx.objectStore(STORE_AUDIO).delete(cle);
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  }

  async function idbDeletePrefix(prefixe) {
    const db = await ouvrirDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(STORE_AUDIO, 'readwrite');
      const store = tx.objectStore(STORE_AUDIO);
      const req   = store.openCursor();
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) {
          if (String(cursor.key).startsWith(prefixe)) cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  }

  /* ── Utilitaires ─────────────────────────────────────────────────── */

  function genererIdentifiant() {
    return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function listerProjetsRecents() {
    try {
      const brut = localStorage.getItem(CLE_INDEX);
      if (!brut) return [];
      const liste = JSON.parse(brut);
      return Array.isArray(liste) ? liste : [];
    } catch (e) {
      return [];
    }
  }

  function mettreAJourIndex(id, nom) {
    const liste = listerProjetsRecents().filter(p => p.id !== id);
    liste.unshift({ id, nom, modifieLe: new Date().toISOString() });
    localStorage.setItem(CLE_INDEX, JSON.stringify(liste.slice(0, 12)));
  }

  function retirerDeIndex(id) {
    const liste = listerProjetsRecents().filter(p => p.id !== id);
    localStorage.setItem(CLE_INDEX, JSON.stringify(liste));
  }

  /* ── Sérialisation : séparer méta et audio ───────────────────────── */

  /**
   * Prend un projet complet et retourne { meta, audioMap }.
   * meta    : projet sans les audioBase64 (stocké dans localStorage)
   * audioMap: { clipKey -> audioBase64 } (stocké dans IndexedDB)
   */
  function decomposerProjet(projet) {
    const audioMap = {};
    const meta = {
      ...projet,
      pistes: projet.pistes.map((piste, ip) => ({
        ...piste,
        clips: piste.clips.map((clip, ic) => {
          const cle = `${projet.id}_p${ip}_c${ic}`;
          if (clip.audioBase64) audioMap[cle] = clip.audioBase64;
          return { ...clip, audioBase64: null, _audioCle: cle };
        }),
      })),
      sonsPersonnels: (projet.sonsPersonnels || []).map((son, i) => {
        const cle = `${projet.id}_son_${i}`;
        if (son.base64) audioMap[cle] = son.base64;
        return { ...son, base64: null, _audioCle: cle };
      }),
    };
    return { meta, audioMap };
  }

  /**
   * Recompose un projet à partir de meta (localStorage) + audio (IndexedDB).
   */
  async function recomposerProjet(meta) {
    const projet = {
      ...meta,
      pistes: await Promise.all(meta.pistes.map(async piste => ({
        ...piste,
        clips: await Promise.all(piste.clips.map(async clip => {
          let audioBase64 = null;
          if (clip._audioCle) {
            audioBase64 = await idbGet(clip._audioCle).catch(() => null);
          }
          const { _audioCle, ...reste } = clip;
          return { ...reste, audioBase64 };
        })),
      }))),
      sonsPersonnels: await Promise.all((meta.sonsPersonnels || []).map(async son => {
        let base64 = null;
        if (son._audioCle) {
          base64 = await idbGet(son._audioCle).catch(() => null);
        }
        const { _audioCle, ...reste } = son;
        return { ...reste, base64 };
      })),
    };
    return projet;
  }

  /* ── API publique ────────────────────────────────────────────────── */

  async function sauvegarderProjet(projet) {
    if (!projet.id) projet.id = genererIdentifiant();
    try {
      const { meta, audioMap } = decomposerProjet(projet);
      // Stocker l'audio dans IndexedDB
      await Promise.all(Object.entries(audioMap).map(([cle, val]) => idbSet(cle, val)));
      // Stocker les méta dans localStorage (léger)
      localStorage.setItem(PREFIXE_META + projet.id, JSON.stringify(meta));
      mettreAJourIndex(projet.id, projet.nom || 'Podcast sans titre');
      return true;
    } catch (e) {
      console.error('Erreur sauvegarde', e);
      return false;
    }
  }

  async function chargerProjet(id) {
    try {
      // Essayer d'abord le nouveau format (méta séparée)
      const brut = localStorage.getItem(PREFIXE_META + id)
                || localStorage.getItem(PREFIXE_PROJET + id); // compat legacy
      if (!brut) return null;
      const meta = JSON.parse(brut);
      // Si le projet est au nouveau format (clips avec _audioCle), recomposer
      const besoinRecomposition = meta.pistes?.some(p =>
        p.clips?.some(c => '_audioCle' in c));
      if (besoinRecomposition) return recomposerProjet(meta);
      return meta; // ancien format : audio inline
    } catch (e) {
      console.error('Erreur chargement projet', e);
      return null;
    }
  }

  async function supprimerProjet(id) {
    localStorage.removeItem(PREFIXE_META + id);
    localStorage.removeItem(PREFIXE_PROJET + id); // compat
    await idbDeletePrefix(id + '_').catch(() => {});
    retirerDeIndex(id);
  }

  /* ── Export / import fichier .podcast ────────────────────────────── */

  function telechargerFichierProjet(projet) {
    const contenu = JSON.stringify(projet);
    const blob    = new Blob([contenu], { type: 'application/json' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    const nom     = (projet.nom || 'mon-podcast').replace(/[^a-z0-9_\-]+/gi, '_');
    a.href = url; a.download = nom + '.podcast';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function lireFichierProjet(fichier) {
    return new Promise((resolve, reject) => {
      const lecteur = new FileReader();
      lecteur.onload = () => {
        try {
          const projet = JSON.parse(lecteur.result);
          projet.id = genererIdentifiant();
          resolve(projet);
        } catch (e) {
          reject(new Error('Ce fichier ne semble pas être un fichier .podcast valide.'));
        }
      };
      lecteur.onerror = () => reject(new Error('Impossible de lire ce fichier.'));
      lecteur.readAsText(fichier);
    });
  }

  return {
    genererIdentifiant,
    listerProjetsRecents,
    sauvegarderProjet,
    chargerProjet,
    supprimerProjet,
    telechargerFichierProjet,
    lireFichierProjet,
  };
})();
