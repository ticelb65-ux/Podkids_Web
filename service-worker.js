/* ===================================================================
   service-worker.js
   Deux strategies de cache differentes selon le type de fichier :

   1. "App shell" (HTML, CSS, JS de l'appli, lib/lame.min.js, icones) :
      mis en cache des l'installation du service worker. Ce sont des
      fichiers petits, l'appli doit pouvoir demarrer hors-ligne des
      la premiere visite.

   2. Tout le reste (notamment js/banque-sons-*.js, potentiellement
      plusieurs dizaines de Mo chacun) : PAS precache a l'installation
      (trop lourd, et risque sur iOS ou le stockage d'une PWA peut etre
      limite/evince). A la place, chaque fichier est mis en cache la
      premiere fois qu'il est reellement demande (donc la premiere fois
      que l'utilisateur ouvre la bibliotheque de sons correspondante),
      et sert depuis le cache toutes les fois suivantes, y compris
      hors-ligne.
   =================================================================== */

// Change ce numero de version a chaque mise a jour de l'app shell,
// pour forcer le navigateur a re-telecharger les fichiers modifies.
const VERSION = 'v1';
const CACHE_APP_SHELL = `podkids-app-shell-${VERSION}`;
const CACHE_RUNTIME = 'podkids-runtime'; // pas versionne : on ne veut pas re-telecharger les banques de sons a chaque mise a jour

const FICHIERS_APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/pistes-ui.js',
  './js/audio-moteur.js',
  './js/decoupage.js',
  './js/enregistrement.js',
  './js/export-mp3.js',
  './js/forme-onde.js',
  './js/stockage.js',
  './js/banque-sons.js',
  './lib/lame.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (evenement) => {
  evenement.waitUntil(
    caches.open(CACHE_APP_SHELL)
      .then((cache) => cache.addAll(FICHIERS_APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evenement) => {
  evenement.waitUntil(
    caches.keys().then((noms) => Promise.all(
      noms
        // on supprime les anciennes versions de l'app shell, mais JAMAIS
        // le cache runtime (qui contient les banques de sons deja telechargees)
        .filter((nom) => nom.startsWith('podkids-app-shell-') && nom !== CACHE_APP_SHELL)
        .map((nom) => caches.delete(nom))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;

  // on ne gere que les requetes GET de meme origine (pas les appels
  // eventuels vers des services externes, ni les envois de formulaire)
  if (requete.method !== 'GET' || !requete.url.startsWith(self.location.origin)) {
    return;
  }

  evenement.respondWith(
    caches.match(requete).then((reponseEnCache) => {
      if (reponseEnCache) return reponseEnCache;

      return fetch(requete).then((reponseReseau) => {
        // on ne met en cache que les reponses valides
        if (!reponseReseau || reponseReseau.status !== 200) return reponseReseau;

        const copie = reponseReseau.clone();
        caches.open(CACHE_RUNTIME).then((cache) => cache.put(requete, copie));
        return reponseReseau;
      }).catch(() => {
        // ni cache ni reseau disponibles : on ne peut rien renvoyer de mieux
        return new Response('Contenu indisponible hors-ligne pour le moment.', {
          status: 503,
          statusText: 'Hors-ligne',
        });
      });
    })
  );
});
